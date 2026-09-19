// room.mjs — the server-authoritative LAN room: one HTTP + WebSocket server that
// owns a Host (any game from the registry) and accepts players over the LAN.
//
// Why server-authoritative: every client runs the same pure-JS core
// (src/engine + src/games) and only sends *intents* (`{t:'act'}`); the server
// validates each one against the rules and broadcasts a per-seat view. That is
// what makes cheating impossible and keeps every screen in sync.
//
// Endpoints:
//   GET  /              static web UI (if a web/ dir exists) or a status page
//   GET  /api/room      { game, http, ws, room } — machine-readable join info
//   GET  /api/mods      installed games + mod files on disk
//   POST /api/mods/reload            re-scan <repo>/mods
//   DELETE /api/mods/<key>           move a mod out of play (never mid-round)
//   POST /api/mods/enable/<key>      move it back and reload
//   WS   /ws            the game protocol (see src/engine/protocol.js)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WsServer } from '../engine/ws.js';
import { Host } from '../engine/host.js';
import { registeredKeys, unregisterGame, getGame } from '../engine/games.js';
import { loadMods, MODS_DIR } from './mods.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

export const BUILTIN = ['uno', 'doudizhu', 'exploding', 'liarsbar', 'grab21'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

/** First non-internal IPv4 — the address other machines on the LAN can reach. */
export function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

const STATUS_PAGE = (game, port) => `<!doctype html><meta charset="utf-8">
<title>LAN room — ${game}</title>
<style>body{font:15px/1.7 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}
code{background:#f2f2f4;padding:.15rem .35rem;border-radius:4px}</style>
<h1>LAN room is running</h1>
<p>Game: <b>${game}</b> · port <b>${port}</b></p>
<p>Join info: <code>/api/room</code> · installed games: <code>/api/mods</code></p>
<p>Players connect over WebSocket at <code>ws://&lt;this-host&gt;:${port}/ws</code>.</p>
<p>Put your own UI in <code>web/</code> and it will be served here instead.</p>`;

/**
 * Create a room server.
 * @param {object} [opts]
 * @param {string} [opts.game]       Registry key to host (default 'uno').
 * @param {number} [opts.port]       TCP port; 0 picks a free one (default 8766).
 * @param {string} [opts.host]       Bind address (default 0.0.0.0 = whole LAN).
 * @param {string} [opts.staticDir]  Web UI directory (default <repo>/web).
 * @param {string} [opts.logFile]    Append room events here (default <repo>/server.log).
 */
export async function createRoom({ game = 'uno', port = 8766, host = '0.0.0.0', staticDir, logFile } = {}) {
  await loadMods();

  const LOG_FILE = logFile === undefined ? path.join(ROOT, 'server.log') : logFile;
  const logLine = (line) => {
    if (!LOG_FILE) return;
    const ts = new Date().toISOString();
    try { fs.appendFileSync(LOG_FILE, `[${ts}] ${line}\n`); } catch (_) {}
  };

  const room = new Host({ game, playerName: null, remote: true });
  room.onLog = logLine;
  const www = staticDir || path.join(ROOT, 'web');
  const hasWeb = fs.existsSync(www);
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    res.on('error', () => {}); // a client dropping mid-request must not kill the room
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    let urlPath;
    try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch (_) { res.writeHead(400); return res.end('Bad request'); }

    if (urlPath === '/api/room') {
      const ip = lanIp();
      const body = {
        game: room.gameKey,
        http: `http://${ip}:${boundPort}/`,
        ws: `ws://${ip}:${boundPort}/ws`,
        room: `${ip}:${boundPort}`,
        players: room.game.players.length,
        max: (getGame(room.gameKey) || {}).max || null,
        phase: room.game.phase,
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(body));
    }

    const disabledDir = path.join(MODS_DIR, 'disabled');
    const listModFiles = () => (fs.existsSync(MODS_DIR) ? fs.readdirSync(MODS_DIR).filter((f) => f.endsWith('.mjs')) : []);
    const listDisabled = () => (fs.existsSync(disabledDir) ? fs.readdirSync(disabledDir).filter((f) => f.endsWith('.mjs')) : []);

    if (urlPath === '/api/mods' && req.method === 'GET') {
      const installed = registeredKeys().map((k) => {
        const def = getGame(k);
        return { key: k, name: def.name, min: def.min, max: def.max, builtin: BUILTIN.includes(k) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        installed, files: listModFiles(), disabledFiles: listDisabled(),
        current: room.gameKey, phase: room.game.phase,
      }));
    }

    if (urlPath === '/api/mods/reload' && req.method === 'POST') {
      try {
        await loadMods();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, installed: registeredKeys() }));
      } catch (e) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    }

    const del = urlPath.match(/^\/api\/mods\/([A-Za-z0-9_-]+)$/);
    if (del && req.method === 'DELETE') {
      const key = del[1];
      const inPlay = room.gameKey === key && (room.game.phase === 'playing' || room.game.phase === 'bidding');
      if (inPlay) {
        res.writeHead(409);
        return res.end(JSON.stringify({ ok: false, error: 'a round is in progress — cannot uninstall this mod now' }));
      }
      const removed = unregisterGame(key);
      const src = path.join(MODS_DIR, key + '.mjs');
      if (fs.existsSync(src)) {
        fs.mkdirSync(disabledDir, { recursive: true });
        fs.renameSync(src, path.join(disabledDir, key + '.mjs'));
        logLine(`mod '${key}' moved to disabled/`);
      }
      logLine(`mod '${key}' ${removed ? 'uninstalled' : 'not found'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: removed, installed: registeredKeys() }));
    }

    const en = urlPath.match(/^\/api\/mods\/enable\/([A-Za-z0-9_-]+)$/);
    if (en && req.method === 'POST') {
      const key = en[1];
      const src = path.join(disabledDir, key + '.mjs');
      if (fs.existsSync(src)) {
        fs.mkdirSync(MODS_DIR, { recursive: true });
        fs.renameSync(src, path.join(MODS_DIR, key + '.mjs'));
        try {
          await loadMods();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, installed: registeredKeys() }));
        } catch (e) {
          res.writeHead(500);
          return res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        }
      }
      res.writeHead(404);
      return res.end(JSON.stringify({ ok: false, error: 'no such disabled mod' }));
    }

    if (!hasWeb) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(STATUS_PAGE(room.gameKey, boundPort));
    }
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(www, path.normalize(urlPath));
    if (!filePath.startsWith(www)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });

  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (_) {} });
  server.on('error', () => {});

  const ws = new WsServer(server, { path: '/ws' });
  ws.onConnection = (conn) => {
    const ip = conn.clientIp || (conn.socket && conn.socket.remoteAddress) || '?';
    const rport = conn.socket ? conn.socket.remotePort : '';
    const h = (conn.req && conn.req.headers) || {};
    logLine(`client connected (ws) ip=${ip} port=${rport} host=${h.host || '-'} xff=${h['x-forwarded-for'] || '-'} ua="${h['user-agent'] || '-'}"`);
    room.addTransport(conn);
  };

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      boundPort = addr.port;
      const bindHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      resolve({
        server, host: room, ws,
        port: addr.port,
        staticDir: hasWeb ? www : null,
        url: `http://${bindHost}:${addr.port}`,
        wsUrl: `ws://${bindHost}:${addr.port}/ws`,
        lanUrl: `http://${lanIp()}:${addr.port}`,
        lanWsUrl: `ws://${lanIp()}:${addr.port}/ws`,
        logLine,
        close: () => new Promise((done) => {
          try { ws.connections.forEach((c) => { try { c.close(); } catch (_) {} }); } catch (_) {}
          try { server.close(() => done()); } catch (_) { done(); }
        }),
      });
      logLine(`room '${game}' ready on http://${bindHost}:${addr.port}/`);
    });
  });
}
