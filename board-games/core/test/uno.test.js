// uno.test.js — unit tests for the pure UNO rules engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, mulberry32, KIND, COLORS, cardLabel } from '../src/cards.js';
import { UnoGame, UnoError } from '../src/uno.js';

// Convenience card constructor (ids must be unique within a hand).
let seq = 0;
function c(id, color, kind, value = null) {
  return { id: id ?? `c${seq++}`, color, kind, value };
}

function rng() {
  return mulberry32(12345);
}

test('deck has the standard 108 cards', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  // 4 zero-value cards
  assert.equal(deck.filter((x) => x.kind === KIND.NUMBER && x.value === 0).length, 4);
  // numbers 1..9 appear twice per color (4 colors x 2 = 8 copies each)
  assert.equal(deck.filter((x) => x.kind === KIND.NUMBER && x.value === 5).length, 8);
  // actions *2* per color
  assert.equal(deck.filter((x) => x.kind === KIND.SKIP).length, 8);
  assert.equal(deck.filter((x) => x.kind === KIND.REVERSE).length, 8);
  assert.equal(deck.filter((x) => x.kind === KIND.DRAW2).length, 8);
  // wilds
  assert.equal(deck.filter((x) => x.kind === KIND.WILD).length, 4);
  assert.equal(deck.filter((x) => x.kind === KIND.WILD4).length, 4);
});

test('deck scales up with more players (offline AI battle mode)', () => {
  // Up to 4 players keep the standard 108-card deck; larger games grow it so the
  // draw pile never starves when the host adds many AI opponents.
  assert.equal(buildDeck(2).length, 108);
  assert.equal(buildDeck(4).length, 108);
  assert.ok(buildDeck(6).length > 108, '6-player deck is larger');
  assert.ok(buildDeck(8).length > buildDeck(6).length, 'deck grows with player count');
  // every card still belongs to a color or is a wild
  assert.ok(buildDeck(8).every((x) => x.color || (x.kind === KIND.WILD || x.kind === KIND.WILD4)));
});

test('requires at least two players and a lobby to start', () => {
  const g = new UnoGame({ playerNames: ['A'], random: rng() });
  assert.throws(() => g.start(), (e) => e instanceof UnoError && e.code === 'NOT_ENOUGH');
});

test('deals the right number of cards and starts with a color', () => {
  const g = new UnoGame({ playerNames: ['A', 'B', 'C', 'D'], random: rng() });
  g.start();
  assert.equal(g.phase, 'playing');
  assert.ok(COLORS.includes(g.color));
  for (const p of g.players) assert.equal(p.hand.length, 7);
  assert.equal(g.drawPile.length + g.discard.length + 4 * 7, 108);
});

test('rejects an illegal card (wrong color and wrong number)', () => {
  const g = setupTurn();
  assert.throws(() => g.playCard(0, 'blue3'), (e) => e instanceof UnoError && e.code === 'ILLEGAL');
});

test('accepts a matching-color card', () => {
  const g = setupTurn();
  const r = g.playCard(0, 'red3');
  assert.equal(g.players[0].hand.length, 2); // started with 3, played one
  assert.equal(g.discard[g.discard.length - 1].id, 'red3');
  assert.equal(g.color, 'red');
  assert.equal(r.phase, 'playing');
});

test('accepts a same-number card of a different color', () => {
  const g = setupTurn();
  g.playCard(0, 'green7'); // green 7 matches red 7 by number
  assert.equal(g.discard[g.discard.length - 1].id, 'green7');
  assert.equal(g.color, 'green');
});

test('skip advances the turn by two seats', () => {
  const g = setupTurn();
  g.players[0].hand.push(c('redskip', 'red', KIND.SKIP));
  g.playCard(0, 'redskip');
  assert.equal(g.current, 2); // player 1 skipped
});

test('reverse with 4 players flips direction', () => {
  const g = setupTurn();
  g.current = 1;
  g.players[1].hand.push(c('redrev', 'red', KIND.REVERSE));
  g.playCard(1, 'redrev');
  assert.equal(g.direction, -1);
  assert.equal(g.current, 0);
});

test('reverse with 2 players acts like skip (player goes again)', () => {
  const g = new UnoGame({ playerNames: ['A', 'B'], random: rng() });
  setBoard(g, 0);
  g.players[0].hand.push(c('redrev', 'red', KIND.REVERSE));
  g.playCard(0, 'redrev');
  assert.equal(g.current, 0);
});

test('draw two: next player draws 2 and is skipped', () => {
  const g = setupTurn();
  const before = g.players[1].hand.length;
  g.players[0].hand.push(c('redd2', 'red', KIND.DRAW2));
  g.playCard(0, 'redd2');
  assert.equal(g.players[1].hand.length, before + 2);
  assert.equal(g.current, 2); // player 1 skipped
});

test('wild four: strict rule blocks +4 while holding active color', () => {
  const g = setupTurn(); // red active, player0 holds red7 + red3
  g.players[0].hand.push(c('wild4', null, KIND.WILD4));
  assert.throws(() => g.playCard(0, 'wild4', 'blue'), (e) => e instanceof UnoError && e.code === 'ILLEGAL_WILD4');
});

test('wild four: allowed when holding no active color; target draws 4 and is skipped', () => {
  const g = setupTurn();
  g.players[0].hand = [c('w4', null, KIND.WILD4), c('g', 'green', KIND.NUMBER, 9)];
  const before = g.players[1].hand.length;
  g.playCard(0, 'w4', 'blue');
  assert.equal(g.color, 'blue');
  assert.equal(g.players[1].hand.length, before + 4);
  assert.equal(g.current, 2);
});

test('wild card requires a chosen color', () => {
  const g = setupTurn();
  g.players[0].hand.push(c('wild', null, KIND.WILD));
  assert.throws(() => g.playCard(0, 'wild'), (e) => e instanceof UnoError && e.code === 'NEED_COLOR');
  g.playCard(0, 'wild', 'yellow');
  assert.equal(g.color, 'yellow');
});

test('after drawing you may only play the drawn card', () => {
  const g = setupTurn();
  g.players[0].hand = [c('r3', 'red', KIND.NUMBER, 3)];
  g.drawPile = [c('runused', 'green', KIND.NUMBER, 9), c('drawn', 'red', KIND.NUMBER, 9)];
  const r = g.drawCard(0);
  // drawn card is 'drawn' (last popped); playing another hand card is illegal
  assert.throws(() => g.playCard(0, 'r3'), (e) => e instanceof UnoError && e.code === 'NOT_DRAWN_CARD');
  g.playCard(0, 'drawn');
  assert.equal(g.discard[g.discard.length - 1].id, 'drawn');
});

test('draw then pass ends your turn', () => {
  const g = setupTurn();
  g.players[0].hand = [c('r3', 'red', KIND.NUMBER, 3)];
  g.drawPile = [c('drawn', 'red', KIND.NUMBER, 9)];
  g.drawCard(0);
  g.passTurn(0);
  assert.equal(g.current, 1);
  assert.equal(g.turnState, 'awaiting');
});

test('uno penalty: dropping to 1 card without calling costs +2', () => {
  const g = setupTurn();
  g.players[0].hand = [c('rskip', 'red', KIND.SKIP), c('r2', 'red', KIND.NUMBER, 2)];
  g.playCard(0, 'rskip');
  assert.equal(g.players[0].hand.length, 3); // 1 left + 2 penalty
  assert.equal(g.players[0].unoAnnounced, true);
});

test('uno call marks the player as announced', () => {
  const g = setupTurn();
  g.callUno(0);
  assert.equal(g.players[0].unoAnnounced, true);
});

test('playing your last card wins the round', () => {
  const g = setupTurn();
  g.players[0].hand = [c('r9', 'red', KIND.NUMBER, 9)];
  g.playCard(0, 'r9');
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.winner, 0);
});

test('a full auto-played game terminates with a winner', () => {
  const g = new UnoGame({ playerNames: ['A', 'B', 'C', 'D'], random: mulberry32(7), options: { unoPenalty: true } });
  g.start();
  const winner = playAuto(g);
  assert.equal(g.phase, 'roundEnd');
  assert.ok(g.winner != null);
  assert.equal(winner, g.winner);
});

// ---- helpers ----
// Sets a known board: 4 players, red active, top card red 7.
function setupTurn() {
  const g = new UnoGame({ playerNames: ['A', 'B', 'C', 'D'], random: rng() });
  setBoard(g, 0);
  return g;
}

function setBoard(g, current) {
  g.phase = 'playing';
  g.current = current;
  g.color = 'red';
  g.direction = 1;
  g.turnState = 'awaiting';
  g.discard = [c('red7', 'red', KIND.NUMBER, 7)];
  g.drawPile = buildDeck();
  g.players[0].hand = [c('red3', 'red', KIND.NUMBER, 3), c('blue3', 'blue', KIND.NUMBER, 3), c('green7', 'green', KIND.NUMBER, 7)];
  for (let i = 1; i < g.n; i++) g.players[i].hand = [c(`p${i}-a`, 'yellow', KIND.NUMBER, 1), c(`p${i}-b`, 'blue', KIND.NUMBER, 2)];
}

// White-box bot used to drive an engine to completion in tests.
function legalMoves(g, seat) {
  const top = g.discard[g.discard.length - 1];
  return g.players[seat].hand.filter((cd) => {
    if (!g.canMatch(cd, top)) return false;
    if (cd.kind === KIND.WILD4 && !g.mayPlayWild4(seat, cd)) return false;
    return true;
  });
}

function playAuto(g) {
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 4000) {
    const seat = g.current;
    const moves = legalMoves(g, seat);
    let played = false;
    if (g.turnState === 'drawn') {
      if (moves.some((m) => m.id === g.drawnCardId)) {
        g.playCard(seat, g.drawnCardId, pickColor(g, seat));
        played = true;
      } else {
        g.passTurn(seat);
        played = true;
      }
    } else if (moves.length > 0) {
      const m = moves[0];
      g.playCard(seat, m.id, pickColor(g, seat));
      played = true;
    } else {
      g.drawCard(seat);
      played = true;
    }
    if (!played) break;
  }
  return g.winner;
}

function pickColor(g, seat) {
  // choose the color the player has the most of, else red
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const cd of g.players[seat].hand) if (cd.color) counts[cd.color]++;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
}
