// SocksToRtc.Peer passes socks requests over WebRTC datachannels.

/// <reference path='../socks-common/socks-headers.d.ts' />
/// <reference path='../logging/logging.d.ts' />
/// <reference path='../freedom/typings/freedom.d.ts' />
/// <reference path='../handler/queue.d.ts' />
/// <reference path='../networking-typings/communications.d.ts' />
/// <reference path="../churn/churn.d.ts" />
/// <reference path='../webrtc/datachannel.d.ts' />
/// <reference path='../webrtc/peerconnection.d.ts' />
/// <reference path='../tcp/tcp.d.ts' />
/// <reference path='../third_party/typings/es6-promise/es6-promise.d.ts' />

module SocksToRtc {
  var log :Logging.Log = new Logging.Log('SocksToRtc');

  var tagNumber_ = 0;
  function obtainTag() {
    return 'c' + (tagNumber_++);
  }

  // The |SocksToRtc| class runs a SOCKS5 proxy server which passes requests
  // remotely through WebRTC peer connections.
  // TODO: rename this 'Server'.
  // TODO: Extract common code for this and SocksToRtc:
  //         https://github.com/uProxy/uproxy/issues/977
  export class SocksToRtc {

    // Call this to initiate shutdown.
    private fulfillStopping_ :() => void;
    private onceStopping_ = new Promise((F, R) => {
      this.fulfillStopping_ = F;
    });

    // Fulfills once the SOCKS server has terminated and the TCP server
    // and peerconnection have been shutdown.
    // This can happen in response to:
    //  - startup failure
    //  - TCP server or peerconnection failure
    //  - manual invocation of stop()
    // Should never reject.
    private onceStopped_ :Promise<void>;

    // The two Queues below only count bytes transferred between the SOCKS
    // client and the remote host(s) the client wants to connect to. WebRTC
    // overhead (DTLS headers, ICE initiation, etc.) is not included (because
    // WebRTC does not provide easy access to that data) nor is SOCKS
    // protocol-related data (because it's sent via string messages).
    // All Sessions created in one instance of SocksToRtc will share and
    // push numbers to the same queues (belonging to that instance of SocksToRtc).
    // Queue of the number of bytes received from the peer. Handler is typically
    // defined in the class that creates an instance of SocksToRtc.
    private bytesReceivedFromPeer_ :Handler.Queue<number, void> =
        new Handler.Queue<number, void>();

    // Queue of the number of bytes sent to the peer. Handler is typically
    // defined in the class that creates an instance of SocktsToRtc.
    private bytesSentToPeer_ :Handler.Queue<number,void> =
        new Handler.Queue<number, void>();

    // Tcp server that is listening for SOCKS connections.
    private tcpServer_       :Tcp.Server;

    // The connection to the peer that is acting as the endpoint for the proxy
    // connection.
    private peerConnection_  :WebRtc.PeerConnection;

    // Event listener registration function.  When running in freedom, this is
    // not defined, and the corresponding functionality is inserted by freedom
    // on the consumer side.
    public on : (t:string, f:(m:any) => void) => void;
    // Database of event listeners for fallback implementation of |on|.
    private listeners_ : { [s:string]: (m:any) => void };
    // CONSIDER: Remove |on| and |listeners_| once all users of this class use
    // it via freedom, or determine a better long-term plan for supporting
    // events compatibly with and without freedom
    // (https://github.com/uProxy/uproxy/issues/733).

    // From WebRTC data-channel labels to their TCP connections. Most of the
    // wiring to manage this relationship happens via promises of the
    // TcpConnection. We need this only for data being received from a peer-
    // connection data channel get raised with data channel label.  TODO:
    // https://github.com/uProxy/uproxy/issues/315 when closed allows
    // DataChannel and PeerConnection to be used directly and not via a freedom
    // interface. Then all work can be done by promise binding and this can be
    // removed.
    private sessions_ :{ [channelLabel:string] : Session } = {};

    constructor(private dispatchEvent_?:(t:string, m:any) => void) {
      if (!this.dispatchEvent_) {
        // CONSIDER: Remove this code once all users of this class move to
        // freedom.  See https://github.com/uProxy/uproxy/issues/733 for
        // possible solutions.
        this.listeners_ = {};
        this.on = this.fallbackOn_;
        this.dispatchEvent_ = this.fallbackDispatchEvent_;
      }
    }

    // Handles creation of a TCP server and peerconnection.
    // NOTE: Users of this class MUST add on-event listeners before calling this
    // method.
    public start = (
        endpoint:Net.Endpoint,
        pcConfig:freedom_RTCPeerConnection.RTCConfiguration,
        obfuscate?:boolean) : Promise<Net.Endpoint> => {
      var pc :freedom_RTCPeerConnection.RTCPeerConnection =
          freedom['core.rtcpeerconnection'](pcConfig);
      return this.startInternal(
          new Tcp.Server(endpoint),
          obfuscate ?
              new Churn.Connection(pc) :
              WebRtc.PeerConnection.fromRtcPeerConnection(pc));
    }

    // Starts the SOCKS server with the supplied TCP server and peerconnection.
    // Returns a promise that resolves when the server is ready to use.
    // This method is public only for testing purposes.
    public startInternal = (
        tcpServer:Tcp.Server,
        peerconnection:WebRtc.PeerConnectionInterface<WebRtc.SignallingMessage>)
        : Promise<Net.Endpoint> => {
      if (this.tcpServer_) {
        throw new Error('already configured');
      }
      this.tcpServer_ = tcpServer;
      this.tcpServer_.connectionsQueue
          .setSyncHandler(this.makeTcpToRtcSession_);
      this.peerConnection_ = peerconnection;

      this.peerConnection_.signalForPeerQueue.setSyncHandler(
          this.dispatchEvent_.bind(this, 'signalForPeer'));

      this.bytesSentToPeer_.setSyncHandler(
          this.dispatchEvent_.bind(this, 'bytesSentToPeer'));
      this.bytesReceivedFromPeer_.setSyncHandler(
          this.dispatchEvent_.bind(this, 'bytesReceivedFromPeer'));

      // Start and listen for notifications.
      peerconnection.negotiateConnection();
      var onceReady :Promise<Net.Endpoint> =
        Promise.all<any>([
          tcpServer.listen(),
          peerconnection.onceConnected
        ])
        .then((answers:any[]) => {
          return tcpServer.onceListening();
        });

      // Shutdown if startup fails or when the server socket or
      // peerconnection terminates.
      onceReady.catch(this.fulfillStopping_);
      this.tcpServer_.onceShutdown()
        .then(() => {
          log.info('server socket closed');
        }, (e:Error) => {
          log.error('server socket closed with error: %1', [e.message]);
        })
        .then(this.fulfillStopping_);
      this.peerConnection_.onceDisconnected
        .then(() => {
          log.info('peerconnection terminated');
        }, (e:Error) => {
          log.error('peerconnection terminated with error: %1', [e.message]);
        })
        .then(this.fulfillStopping_);
      this.onceStopped_ = this.onceStopping_.then(this.stopResources_);
      this.onceStopped_.then(this.dispatchEvent_.bind(this, 'stopped'));

      var rejectOnStopping = new Promise((F, R) => {
        this.onceStopping_.then(R);
      });
      return Promise.race([onceReady, rejectOnStopping]);
    }

    // Initiates shutdown of the TCP server and peerconnection.
    // Returns onceStopped.
    public stop = () : Promise<void> => {
      log.info('stop requested');
      this.fulfillStopping_();
      return this.onceStopped_;
    }

    // An implementation of dispatchEvent to use if none has been provided
    // (i.e. when this class is not being used as a freedom    // module).
    // For simplicity, only one listener per message type is supported.
    private fallbackDispatchEvent_ = (t:string, msg:any) : void => {
      var listener = this.listeners_[t];
      if (listener) {
        listener(msg);
      }
    }

    // Fallback implementation of |on|.
    private fallbackOn_ = (t:string, f:(m:any) => void) : void => {
      this.listeners_[t] = f;
    }

    // Shuts down the TCP server and peerconnection if they haven't already
    // shut down, fulfilling once both have terminated. Since neither
    // object's close() methods should ever reject, this should never reject.
    // TODO: close all sessions before fulfilling
    private stopResources_ = () : Promise<void> => {
      log.debug('freeing resources');
      // PeerConnection.close() returns void, implying that the shutdown is
      // effectively immediate.  However, we wrap it in a promise to ensure
      // that any exception is sent to the Promise.catch, rather than
      // propagating synchronously up the stack.
      return Promise.all(<Promise<any>[]>[
        new Promise((F, R) => { this.peerConnection_.close(); F(); }),
        this.tcpServer_.shutdown()
      ]).then((discard:any) => {});
    }

    // Invoked when a SOCKS client establishes a connection with the TCP server.
    // Note that Session closes the TCP connection and datachannel on any error.
    private makeTcpToRtcSession_ = (tcpConnection:Tcp.Connection) : void => {
      var tag = obtainTag();
      log.info('associating session %1 with new TCP connection', [tag]);

	    this.peerConnection_.openDataChannel(tag).then((channel:WebRtc.DataChannel) => {
        log.info('opened datachannel for session %1', [tag]);
        var session = new Session();
        session.start(
            tcpConnection,
            channel,
            this.bytesSentToPeer_,
            this.bytesReceivedFromPeer_)
        .then((endpoint:Net.Endpoint) => {
          this.sessions_[tag] = session;
        }, (e:Error) => {
          log.warn('session %1 failed to connect to remote endpoint: %2', [
              tag, e.message]);
        });

        var discard = () => {
          delete this.sessions_[tag];
          log.info('discarded session %1 (%2 remaining)', [
              tag, Object.keys(this.sessions_).length]);
        };
        session.onceStopped.then(discard, (e:Error) => {
          log.error('session %1 terminated with error: %2', [
              tag, e.message]);
          discard();
        });
      }, (e:Error) => {
        log.error('failed to open datachannel for session %1: %2 ', [tag, e.message]);
      });
    }

    public handleSignalFromPeer = (signal:WebRtc.SignallingMessage)
        : void => {
      this.peerConnection_.handleSignalMessage(signal);
    }

    public toString = () : string => {
      var ret :string;
      var sessionsAsStrings :string[] = [];
      var label :string;
      for (label in this.sessions_) {
        sessionsAsStrings.push(this.sessions_[label].toString());
      }
      ret = JSON.stringify({ tcpServer_: this.tcpServer_.toString(),
                             sessions_: sessionsAsStrings });
      return ret;
    }
  }  // class SocksToRtc


  // A Socks sesson links a Tcp connection to a particular data channel on the
  // peer connection. CONSIDER: when we have a lightweight webrtc provider, we
  // can use the DataChannel class directly here instead of the awkward pairing
  // of peerConnection with chanelLabel.
  export class Session {
    private tcpConnection_ :Tcp.Connection;
    private dataChannel_ :WebRtc.DataChannel;
    private bytesSentToPeer_ :Handler.Queue<number,void>;
    private bytesReceivedFromPeer_ :Handler.Queue<number,void>;

    // Fulfills with the bound endpoint which RtcToNet is using to connect to the
    // remote host. Rejects if RtcToNet could not connect to the remote host
    // or if there is some error negotiating the SOCKS session.
    public onceReady :Promise<Net.Endpoint>;

    // Call this to initiate shutdown.
    private fulfillStopping_ :() => void;
    private onceStopping_ = new Promise((F, R) => {
      this.fulfillStopping_ = F;
    });

    // Fulfills once the SOCKS session has terminated and the TCP connection
    // and datachannel have been shutdown.
    // This can happen in response to:
    //  - startup (negotiation) failure
    //  - TCP connection or datachannel termination
    //  - manual invocation of stop()
    // Should never reject.
    public onceStopped :Promise<void>;

    // The supplied TCP connection and datachannel must already be
    // successfully established.
    // Returns onceReady.
    public start = (
        tcpConnection:Tcp.Connection,
        dataChannel:WebRtc.DataChannel,
        bytesSentToPeer:Handler.Queue<number,void>,
        bytesReceivedFromPeer:Handler.Queue<number,void>)
        : Promise<Net.Endpoint> => {
      this.tcpConnection_ = tcpConnection;
      this.dataChannel_ = dataChannel;
      this.bytesSentToPeer_ = bytesSentToPeer;
      this.bytesReceivedFromPeer_ = bytesReceivedFromPeer;

      // Startup notifications.
      this.onceReady = this.doAuthHandshake_().then(this.doRequestHandshake_);
      this.onceReady.then(this.linkSocketAndChannel_);

      // Shutdown once TCP connection or datachannel terminate.
      this.onceReady.catch(this.fulfillStopping_);
      Promise.race<any>([
          tcpConnection.onceClosed.then((kind:Tcp.SocketCloseKind) => {
            log.info('%1: socket closed (%2)', [
                this.longId(),
                Tcp.SocketCloseKind[kind]]);
          }),
          dataChannel.onceClosed.then(() => {
            log.info('%1: datachannel closed', [this.longId()]);
          })])
        .then(this.fulfillStopping_);
      this.onceStopped = this.onceStopping_.then(this.stopResources_);

      return this.onceReady;
    }

    public longId = () : string => {
      return 'session ' + this.channelLabel() + ' (TCP '
          + (this.tcpConnection_.isClosed() ? 'closed' : 'open') + ')';
    }

    // Initiates shutdown of the TCP server and peerconnection.
    // Returns onceStopped.
    public stop = () : Promise<void> => {
      log.debug('%1: stop requested', [this.longId()]);
      this.fulfillStopping_();
      return this.onceStopped;
    }

    // Closes the TCP connection and datachannel if they haven't already
    // closed, fulfilling once both have closed. Since neither object's
    // close() methods should ever reject, this should never reject.
    private stopResources_ = () : Promise<void> => {
      log.debug('%1: freeing resources', [this.longId()]);
      // DataChannel.close() returns void, implying that it is
      // effectively immediate.  However, we wrap it in a promise to ensure
      // that any exception is sent to the Promise.catch, rather than
      // propagating synchronously up the stack.
      return Promise.all(<Promise<any>[]>[
        new Promise((F, R) => { this.dataChannel_.close(); F(); }),
        this.tcpConnection_.close()
      ]).then((discard:any) => {});
    }

    public channelLabel = () : string => {
      return this.dataChannel_.getLabel();
    }

    public toString = () : string => {
      return JSON.stringify({
        channelLabel_: this.channelLabel(),
        tcpConnection: this.tcpConnection_.toString()
      });
    }

    // Receive a socks connection and send the initial Auth messages.
    // Assumes: no packet fragmentation.
    // TODO: handle packet fragmentation:
    //   https://github.com/uProxy/uproxy/issues/323
    // TODO: Needs unit tests badly since it's mocked by several other tests.
    private doAuthHandshake_ = ()
        : Promise<void> => {
      return this.tcpConnection_.receiveNext()
        .then(Socks.interpretAuthHandshakeBuffer)
        .then((auths:Socks.Auth[]) => {
          this.tcpConnection_.send(
              Socks.composeAuthResponse(Socks.Auth.NOAUTH));
        });
    }

    // Sets the next data hanlder to get next data from peer, assuming it's
    // stringified version of the destination.
    // TODO: Needs unit tests badly since it's mocked by several other tests.
    private receiveResponseFromPeer_ = () : Promise<Socks.Response> => {
      return new Promise((F,R) => {
        this.dataChannel_.dataFromPeerQueue.setSyncNextHandler((data:WebRtc.Data) => {
          if (!data.str) {
            R(new Error('received non-string data during handshake: ' +
                JSON.stringify(data)));
            return;
          }
          try {
            var r :any = JSON.parse(data.str);
            if (!Socks.isValidResponse(r)) {
              R(new Error('invalid response:' + data.str));
              return;
            }
            log.info('%1: connected to remote host', [this.longId()]);
            log.debug('%1: remote peer bound address: %2', [
                this.longId(), JSON.stringify(r.endpoint)]);
            F(r);
          } catch(e) {
            R(new Error('received malformed response during handshake: ' +
                data.str));
          }
        });
      });
    }

    // Assumes that |doAuthHandshake_| has completed and that a peer-conneciton
    // has been established. Promise returns the bound address used to connect.
    private doRequestHandshake_ = ()
        : Promise<Net.Endpoint> => {
      return this.tcpConnection_.receiveNext()
        .then(Socks.interpretRequestBuffer)
        .then((request:Socks.Request) => {
          log.info('%1: received endpoint from SOCKS client: %2', [
              this.longId(), JSON.stringify(request.endpoint)]);
          this.dataChannel_.send({ str: JSON.stringify(request) });
          return this.receiveResponseFromPeer_();
        })
        .then((response:Socks.Response) => {
          // TODO: test and close: https://github.com/uProxy/uproxy/issues/324
          this.tcpConnection_.send(Socks.composeResponseBuffer(response));
          if (response.reply != Socks.Reply.SUCCEEDED) {
            this.stop();
          }
          return response.endpoint;
        });
    }

    // Sends a packet over the data channel.
    // Invoked when a packet is received over the TCP socket.
    private sendOnChannel_ = (data:ArrayBuffer) : void => {
      log.debug('%1: socket received %2 bytes', [
          this.longId(),
          data.byteLength]);
      this.dataChannel_.send({buffer: data}).catch((e:Error) => {
        log.error('%1: failed to send data on datachannel: %2', [
            this.longId(),
            e.message]);
      });
    }

    // Sends a packet over the TCP socket.
    // Invoked when a packet is received over the data channel.
    private sendOnSocket_ = (data:WebRtc.Data) : void => {
      if (!data.buffer) {
        log.error('%1: received non-buffer data from datachannel', [
            this.longId()]);
        return;
      }
      log.debug('%1: datachannel received %2 bytes', [
          this.longId(),
          data.buffer.byteLength]);
      this.bytesReceivedFromPeer_.handle(data.buffer.byteLength);
      this.tcpConnection_.send(data.buffer).catch((e:any) => {
        // TODO: e is actually a freedom.Error (uproxy-lib 20+)
        // errcode values are defined here:
        //   https://github.com/freedomjs/freedom/blob/master/interface/core.tcpsocket.json
        if (e.errcode === 'NOT_CONNECTED') {
          // This can happen if, for example, there was still data to be
          // read on the datachannel's queue when the socket closed.
          log.warn('%1: tried to send data on closed socket: %2', [
              this.longId(),
              e.errcode]);
        } else {
          log.error('%1: failed to send data on socket: %2', [
              this.longId(),
              e.errcode]);
        }
      });
    }

    // Configures forwarding of data from the TCP socket over the data channel
    // and vice versa. Should only be called once both socket and channel have
    // been successfully established and the handshake has completed.
    private linkSocketAndChannel_ = () : void => {
      // Note that setTimeout is used by both handlers to preserve
      // responsiveness when large amounts of data are being received:
      //   https://github.com/uProxy/uproxy/issues/967
      var socketReadLoop = (data:ArrayBuffer) => {
        this.sendOnChannel_(data);
        Session.nextTick_(() => {
          this.tcpConnection_.dataFromSocketQueue.setSyncNextHandler(
              socketReadLoop);
        });
      }
      this.tcpConnection_.dataFromSocketQueue.setSyncNextHandler(
          socketReadLoop);

      var channelReadLoop = (data:WebRtc.Data) : void => {
        this.sendOnSocket_(data);
        Session.nextTick_(() => {
          this.dataChannel_.dataFromPeerQueue.setSyncNextHandler(
              channelReadLoop);
        });
      };
      this.dataChannel_.dataFromPeerQueue.setSyncNextHandler(
          channelReadLoop);
    }

    // Runs callback once the current event loop has run to completion.
    // Uses setTimeout in lieu of something like Node's process.nextTick:
    //   https://github.com/uProxy/uproxy/issues/967
    private static nextTick_ = (callback:Function) : void => {
      setTimeout(callback, 0);
    }
  }  // Session

}  // module SocksToRtc
