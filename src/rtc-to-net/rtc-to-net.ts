/*
  Server which handles socks connections over WebRTC datachannels.
*/
/// <reference path='netclient.ts' />
/// <reference path='../interfaces/peerconnection.d.ts' />
/// <reference path='../interfaces/communications.d.ts' />

declare var freedom:any;
console.log('WEBWORKER - RtcToNet: ' + self.location.href);

module RtcToNet {

  var fCore = freedom.core();

  /**
   * RtcToNet.Peer - serves net requests from WebRTC peer connections.
   */
  export class Peer {

    private signallingChannel:any = null;
    private sctpPc:PeerConnection;
    private netClients:{[channelLabel:string]:Net.Client} = {};

    // Static initialiser which returns a promise to create a new Peer
    // instance complete with a signalling channel for NAT piercing.
    static CreateWithChannel = (peerId:string) : Promise<Peer> => {
      return fCore.createChannel().then((channel) => {
        return new Peer(peerId, channel);
      });
    }

    constructor (public peerId:string, channel) {
      dbg('created new peer: ' + peerId);
      // peerconnection's data channels biject ot Net.Clients.
      this.sctpPc = freedom['core.peerconnection']();
      this.sctpPc.on('onReceived', this.passPeerDataToNet_);
      this.sctpPc.on('onCloseDataChannel', this.closeNetClient_);
      var stunServers = [];  // TODO: use real stun servers
      this.sctpPc.setup(channel.identifier, 'RtcToNet-' + peerId, []);
      this.signallingChannel = channel.channel;
      this.signallingChannel.on('message', (msg) => {
        freedom.emit('sendSignalToPeer', {
            peerId: peerId,
            data: msg
        });
      });
      dbg('signalling channel to SCTP peer connection ready.');
    }

    /**
     * Send data over the peer's signalling channel, or queue if not ready.
     */
    // TODO(yagoon): rename this handleSignal()
    public sendSignal = (data:string) => {
      if (!this.signallingChannel) {
        dbgErr('signalling channel missing!');
        return;
      }
      this.signallingChannel.emit('message', data);
    }

    /**
     * Close PeerConnection and all TCP sockets.
     */
    public close = () => {
      for (var i in this.netClients) {
        this.netClients[i].close();  // Will close its data channel.
      }
        this.sctpPc.close();
    }

    /**
     * Pass messages from peer connection to net.
     */
    private passPeerDataToNet_ = (message:Channel.Message) => {
      // TODO: This handler is also O(n) for ALL the data channels. Super
      // terrible. Maybe it's fixed after freedom 0.2?
      var label = message.channelLabel;
      if (!label) {
        dbgErr('Message received but missing channelLabel. Msg: ' +
                      JSON.stringify(message));
        return;
      }
      if (message.text) {
        if ('SOCKS-DISCONNECTED' == message.text) {
          // TODO: this is a temporary 'disconnect' signal.
          dbg(label + ' <--- received SOCKS-DISCONNECTED');
          this.closeDataChannel_(label);
          return;
        }
        dbg('encountered new datachannel ' + label);
        var dest:Net.Destination = JSON.parse(message.text);
        // Text from the peer indicates request for a new destination.
        // Assumes |message.text| is a Net.Destination.
        dbg(label + ' <--- new request: ' + message.text);
        if (label in this.netClients) {
          // TODO: This shouldn't be fired! This is bad!
          dbgWarn('Net.Client already exists for data channel: ' + label);
          return;
        }
        this.prepareNetChannelLifecycle_(label, dest);

      } else if (message.buffer) {
        dbg(label + ' <--- received ' + JSON.stringify(message));
        if(!(label in this.netClients)) {
          dbgErr('[RtcToNet] non-existent channel! Msg: ' +
              JSON.stringify(message));
          return;
        }
        // Buffer from the peer is data for the destination.
        this.netClients[label].send(message.buffer);
      } else {
        dbgErr('Message received but missing valid data field. Msg: ' +
            JSON.stringify(message));
      }
    }

    private createDataChannel_ = (label:string) : Promise<void> => {
      return this.sctpPc.openDataChannel(label);
    }

    /**
     * Return data from Net to Peer.
     */
    private serveDataToPeer_ = (channelLabel:string, data:ArrayBuffer) => {
      // TODO: peer connection is firing a response for *every* channelLabel.
      // This needs to be fixed.
      dbg('reply ' + data.byteLength + ' bytes ---> ' + channelLabel);
      this.sctpPc.send({
          'channelLabel': channelLabel,
          'buffer': data
      });
    }

    /**
     * Tie a Net.Client for Destination |dest| to data-channel |label|.
     */
    private prepareNetChannelLifecycle_ =
        (label:string, dest:Net.Destination) => {
      var netClient = this.netClients[label] = new Net.Client(
          (data) => { this.serveDataToPeer_(label, data); },  // onResponse
          dest);
      // Send NetClient remote disconnections back to SOCKS peer, then shut the
      // data channel locally.
      netClient.onceDisconnected().then(() => {
        this.sctpPc.send({
          channelLabel: label,
          text: 'NET-DISCONNECTED'
        });
        dbg('send NET-DISCONNECTED ---> ' + label);
        this.closeDataChannel_(label);
      });
    }

    /**
     * Close an individual Net.Client when its data channel closes.
     */
    private closeNetClient_ = (channelData:Channel.CloseData) => {
      var channelId = channelData.channelId;
      if (!(channelId in this.netClients)) {
        dbgWarn('no Net.Client to close for ' + channelId)
        return;
      }
      dbg('closing Net.Client for closed datachannel ' + channelId);
      this.netClients[channelId].close();
      delete this.netClients[channelId];
    }

    /**
     * Close an individual data channel when its Net.Client closes.
     *
     * Data channels are created automatically in Peer Connection when a new
     * label is encountered, but must be explicitly closed here.
     * TODO: Re-use data channels from a pool.
     */
    private closeDataChannel_ = (channelLabel:string) => {
      this.sctpPc.closeDataChannel(channelLabel);
    }

  }  // class RtcToNet.Peer


  /**
   * RtcToNet.Server - signals and serves peers.
   */
  export class Server {

    // Mapping from peerIds to Peer-creation promises.
    // Store promises because creating Peer objects is an asynchronous process.
    private peers_:{[peerId:string]:Promise<Peer>} = {};

    /**
     * Send PeerSignal over peer's signallin chanel.
     */
    public handleSignal = (signal:PeerSignal) => {
      if (!signal.peerId) {
        dbgErr('signal received with no peerId!');
        return;
      }
      // TODO: Check for access control?
      // dbg('sending signal to transport: ' + JSON.stringify(signal.data));
      this.fetchOrCreatePeer_(signal.peerId).then((peer) => {
        peer.sendSignal(signal.data);
      });
    }

    /**
     * Obtain, and possibly create, a RtcToNet.Peer for |peerId|.
     */
    private fetchOrCreatePeer_(peerId:string) : Promise<Peer>{
      if (peerId in this.peers_) {
        return this.peers_[peerId];
      }
      var peer = RtcToNet.Peer.CreateWithChannel(peerId);
      this.peers_[peerId] = peer;
      return peer;
    }

    /**
     * Close all peers on this server.
     */
    public reset = () => {
      for (var contact in this.peers_) {
        this.peers_[contact].then((peer) => {
          peer.close();
        });
        delete this.peers_[contact];
      }
      this.peers_ = {};
    }

  }  // class RtcToNet.Server

  var modulePrefix_ = '[RtcToNet] ';
  function dbg(msg:string) { console.log(modulePrefix_ + msg); }
  function dbgWarn(msg:string) { console.warn(modulePrefix_ + msg); }
  function dbgErr(msg:string) { console.error(modulePrefix_ + msg); }

}  // module RtcToNet


function initServer() {
  var server = new RtcToNet.Server();
  freedom.on('start', () => {
    console.log('Starting server.');
    server.reset();  // Fresh start!
  });
  freedom.on('handleSignalFromPeer', server.handleSignal);
  freedom.on('stop', server.reset);
  freedom.emit('ready', {});
  console.log('socks-rtc Server initialized.');
}

initServer();
