#!/usr/bin/env node
// bin/find.mjs — discover LAN rooms (no IP address needed).
//
//   node bin/find.mjs                 # listen 1.5s for room announcements
//   node bin/find.mjs --timeout 3000
//   node bin/find.mjs --target 127.0.0.1          # probe one host instead of broadcasting
//   node bin/find.mjs --port 8767                 # non-default discovery port
//
// Rooms respond to a UDP broadcast probe; this prints the WebSocket URL to join.

import { discoverRooms, DEFAULT_DISCOVERY_PORT } from '../src/lan/index.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
};

const port = Number(flag('port', DEFAULT_DISCOVERY_PORT));
const timeoutMs = Number(flag('timeout', 1500));
const target = flag('target', null);
const targets = target ? [String(target)] : undefined;

console.log(`Scanning for LAN rooms (discovery port ${port}, ${timeoutMs}ms)…`);
const rooms = await discoverRooms({ port, timeoutMs, targets });

if (!rooms.length) {
  console.log('No rooms answered.');
  console.log('· make sure the host ran `npm run serve` (and did not pass --no-announce)');
  console.log('· both machines must be on the same network, and UDP must not be blocked');
  process.exit(1);
}

console.log(`\nFound ${rooms.length} room(s):\n`);
for (const r of rooms) {
  console.log(`  ${r.name || '(unnamed room)'}`);
  console.log(`    game    : ${r.game}${r.players != null ? `  (${r.players}${r.max ? '/' + r.max : ''} players)` : ''}`);
  console.log(`    join ws : ${r.ws}`);
  console.log(`    open    : ${r.http}`);
  console.log(`    from    : ${r.from}`);
  console.log('');
}
process.exit(0);
