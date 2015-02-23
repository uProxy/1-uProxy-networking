/// <reference path='../../arraybuffers/arraybuffers.d.ts' />
/// <reference path='../../freedom/typings/freedom.d.ts' />
/// <reference path='../../third_party/typings/jasmine/jasmine.d.ts' />
/// <reference path="../../socks-common/socks-headers.d.ts" />

// Integration test for the whole proxying system.
// The real work is done in the Freedom module which performs each test.
describe('slow proxy integration tests', function() {
  var getTestModule = function(denyLocalhost?:boolean) : any {
    return freedom('scripts/build/integration/socks-echo/integration.json',
            { 'debug': 'log' })
        .then((interface:any) => {
          return interface(denyLocalhost);
        });
  };

  // The default TCP SYN timeout is two minutes, so to be safe we
  // set a test timeout of four minutes.
  (<any>jasmine).DEFAULT_TIMEOUT_INTERVAL = 240000;

  it('download load test', (done) => {
    var blockSize = 1024;
    var testBlock :ArrayBuffer = new ArrayBuffer(blockSize);
    var repeat :number = 250;
    getTestModule().then((testModule:any) => {
      testModule.setRepeat(repeat);
      testModule.startEchoServer().then((port:number) => {
        var connectionPromises :Promise<string>[] = [];
        for (var i = 0; i < 200; ++i) {
          connectionPromises.push(testModule.connect(port));
        }
        return Promise.all(connectionPromises);
      }).then((connectionIds:string[]) => {
        var completions = connectionIds.map((connectionId:string) : Promise<void> => {
          var resolve :Function;
          var result :Promise<void> = new Promise<void>((F, R) => { resolve = F; });
          var isDone = false;
          var outputString = '';
          testModule.on('pong', (pong:any) => {
            if (pong.connectionId != connectionId) {
              return;
            }
            expect(isDone).toBe(false);
            outputString += ArrayBuffers.arrayBufferToString(pong.response);
            if (outputString.length == repeat * blockSize) {
              isDone = true;
              resolve();
            }
          });
          return testModule.ping(connectionId, testBlock).then(() => {
            return result;
          });
        });
        Promise.all(completions).then(done);
      });
    });
  });

  it('upload load test', (done) => {
    var size = 250 * 1024;
    var testBlock :ArrayBuffer = new ArrayBuffer(size);
    getTestModule().then((testModule:any) => {
      testModule.setRepeat(0);  // Don't send a reply at all.
      testModule.startEchoServer().then((port:number) => {
        var connectionPromises :Promise<string>[] = [];
        for (var i = 0; i < 200; ++i) {
          connectionPromises.push(testModule.connect(port));
        }
        return Promise.all(connectionPromises);
      }).then((connectionIds:string[]) : Promise<void>[] => {
        return connectionIds.map((connectionId:string) : Promise<void> => {
          return testModule.ping(connectionId, testBlock);
        });
      }).then((pingResults:Promise<void>[]) : Promise<[any]> => {
        return Promise.all(pingResults);
      }).catch((e:any) => {
        expect(e).toBeUndefined();
      }).then(done);
    });
  });

  xit('100 MB echo load test', (done) => {
    var size = 100 * 1024 * 1024;  // Larger than the 16 MB internal buffer in Chrome.
    var input = new ArrayBuffer(size);
    getTestModule().then((testModule:any) => {
      return testModule.startEchoServer().then((port:number) => {
        return testModule.connect(port);
      }).then((connectionId:string) => {
        return testModule.echo(connectionId, input);
      });
    }).then((output:ArrayBuffer) => {
      expect(ArrayBuffers.byteEquality(input, output)).toBe(true);
    }).catch((e:any) => {
      expect(e).toBeUndefined();
    }).then(done);
  });

  xit('attempt to connect to a nonexistent IP address', (done) => {
    getTestModule().then((testModule:any) => {
      // 192.0.2.0/24 is a reserved IP address range.
      return testModule.connect(80, '192.0.2.111');
    }).then((connectionId:string) => {
      // This code should not run, because this is a reserved IP address.
      expect(connectionId).toBeUndefined();
    }).catch((e:any) => {
      // The socket should time out after two minutes.
      expect(e.reply).toEqual(Socks.Reply.TTL_EXPIRED);
    }).then(done);
  });
});
