// protocol.js — wire messages and binary framing.
// Every message is a plain JSON object. On the wire it is framed as:
//   [4-byte big-endian payload length][UTF-8 JSON payload]
// This keeps the transport agnostic (Bluetooth socket / loopback / WebView bridge).
// Client<->Host message types are listed below so UIs can rely on a stable shape.

export const PROTOCOL_VERSION = 1;

// Client -> Host
export const M = {
  JOIN: 'join', // {t:'join', name}
  LEAVE: 'leave',
  START: 'start', // host only: begin the game
  ACT: 'act', // {t:'act', kind:'play'|'draw'|'pass'|'uno', cardId?, color?}
  CHAT: 'chat', // {t:'chat', text}
  BOT: 'bot', // {t:'bot', op:'set', count} — host only: adjust AI-bot count
  PING: 'ping',
};

// Host -> Client
export const SM = {
  LOBBY: 'lobby', // {t:'lobby', seats:[{seat,name}], you, hostSeat}
  STATE: 'state', // {t:'state', view, last}
  ERROR: 'error', // {t:'error', code, message}
  CHAT: 'chat', // {t:'chat', from, text}
  PING: 'ping',
  BYE: 'bye',
};

export function encodeMessage(obj) {
  if (typeof obj === 'string') obj = { t: 'ping', text: obj }; // resilience
  const json = JSON.stringify(obj);
  const payload = new TextEncoder().encode(json);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export function decodeSingle(bytes) {
  if (bytes.length < 4) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = dv.getUint32(0, false);
  if (bytes.length < 4 + len) return null;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)));
}

// Stream-aware decoder: feed arbitrary chunks, get complete messages back.
// Over the Bluetooth socket bytes arrive in arbitrary-sized chunks; this buffers them.
export class FrameDecoder {
  constructor() {
    this.buf = new Uint8Array(0);
  }
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    return this.drain();
  }
  drain() {
    const msgs = [];
    while (this.buf.length >= 4) {
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = dv.getUint32(0, false);
      if (this.buf.length < 4 + len) break;
      const payload = this.buf.subarray(4, 4 + len);
      msgs.push(JSON.parse(new TextDecoder().decode(payload)));
      this.buf = this.buf.subarray(4 + len);
    }
    return msgs;
  }
}
