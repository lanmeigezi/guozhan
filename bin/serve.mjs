#!/usr/bin/env node
// bin/serve.mjs — host a LAN room for any registered game.
//
//   node bin/serve.mjs                      # UNO on port 8766, announced on the LAN
//   node bin/serve.mjs 9000 doudizhu        # 斗地主 on port 9000
//   node bin/serve.mjs --no-announce        # don't answer UDP discovery probes
//   node bin/serve.mjs --discovery-port 8767
//
// It prints the address other machines should open/connect to. Players on the
// same network can also find the room automatically: node bin/find.mjs

import { startLanRoom, DEFAULT_DISCOVERY_PORT } from '../src/lan/index.mjs';
import { registeredKeys, getGame } from '../src/engine/games.js';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const positional = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== flag('discovery-port', null));

const port = Number(argv.find((a) => /^\d+$/.test(a))) || Number(flag('port', 8766));
const gameArg = positional.find((a) => registeredKeys().includes(a)) || 'uno';
const announce = flag('no-announce', false) !== true;
const discoveryPort = Number(flag('discovery-port', DEFAULT_DISCOVERY_PORT));

const room = await startLanRoom({ game: gameArg, port, announce, discoveryPort });
const def = getGame(room.host.gameKey);

console.log('');
console.log(`  ${def.name} room is up  (game=${room.host.gameKey}, ${def.min}-${def.max} players)`);
console.log(`  ─────────────────────────────────────────────────────────`);
console.log(`  LAN address : ${room.lanUrl}/`);
console.log(`  WebSocket   : ${room.lanWsUrl}`);
console.log(`  local       : ${room.url}/`);
if (room.discoveryPort) console.log(`  discovery   : answering UDP probes on port ${room.discoveryPort} — players run: node bin/find.mjs`);
else console.log(`  discovery   : off — share the LAN address above`);
console.log('');
console.log(`  games available: ${registeredKeys().join(', ')}`);
console.log('  Ctrl+C to stop');
console.log('');

let closing = false;
const shutdown = async (sig) => {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} — closing room…`);
  await room.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
