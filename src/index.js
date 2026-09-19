// index.js — public entry point for the game core (browser-safe, zero deps).
//
// Layering:
//   src/engine/  transport-agnostic machinery (protocol, host, client, registry)
//   src/games/   the actual rules engines (uno, doudizhu, exploding, liarsbar, grab21)
//   src/lan/     Node-only: LAN room server + UDP discovery   (import from src/lan/index.mjs)
//   src/bt/      Android WebView Bluetooth bridge             (import from src/bt/bridge.js)
//
// Everything exported here runs unchanged in Node and in a browser/WebView.

export { COLORS, KIND, buildDeck, shuffle, mulberry32, isWild, isAction, isColorCard, cardLabel } from './engine/cards.js';
export { GameError } from './engine/game-error.js';
export { PROTOCOL_VERSION, M, SM, encodeMessage, decodeSingle, FrameDecoder } from './engine/protocol.js';
export { Transport } from './engine/transport.js';
export { createLoopbackPair } from './engine/loopback.js';
export { GAMES, getGame, registerGame, unregisterGame, registeredKeys } from './engine/games.js';
export { Host } from './engine/host.js';
export { Client } from './engine/client.js';

export { UnoGame, UnoError } from './games/uno.js';
export { DoudizhuGame, aiDoudizhu, buildDdzDeck, classifyDdz, beatsDdz } from './games/doudizhu.js';
export { ExplodingKittensGame, aiEk, buildEkDeck } from './games/exploding.js';
export { LiarsBarGame, aiLiarBar, buildLiarDeck } from './games/liarsbar.js';
export { game as grab21, Grab21Game, aiGrab21 } from './games/grab21.js';
