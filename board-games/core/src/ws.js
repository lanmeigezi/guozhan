// ws.js — minimal zero-dependency WebSocket server + transports.
//
// This is the network transport that makes the app a true cross-platform LAN /
// internet (远程) game: the Host runs on a room server, and every client (PC
// browser, Android WebView, iOS WebView) connects over a WebSocket. Because the
// game core is pure JS and runs in every client, all three platforms share one
// codebase and one wire protocol. We speak binary frames so the existing
// length-prefixed protocol (protocol.js) is reused unchanged.
//
// - WsServer: RFC 6455 server over a node:http server (host side).
// - WsConnection: a server-side transport implementing the core Transport
//     contract (send/close + onMessage/onDisconnect), so Host.addTransport works.
// - WsClientTransport: wraps a browser/Node WebSocket into the same Transport
//     contract for clients.
// - serveFrame() / parseFrame(): helpers used by both sides.

import http from 'node:http';
import crypto from 'node:crypto';
import { Transport } from './transport.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

// Build a single-frame message. opcode 0x2 = binary, 0x1 = text, 0x8 = close.
export function buildFrame(payload, opcode = 0x2, mask = null) {
  const buf = Buffer.from(payload);
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  let body = buf;
  if (mask) {
    header[1] |= 0x80;
    body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = buf[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, body]);
  }
  return Buffer.concat([header, body]);
}

// Try to parse one frame from `buf`. Returns {fin, opcode, payload, rest} or null.
export function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (mask) {
    const p = Buffer.alloc(len);
    for (let i = 0; i < len; i++) p[i] = payload[i] ^ mask[i & 3];
    payload = p;
  }
  return { fin, opcode, payload, rest: buf.slice(off + len) };
}

// Server-side connection: a Transport over one WebSocket socket.
export class WsConnection extends Transport {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this._closedFlag = false;
    socket.on('data', (d) => this.push(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const f = parseFrame(this.buf);
      if (!f) break;
      this.buf = f.rest;
      if (f.opcode === 0x8) { this.socket.end(); this._closed(); return; } // close
      if (f.opcode === 0x9) { this.socket.write(buildFrame(f.payload, 0xA)); continue; } // ping -> pong
      if (f.opcode === 0xA) continue; // pong
      // data frames (text or binary)
      const isContinuation = f.opcode === 0x0;
      if (!isContinuation) this.frags = [f.payload];
      else if (this.frags.length) this.frags = this.frags.concat([f.payload]);
      if (f.fin) {
        const payload = Buffer.concat(this.frags);
        this.frags = [];
        const bytes = new Uint8Array(payload);
        if (this.onMessage) this.onMessage(bytes);
      }
    }
  }

  send(bytes) {
    if (this.socket.destroyed) return;
    this.socket.write(buildFrame(Buffer.from(bytes), 0x2));
  }

  close() {
    try { this.socket.write(buildFrame(Buffer.from([]), 0x8)); } catch (_) {}
    try { this.socket.end(); } catch (_) {}
  }

  _closed() {
    if (this._closedFlag) return;
    this._closedFlag = true;
    if (this.onDisconnect) this.onDisconnect();
  }
}

// Client-side transport wrapping a browser/Node WebSocket object.
export class WsClientTransport extends Transport {
  constructor(ws) {
    super();
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      const d = e.data;
      if (typeof d === 'string') {
        // rare text frame fallback (e.g. server sent text)
        const bytes = new Uint8Array(new TextEncoder().encode(d));
        if (this.onMessage) this.onMessage(bytes);
      } else {
        const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        if (this.onMessage) this.onMessage(bytes);
      }
    };
    ws.onclose = () => { if (this.onDisconnect) this.onDisconnect(); };
    ws.onerror = () => { if (this.onDisconnect) this.onDisconnect(); };
  }

  send(bytes) {
    this.ws.send(bytes);
  }

  close() {
    try { this.ws.close(); } catch (_) {}
  }

  ready() {
    return this.ws.readyState === 1;
  }
}

// Mount a WebSocket endpoint on a node:http server.
export class WsServer {
  constructor(server, { path = '/' } = {}) {
    this.connections = new Set();
    server.on('upgrade', (req, socket, head) => {
      const url = (req.url || '/').split('?')[0];
      if (url !== path) { socket.destroy(); return; }
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
      );
      if (head && head.length) socket.unshift(head);
      const conn = new WsConnection(socket);
      // Keep the HTTP upgrade request so callers can log WHO connected: behind a
      // reverse tunnel (花生壳/ngrok/nginx) the socket address is the local tunnel,
      // and the real client IP only arrives in X-Forwarded-For / X-Real-IP.
      conn.req = req;
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      conn.clientIp = xff || req.headers['x-real-ip'] || socket.remoteAddress || '?';
      this.connections.add(conn);
      // Clean the connection set independently of the single onDisconnect slot,
      // which Host.addTransport overwrites with its own disconnect handler.
      socket.on('close', () => this.connections.delete(conn));
      if (this.onConnection) this.onConnection(conn);
    });
  }
}
