// room.js — server-authoritative room. Runs a Host (any game) and accepts
// players over WebSocket; also serves the web UI. This is the transport that
// makes PC-web / Android / iOS interconnect over the LAN or the internet: every
// client runs the same pure-JS core and connects with a WebSocket.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WsServer } from '../core/src/ws.js';
import { Host } from '../core/src/host.js';
import { loadMods } from './mods-loader.mjs';
import { createLlmFromEnv, describeLlm } from './llm.mjs';
import { LeaderboardStore } from './leaderboard.mjs';
import { SCORE_RULES, SCORE_FORMULA } from '../core/src/scoreboard.js';
import { registeredKeys, unregisterGame, getGame } from '../core/src/games.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Append a timestamped line to the server log so we can diagnose joins, leaves,
// game starts, errors and bot moves without guessing.
const LOG_FILE = path.join(ROOT, 'server.log');
function logLine(line) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${line}\n`); } catch (_) {}
}

// First non-internal IPv4 (used to advertise a joinable LAN address).
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export async function createRoom({ game = 'uno', port = 8766, host = '0.0.0.0', staticDir, random, llm: llmOverride } = {}) {
  // Load player-written mod games (mods/*.mjs) so they can be hosted like built-ins.
  await loadMods();
  const llm = llmOverride !== undefined ? llmOverride : createLlmFromEnv();
  const llmInfo = describeLlm(llm);
  const room = new Host({ game, playerName: null, remote: true, random, llm });
  room.onLog = logLine;
  const scoreboard = new LeaderboardStore({ dir: process.env.BOARD_GAMES_DATA_DIR || path.join(ROOT, 'data') });
  room.onMatchEnd = (result) => {
    try {
      const n = scoreboard.appendResult(result);
      if (n) logLine(`leaderboard: +${n} human score(s) from ${result.game} ${result.matchId}`);
    } catch (err) {
      logLine(`leaderboard write failed: ${err && err.message ? err.message : String(err)}`);
    }
  };
  const www = staticDir || path.join(ROOT, 'app', 'src', 'main', 'assets', 'www');
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    // Ignore socket errors on individual responses so a client that drops the
    // connection mid-request can never crash the whole room server.
    res.on('error', () => {});
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let urlPath;
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch (_) { res.writeHead(400); return res.end('Bad request'); }
    if (urlPath === '/api/room') {
      const ip = lanIp();
      const body = { game, http: `http://${ip}:${boundPort}/`, ws: `ws://${ip}:${boundPort}/ws`, room: `${ip}:${boundPort}`, llm: llmInfo };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    if (urlPath === '/api/leaderboard' && req.method === 'GET') {
      let range = 'all';
      let limit = 50;
      try {
        const q = new URL(req.url || '/', 'http://localhost').searchParams;
        if (['today', 'week', 'all'].includes(q.get('range'))) range = q.get('range');
        const rawLimit = q.get('limit');
        const n = rawLimit == null || rawLimit === '' ? NaN : Number(rawLimit);
        if (Number.isFinite(n)) limit = Math.max(1, Math.min(100, Math.floor(n)));
      } catch (_) { /* use defaults */ }
      try {
        const rows = scoreboard.list({ range, limit }).map(({ key, ...rest }) => rest);
        const body = { ok: true, range, rows, rules: SCORE_RULES, formula: SCORE_FORMULA, updatedAt: new Date().toISOString() };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(body));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
      }
    }
    // ---- Mod management (install / uninstall; never while a round is running) ----
    const modsDir = path.join(ROOT, 'mods');
    const disabledDir = path.join(ROOT, 'mods', 'disabled');
    const listModFiles = () => (fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => f.endsWith('.mjs')) : []);
    const listDisabledFiles = () => (fs.existsSync(disabledDir) ? fs.readdirSync(disabledDir).filter((f) => f.endsWith('.mjs')) : []);
    if (urlPath === '/api/mods' && req.method === 'GET') {
      const installed = registeredKeys().map((k) => {
        const def = getGame(k);
        return { key: k, name: def.name, min: def.min, max: def.max, builtin: ['uno', 'doudizhu', 'exploding', 'liarsbar', 'guozhan', 'monopoly', 'werewolf'].includes(k) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ installed, files: listModFiles(), disabledFiles: listDisabledFiles(), current: room.gameKey, phase: room.game.phase, llm: llmInfo }));
    }
    if (urlPath === '/api/mods/reload' && req.method === 'POST') {
      try { await loadMods(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, installed: registeredKeys() })); }
      catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) })); }
    }
    const modDel = urlPath.match(/^\/api\/mods\/([A-Za-z0-9_\-]+)$/);
    if (modDel && req.method === 'DELETE') {
      const key = modDel[1];
      const inPlay = room.gameKey === key && (room.game.phase === 'playing' || room.game.phase === 'bidding');
      if (inPlay) { res.writeHead(409); return res.end(JSON.stringify({ ok: false, error: '对局进行中，不能在局内卸载该 Mod' })); }
      const removed = unregisterGame(key);
      const src = path.join(ROOT, 'mods', key + '.mjs');
      if (fs.existsSync(src)) {
        fs.mkdirSync(disabledDir, { recursive: true });
        fs.renameSync(src, path.join(disabledDir, key + '.mjs'));
        logLine(`mod '${key}' moved to disabled/`);
      }
      logLine(`mod '${key}' ${removed ? 'uninstalled' : 'not found'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: removed, installed: registeredKeys() }));
    }
    const modEnable = urlPath.match(/^\/api\/mods\/enable\/([A-Za-z0-9_\-]+)$/);
    if (modEnable && req.method === 'POST') {
      const key = modEnable[1];
      const src = path.join(disabledDir, key + '.mjs');
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.join(ROOT, 'mods'), { recursive: true });
        fs.renameSync(src, path.join(ROOT, 'mods', key + '.mjs'));
        try { await loadMods(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, installed: registeredKeys() })); }
        catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) })); }
      }
      res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'disabled mod not found' }));
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
  // A client socket error (e.g. it reset the connection mid-request) must not
  // take down the server; destroy the bad socket and keep listening.
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (_) {} });
  server.on('error', () => {});

  const ws = new WsServer(server, { path: '/ws' });
  ws.onConnection = (conn) => {
    // Log who connected: real client IP (via X-Forwarded-For when behind the
    // 花生壳 tunnel), source port, and the User-Agent (identifies the device).
    const ip = conn.clientIp || (conn.socket && conn.socket.remoteAddress) || '?';
    const rport = conn.socket ? conn.socket.remotePort : '';
    const h = (conn.req && conn.req.headers) || {};
    const ua = h['user-agent'] || '-';
    const xff = h['x-forwarded-for'] || '-';
    const host = h['host'] || '-';
    logLine(`client connected (ws) ip=${ip} port=${rport} host=${host} xff=${xff} ua="${ua}"`);
    room.addTransport(conn);
  };

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      boundPort = addr.port;
      const bindHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      resolve({
        server, host: room, ws, port: addr.port, llm, llmInfo,
        url: `http://${bindHost}:${addr.port}`,
        wsUrl: `ws://${bindHost}:${addr.port}/ws`,
      });
      logLine(`Room '${game}' ready on http://${bindHost}:${addr.port}/`);
      logLine(llm ? `LLM seat available (model=${llm.model})` : 'LLM seat disabled (set LLM_API_KEY to enable)');
    });
  });
}
