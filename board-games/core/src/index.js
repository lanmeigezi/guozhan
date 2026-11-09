// index.js — public entry point for the core.
export { COLORS, KIND, buildDeck, shuffle, mulberry32, isWild, isAction, isColorCard, cardLabel } from './cards.js';
export { UnoGame, UnoError } from './uno.js';
export { DoudizhuGame, aiDoudizhu, buildDdzDeck, classifyDdz, beatsDdz } from './doudizhu.js';
export { ExplodingKittensGame, aiEk, buildEkDeck } from './exploding.js';
export { LiarsBarGame, aiLiarBar, buildLiarDeck } from './liarsbar.js';
export { GuozhanGame, aiGuozhan, GZ_SCENARIOS } from './guozhan.js';
export { MonopolyGame, aiMonopoly, MONOPOLY_BOARD } from './monopoly.js';
export { WerewolfGame, aiWerewolf } from './werewolf.js';
export { GameError } from './game-error.js';
export { GAMES, getGame } from './games.js';
export { PROTOCOL_VERSION, M, SM, encodeMessage, decodeSingle, FrameDecoder } from './protocol.js';
export { Transport } from './transport.js';
export { createLoopbackPair } from './loopback.js';
export { Host } from './host.js';
export { Client } from './client.js';
export { buildAgentPrompt, parseAgentActions, legalActionsFor } from './agent.js';
export { createLlmDriver } from './llm-local.js';
export { SCORE_VERSION, SCORE_RULES, SCORE_FORMULA, SCORE_TIERS, tierFor, winnersFor, scoreMatch, aggregateScoreEvents, scoreEventsFromResult } from './scoreboard.js';
