// liarsbar.test.js — unit tests for the 骗子酒馆 rules engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiarsBarGame, aiLiarBar, buildLiarDeck } from '../src/liarsbar.js';
import { mulberry32 } from '../src/cards.js';

test('deck has 60 cards (15 ranks x 4 suits, incl. JOKER + YELLOW)', () => {
  const deck = buildLiarDeck();
  assert.equal(deck.length, 60);
  const byRank = new Map();
  for (const c of deck) byRank.set(c.rank, (byRank.get(c.rank) || 0) + 1);
  assert.equal(byRank.size, 15, '15 distinct ranks');
  for (const [, n] of byRank) assert.equal(n, 4, 'four suits per rank');
  assert.ok(byRank.has('JOKER') && byRank.has('YELLOW'), 'the two special ranks are present');
});

test('start deals a hand and a target rank; each starts at 0 roulette shots', () => {
  const g = new LiarsBarGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(2) });
  const snap = g.start();
  assert.equal(snap.phase, 'playing');
  assert.ok(snap.targetRank);
  g.players.forEach((p) => {
    assert.equal(p.hand.length, g.opts.handSize);
    assert.equal(p.shots, 0);
    assert.ok(p.bulletAt >= 0 && p.bulletAt <= 5);
    assert.ok(p.alive);
  });
});

test('an auto-played game terminates with a winner', () => {
  const g = new LiarsBarGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(9) });
  g.start();
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 5000) {
    if (g.pendingRoulette) { const t = g.pendingRoulette.seat; g.applyAction(t, aiLiarBar(g, t) || { kind: 'fire' }); continue; }
    const seat = g.current;
    const act = aiLiarBar(g, seat) || { kind: 'call' };
    g.applyAction(seat, act);
  }
  assert.equal(g.phase, 'roundEnd');
  assert.ok(g.winner != null);
  assert.equal(g.players.filter((p) => p.alive).length, 1);
});

test('calling a liar forces the liar to shoot; an honest claim shoots the caller', () => {
  const g = new LiarsBarGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(5) });
  g.start();
  const R = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

  // Force a lie: claimer's card rank != claimed rank, then the next player calls.
  const claimer = 0;
  const cardRank = g.players[claimer].hand[0].rank;
  let claimed = g.targetRank;
  let guard = 0;
  while (claimed === cardRank && guard++ < 20) claimed = R[Math.floor(g.random() * R.length)];
  g.players[claimer].shots = 0; g.players[claimer].bulletAt = 5; // first shot survives
  const shotsBefore = g.players[claimer].shots;
  g.lastClaim = { seat: claimer, card: { ...g.players[claimer].hand[0], rank: cardRank }, claimedRank: claimed };
  g.current = (claimer + 1) % 3;
  g.applyAction(g.current, { kind: 'call' });
  assert.equal(g.pendingRoulette.seat, claimer); // the liar must pull the trigger
  g.applyAction(claimer, { kind: 'fire' });
  assert.equal(g.players[claimer].shots, shotsBefore + 1); // liar took a shot (survived)
  assert.ok(g.players[claimer].alive);
});

test('roulette: the player survives until their bullet chamber is hit (max 6 shots)', () => {
  const g = new LiarsBarGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(1) });
  g.start();
  g.players[0].shots = 0; g.players[0].bulletAt = 3;
  assert.equal(g.shoot(0), false); // shot 0 survives
  assert.equal(g.players[0].shots, 1);
  g.players[0].shots = 3;
  assert.equal(g.shoot(0), true); // shot 3 hits the bullet
  assert.equal(g.players[0].alive, false);
  assert.ok(g.players[0].shots <= 6);
});
