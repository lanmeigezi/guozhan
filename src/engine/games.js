// games.js — registry of the games the host can run. The host is transport- and
// game-agnostic: it only needs a Game object implementing the interface and a
// per-game AI to drive local bot seats. Adding a new multiplayer game = add a
// module exposing a Game class + an ai() here.

import { UnoGame } from '../games/uno.js';
import { DoudizhuGame, aiDoudizhu } from '../games/doudizhu.js';
import { ExplodingKittensGame, aiEk } from '../games/exploding.js';
import { LiarsBarGame, aiLiarBar } from '../games/liarsbar.js';
import { game as grab21Game } from '../games/grab21.js';

// ---- UNO bot AI (returns a {kind, ...} action for a bot seat) ----
function aiUno(game, seat) {
  const top = game.discard[game.discard.length - 1];
  const legal = game.players[seat].hand.filter(
    (cd) => game.canMatch(cd, top) && (cd.kind !== 'wild4' || game.mayPlayWild4(seat, cd))
  );
  const wild = (cd) => {
    if (cd.kind !== 'wild' && cd.kind !== 'wild4') return undefined;
    const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    for (const c of game.players[seat].hand) if (c.color) counts[c.color]++;
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  };
  if (game.turnState === 'drawn') {
    if (legal.some((m) => m.id === game.drawnCardId)) {
      const cd = game.players[seat].hand.find((x) => x.id === game.drawnCardId);
      return { kind: 'play', cardId: cd.id, color: wild(cd) };
    }
    return { kind: 'pass' };
  }
  if (legal.length) {
    const c2 = legal[0];
    return { kind: 'play', cardId: c2.id, color: wild(c2) };
  }
  return { kind: 'draw' };
}

export const GAMES = {
  uno: {
    key: 'uno',
    name: 'UNO 联机',
    card: 'UNO',
    min: 2,
    max: 8,
    create: (o) => new UnoGame(o),
    ai: aiUno,
  },
  doudizhu: {
    key: 'doudizhu',
    name: '斗地主',
    card: 'DDZ',
    min: 3,
    max: 3,
    create: (o) => new DoudizhuGame(o),
    ai: aiDoudizhu,
  },
  exploding: {
    key: 'exploding',
    name: '炸弹猫',
    card: 'EK',
    min: 2,
    max: 5,
    create: (o) => new ExplodingKittensGame(o),
    ai: aiEk,
  },
  liarsbar: {
    key: 'liarsbar',
    name: '骗子酒馆',
    card: 'LB',
    min: 3,
    max: 5,
    create: (o) => new LiarsBarGame(o),
    ai: aiLiarBar,
  },
  grab21: grab21Game,
};

export function getGame(key) {
  return GAMES[key] || GAMES.uno;
}

/**
 * MOD INTERFACE — register a player-written game so the Host/room can run it.
 *
 * A game definition must provide:
 *   key    : string id used over the wire and in lobby (`game` field)
 *   name   : human name shown in the lobby
 *   min/max: player-count bounds (host refuses start outside these)
 *   create : ({playerNames, options, random}) => gameInstance
 *   ai     : (game, seat) => action|null   [optional; drives local/remote bots]
 *
 * The gameInstance must implement the Game interface — see MODDING.md:
 *   addPlayer(name) -> seat, start() (via applyAction 'start'), applyAction(seat, action),
 *   snapshot(), viewFor(seat); throw GameError for illegal moves.
 */
export function registerGame(def) {
  if (!def || !def.key || typeof def.create !== 'function') return false;
  GAMES[def.key] = {
    key: def.key,
    name: def.name || def.key,
    card: def.card || String(def.key).toUpperCase().slice(0, 3),
    min: def.min || 2,
    max: def.max || 8,
    create: def.create,
    ai: def.ai || null,
  };
  return true;
}

/**
 * MOD INTERFACE — uninstall a registered game. The room must NOT be mid-game
 * with this key (host guards that via phase), so mods can only be swapped in the
 * lobby / between rounds — never while a round is running.
 */
export function unregisterGame(key) {
  if (!key || !GAMES[key]) return false;
  delete GAMES[key];
  return true;
}

export function registeredKeys() {
  return Object.keys(GAMES);
}
