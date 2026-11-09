// client.js — a guest device's view. Thin and trusting: it just encodes/decodes
// messages over a transport and forwards them to the UI. All authority lives on
// the host; the client never validates game rules itself.

import { FrameDecoder, encodeMessage, M } from './protocol.js';

export class Client {
  constructor({ transport }) {
    this.transport = transport;
    this.decoder = new FrameDecoder();
    this.onMessage = null; // fn(msg) parsed host message
    this.onDisconnect = null; // fn()
    transport.onMessage = (bytes) => {
      for (const msg of this.decoder.push(bytes)) {
        if (this.onMessage) this.onMessage(msg);
      }
    };
    transport.onDisconnect = () => {
      if (this.onDisconnect) this.onDisconnect();
    };
  }

  // Send a message object to the host.
  send(msg) {
    this.transport.send(encodeMessage(msg));
  }

  join(name) {
    this.send({ t: M.JOIN, name });
  }
  play(cardId, color) {
    this.send({ t: M.ACT, kind: 'play', cardId, color });
  }
  draw() {
    this.send({ t: M.ACT, kind: 'draw' });
  }
  pass() {
    this.send({ t: M.ACT, kind: 'pass' });
  }
  uno() {
    this.send({ t: M.ACT, kind: 'uno' });
  }
  chat(text) {
    this.send({ t: M.CHAT, text });
  }
  close() {
    this.transport.close();
  }
}
