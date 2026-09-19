// discovery.mjs — zero-dependency LAN room discovery over UDP.
//
// Host side: an *announcer* listens on a UDP port and answers any probe with a
// JSON description of the room. Client side: `discoverRooms()` broadcasts one
// probe and collects the replies, so players never have to type an IP address.
//
// Wire format (one JSON object per datagram, versioned):
//   probe  { t: 'TTG_DISCOVER', v: 1 }
//   reply  { t: 'TTG_ROOM', v: 1, name, game, http, ws, players, max }

import dgram from 'node:dgram';
import os from 'node:os';

export const PROBE = 'TTG_DISCOVER';
export const REPLY = 'TTG_ROOM';
export const VERSION = 1;
export const DEFAULT_DISCOVERY_PORT = 8767;

/** Every non-internal IPv4 address of this machine, with its subnet broadcast. */
export function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      let broadcast = '255.255.255.255';
      const ip = i.address.split('.').map(Number);
      const mask = (i.netmask || '255.255.255.0').split('.').map(Number);
      if (ip.length === 4 && mask.length === 4) {
        broadcast = ip.map((n, k) => (n & mask[k]) | (~mask[k] & 255)).join('.');
      }
      out.push({ address: i.address, broadcast });
    }
  }
  return out;
}

/** Broadcast targets for a probe: each subnet broadcast plus the global one. */
export function broadcastTargets() {
  const set = new Set(['255.255.255.255']);
  for (const a of localAddresses()) if (a.broadcast !== '0.0.0.0') set.add(a.broadcast);
  return [...set];
}

function parseJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
}

/**
 * Host side: answer discovery probes for one room.
 * @param {object} opts
 * @param {object|Function} opts.info  Room description, or a function returning it
 *        (a function is re-evaluated per probe, so player counts stay live).
 * @param {number} [opts.port]  UDP port to listen on (default 8767).
 * @param {string} [opts.host]  Interface to bind (default all).
 * @param {Function} [opts.onProbe]  Optional hook (rinfo) for logging.
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export function createAnnouncer({ info, port = DEFAULT_DISCOVERY_PORT, host = '0.0.0.0', onProbe } = {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (buf, rinfo) => {
    const msg = parseJson(buf);
    if (!msg || msg.t !== PROBE) return;
    if (onProbe) { try { onProbe(rinfo); } catch (_) {} }
    let payload;
    try { payload = typeof info === 'function' ? info() : info; } catch (_) { return; }
    if (!payload) return;
    const reply = Buffer.from(JSON.stringify({ t: REPLY, v: VERSION, ...payload }), 'utf8');
    socket.send(reply, rinfo.port, rinfo.address, () => {});
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => {
      try { socket.setBroadcast(true); } catch (_) {}
      resolve({
        port: socket.address().port,
        close: () => new Promise((done) => {
          try { socket.close(() => done()); } catch (_) { done(); }
        }),
      });
    });
  });
}

/**
 * Client side: find rooms on the LAN.
 * @param {object} [opts]
 * @param {number} [opts.port]       Discovery port (default 8767).
 * @param {number} [opts.timeoutMs]  How long to collect replies (default 1200).
 * @param {string[]} [opts.targets]  Override probe targets (default: LAN broadcasts).
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<object>>} Deduplicated room descriptions.
 */
export function discoverRooms({ port = DEFAULT_DISCOVERY_PORT, timeoutMs = 1200, targets, signal } = {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const found = new Map();
  const probe = Buffer.from(JSON.stringify({ t: PROBE, v: VERSION }), 'utf8');
  const list = targets && targets.length ? targets : broadcastTargets();

  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      try { socket.close(); } catch (_) {}
      resolve([...found.values()]);
    };
    socket.on('message', (buf, rinfo) => {
      const msg = parseJson(buf);
      if (!msg || msg.t !== REPLY) return;
      const key = msg.ws || msg.http || `${rinfo.address}:${rinfo.port}`;
      if (!found.has(key)) found.set(key, { ...msg, from: rinfo.address });
    });
    socket.once('error', (e) => { try { socket.close(); } catch (_) {} reject(e); });
    if (signal) signal.addEventListener('abort', finish, { once: true });

    socket.bind(0, () => {
      try { socket.setBroadcast(true); } catch (_) {}
      for (const t of list) socket.send(probe, port, t, () => {});
      timer = setTimeout(finish, timeoutMs);
      if (timer.unref) timer.unref();
    });
  });
}
