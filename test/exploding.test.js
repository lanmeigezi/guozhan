// exploding.test.js — unit tests for the 炸弹猫 rules engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExplodingKittensGame, aiEk, buildEkDeck } from '../src/games/exploding.js';
import { mulberry32 } from '../src/engine/cards.js';

test('deals 1 defuse + N cards and inserts n-1 kittens', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(3) });
  const snap = g.start();
  assert.equal(snap.phase, 'playing');
  g.players.forEach((p) => assert.equal(p.hand.filter((c) => c.kind === 'defuse').length, 1));
  assert.equal(snap.drawCount, g.drawPile.length);
  assert.equal(g.drawPile.filter((c) => c.kind === 'explode').length, 2); // n-1
});

test('an auto-played game terminates with a winner', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(7) });
  g.start();
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 5000) {
    if (g.pendingFavor) { // the favor target (not the current player) must hand a card
      const t = g.pendingFavor.target;
      const act = aiEk(g, t) || { kind: 'give', cardId: g.players[t].hand[0].id };
      g.applyAction(t, act);
      continue;
    }
    const seat = g.current;
    const act = aiEk(g, seat) || { kind: 'draw' };
    g.applyAction(seat, act);
  }
  assert.equal(g.phase, 'roundEnd');
  assert.ok(g.winner != null);
  assert.equal(g.players.filter((p) => p.alive).length, 1);
});

test('playing a skip advances the turn', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B'], random: mulberry32(5) });
  g.start();
  g.players[0].hand.push({ id: 'x', kind: 'skip' });
  const before = g.current;
  g.applyAction(0, { kind: 'play', cardId: 'x' });
  assert.notEqual(g.current, before);
});

test('drawing a bomb with a defuse defers placement; defuse uses the chosen position', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B'], random: mulberry32(3) });
  g.start();
  g.players[0].hand = [{ id: 'df', kind: 'defuse' }];
  g.drawPile = [{ id: 'bomb', kind: 'explode' }, { id: 'n1', kind: 'skip' }, { id: 'n2', kind: 'see' }];
  g.current = 0;
  g.phase = 'playing';
  const snap = g.draw(0);
  assert.ok(snap.pendingDefuse && snap.pendingDefuse.seat === 0, 'defuse is pending');
  assert.equal(g.current, 0, 'turn is not advanced before placing');
  assert.equal(g.players[0].hand.some((c) => c.kind === 'defuse'), false, 'defuse card consumed');
  // place the bomb at the TOP (position 1) -> it should be the next drawn card
  const r = g.defuse(0, 1);
  assert.equal(r.pendingDefuse, null);
  assert.equal(g.drawPile[0].id, 'bomb', 'bomb placed at the chosen top position');
  assert.equal(g.current, 1, 'turn advanced after defusing');
});

test('cats: 2 identical cats take a random card from the target and do NOT skip the turn', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(4) });
  g.start();
  g.players[0].hand = [{ id: 'c1', kind: 'cat', cat: 'A' }, { id: 'c2', kind: 'cat', cat: 'A' }, { id: 'd', kind: 'defuse' }];
  g.players[1].hand = [{ id: 't1', kind: 'skip' }, { id: 't2', kind: 'see' }];
  g.current = 0; g.phase = 'playing';
  const before = g.players[1].hand.length;
  const snap = g.applyAction(0, { kind: 'cats', cardIds: ['c1', 'c2'], targetSeat: 1 });
  assert.equal(g.players[1].hand.length, before - 1, 'target lost one random card');
  assert.equal(g.players[0].hand.length, 2, 'player kept defuse + gained one card');
  assert.equal(g.current, 0, 'turn NOT skipped; player must still draw');
});

test('favor: target must give a card; playing it does not skip the turn', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(5) });
  g.start();
  g.players[0].hand = [{ id: 'f', kind: 'favor' }, { id: 'd', kind: 'defuse' }];
  g.players[1].hand = [{ id: 'g1', kind: 'skip' }, { id: 'g2', kind: 'see' }];
  g.current = 0; g.phase = 'playing';
  const snap = g.applyAction(0, { kind: 'favor', cardId: 'f', targetSeat: 1 });
  assert.ok(snap.pendingFavor && snap.pendingFavor.target === 1, 'favor is pending');
  assert.equal(g.current, 0, 'turn NOT skipped while awaiting the give');
  const r = g.applyAction(1, { kind: 'give', cardId: 'g2' });
  assert.equal(r.pendingFavor, null, 'favor resolved');
  assert.ok(g.players[0].hand.some((c) => c.id === 'g2'), 'target card given to the favor player');
  assert.equal(g.players[1].hand.length, 1, 'target lost one card');
});

test('attack: the target must draw one extra card, and playing it does not skip the turn', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B'], random: mulberry32(6) });
  g.start();
  g.players[0].hand = [{ id: 'a', kind: 'attack' }];
  g.players[1].hand = [{ id: 'df', kind: 'defuse' }];
  g.drawPile = [{ id: 's1', kind: 'skip' }, { id: 's2', kind: 'see' }, { id: 's3', kind: 'shuffle' }, { id: 's4', kind: 'skip' }];
  g.current = 0; g.phase = 'playing';
  g.applyAction(0, { kind: 'attack', cardId: 'a', targetSeat: 1 });
  assert.equal(g.players[1].attack, 1, 'target marked for an extra draw');
  assert.equal(g.current, 0, 'attack does not skip the attacker turn');
  g.draw(0); // attacker must still draw; then advances to seat 1
  assert.equal(g.current, 1);
  const before = g.players[1].hand.length;
  g.draw(1); // seat 1 has an attack pending -> draws 2 cards
  assert.equal(g.players[1].hand.length, before + 2, 'target drew an extra card');
});

test('two shuffle cards reset the draw pile (discard merged back in)', () => {
  const g = new ExplodingKittensGame({ playerNames: ['A', 'B'], random: mulberry32(8) });
  g.start();
  g.players[0].hand = [{ id: 's1', kind: 'shuffle' }, { id: 's2', kind: 'shuffle' }, { id: 'd', kind: 'defuse' }];
  g.drawPile = [{ id: 'a', kind: 'see' }];
  g.discard = [{ id: 'x', kind: 'skip' }, { id: 'y', kind: 'explode' }];
  g.current = 0; g.phase = 'playing';
  const r = g.applyAction(0, { kind: 'shuffle2', cardIds: ['s1', 's2'] });
  assert.equal(g.players[0].hand.length, 1, 'two shuffle cards used, defuse kept');
  assert.equal(g.discard.length, 0, 'discard merged into the pile (reset)');
  assert.equal(g.drawPile.length, 5, 'pile = old pile + discard + 2 played shuffles');
  assert.equal(g.current, 0, 'reset does not skip the turn');
});
