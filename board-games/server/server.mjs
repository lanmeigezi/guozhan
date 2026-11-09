// server.mjs — CLI to launch a room server for the web + LAN/internet play.
//   node server/server.mjs [port] [game]
// game: uno | doudizhu | exploding | liarsbar | guozhan | monopoly | werewolf (default uno).
// Opens at http://127.0.0.1:<port>/ .
// Players open that URL in a browser (or the packaged Android/iOS app) and join
// the room over WebSocket at /ws. Run on a LAN IP or a public host for 远程联机.
import { createRoom } from './room.mjs';

const port = Number(process.argv[2] || 8766);
const game = process.argv[3] || 'uno';

const room = await createRoom({ game, port });
console.log(`Room '${game}' ready.`);
console.log(`  Web   : ${room.url}/`);
console.log(`  WS    : ${room.wsUrl}`);
console.log(room.llm ? `  LLM   : ${room.llm.model} (server-side seat available)` : '  LLM   : disabled (set LLM_API_KEY / LLM_BASE_URL / LLM_MODEL)');
console.log(`  Ctrl+C to stop.`);
