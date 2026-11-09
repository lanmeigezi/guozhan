// transport.js — the transport contract.
// Concrete implementations: Loopback (in-memory, for tests) and the Android
// Bluetooth bridge (subclassed in the app's JS bridge layer).
//
// A transport carries opaque bytes between a host and one guest, and between a
// client and the host. It exposes two assignable callbacks:
//   transport.onMessage(bytes)   invoked when a chunk of bytes arrives
//   transport.onDisconnect()     invoked when the link closes
// and two methods:
//   transport.send(bytes)        write a chunk of bytes (Uint8Array)
//   transport.close()            close the link

export class Transport {
  constructor() {
    this.onMessage = null;
    this.onDisconnect = null;
  }
  send(_bytes) {
    throw new Error('Transport.send not implemented');
  }
  close() {
    // default no-op; subclasses implement teardown.
  }
}
