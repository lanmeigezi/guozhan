// guozhan.test.js — the embedded no-LLM war game.
//
// What this guards:
//   1. registry/lobby wiring for the new built-in game;
//   2. simultaneous orders: both seats lock -> exactly one resolution;
//   3. fog-of-war: stacks only appear in fully visible regions;
//   4. same seed + same orders -> byte-identical report (deterministic replay);
//   5. bot batches are token-gated (a human cannot forge `gz_bot`);
//   6. the shipped engine contains no external LLM/network layer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getGame, GAMES } from '../src/games.js';
import { GuozhanGame, aiGuozhan, GZ_SCENARIOS } from '../src/guozhan.js';
import { Host } from '../src/host.js';

const ENGINE = readFileSync(new URL('../src/guozhan/engine.bundle.js', import.meta.url), 'utf8');

function start(seed = 'test-seed', scenario = 'random-front-v2', names = ['甲', '乙']) {
  const g = new GuozhanGame({ playerNames: names });
  g.start({ seed, scenario });
  return g;
}

test('guozhan is registered as a 2–12 player built-in', () => {
  assert.ok(GAMES.guozhan, 'GAMES.guozhan missing');
  const def = getGame('guozhan');
  assert.equal(def.key, 'guozhan');
  assert.equal(def.min, 2);
  assert.equal(def.max, 12);
  assert.equal(def.ai, aiGuozhan);
  assert.deepEqual(
    GZ_SCENARIOS.map((s) => s.id),
    ['random-front-v2', 'grand-front', 'iron-front', 'warring-states', 'warring-states-full', 'frontier'],
  );
  assert.ok(GZ_SCENARIOS.every((s) => s.factions.length >= 4));
});

test('grand-front starts 12 seats on a 100+ region map', () => {
  const names = Array.from({ length: 12 }, (_, i) => 'P' + i);
  const g = new GuozhanGame({ playerNames: names });
  g.start({ seed: 'grand-board-seed', scenario: 'grand-front' });
  const v = g.viewFor(0);
  assert.equal(v.factions.length, 12, '12 factions expected');
  assert.ok(v.map.regions.length >= 100, `large map should have 100+ regions, got ${v.map.regions.length}`);
  assert.equal(g.maxPlayers, 12);
});

test('start binds seats to factions and exposes a fog-projected view', () => {
  const g = start();
  assert.equal(g.phase, 'playing');
  assert.equal(g.session.turn, 1);
  const v0 = g.viewFor(0);
  assert.equal(v0.you, 0);
  assert.equal(v0.factionId, 'east');
  assert.equal(v0.phase, 'playing');
  assert.ok(v0.map.regions.length >= 20, 'map should have land regions');
  assert.ok(v0.actions.length > 10, 'human should have legal actions');
  assert.equal(v0.actions[0].command.kind, v0.actions[0].kind);
  // every projected region with restricted visibility must not leak stacks
  const leaks = v0.regions.filter((r) => r.visibility !== 'full' && r.stacks);
  assert.deepEqual(leaks.map((r) => r.id), [], 'fog leaked stacks outside full visibility');
  // own faction exact resources are present
  const self = v0.factions.find((f) => f.isSelf);
  assert.ok(self && self.exact && Number.isFinite(self.exact.gold));
});

test('terrain codex is shipped to the board UI', () => {
  const g = start();
  const v = g.viewFor(0);
  assert.ok(Array.isArray(v.map.terrain) && v.map.terrain.length >= 6, 'map.terrain missing');
  const mountain = v.map.terrain.find((t) => t.id === 'mountain');
  assert.ok(mountain, 'mountain terrain missing');
  assert.equal(mountain.moveCost, 3, 'mountain march cost');
  assert.equal(mountain.intelCost, 1.8, 'mountain intel cost');
  const forest = v.map.terrain.find((t) => t.id === 'forest');
  assert.equal(forest.infantryDefense, 1.15, 'forest infantry defense');
});

test('AI seats expose rush/turtle/random archetypes', () => {
  const g = start('archetypes');
  const v = g.viewFor(0);
  const styles = (v.factions || []).filter((f) => !f.isSelf && f.aiArchetype).map((f) => f.aiArchetype);
  assert.ok(styles.length >= 2, 'two AI seats should expose archetypes');
  assert.equal(new Set(styles).size, styles.length, '2 AI seats should not share an archetype');
  for (const style of styles) assert.ok(['rush', 'turtle', 'random'].includes(style), style);
});

test('both seats lock -> one simultaneous resolution and the turn advances', () => {
  const g = start('locks');
  const before = g.session.turn;
  const a0 = g.viewFor(0).actions[0];
  const a1 = g.viewFor(1).actions[0];
  g.applyAction(0, { kind: 'gz_order', actionId: a0.id });
  g.applyAction(1, { kind: 'gz_order', actionId: a1.id });
  assert.equal(g.viewFor(0).pendingOrders.length, 1);
  assert.equal(g.session.turn, before, 'submitting orders must not resolve');
  g.applyAction(0, { kind: 'gz_lock' });
  assert.equal(g.session.turn, before, 'one lock must wait for the other seat');
  g.applyAction(1, { kind: 'gz_lock' });
  assert.equal(g.session.turn, before + 1);
  assert.equal(g.phase, 'playing');
  assert.equal(g.last.turn, before);
  const v = g.viewFor(0);
  assert.equal(v.pendingOrders.length, 0);
  assert.equal(v.locked, false);
  assert.ok(v.report && v.report.turn === before);
  assert.ok(Array.isArray(v.report.events) && v.report.events.length > 0);
  // owner-only events are filtered; the all-faction raw delta event is dropped
  assert.equal(v.report.events.some((e) => e.type === 'turn_resolved'), false);
  assert.deepEqual(
    v.report.events.filter((e) => e.type === 'recruitment_completed' && e.factionId !== v.factionId),
    [],
    'recruitment events leaked from another faction',
  );
});

test('same seed + same orders = byte-identical report (deterministic replay)', () => {
  const run = () => {
    const g = start('replay-seed');
    for (const seat of [0, 1]) {
      const act = g.viewFor(seat).actions[0];
      g.applyAction(seat, { kind: 'gz_order', actionId: act.id });
      g.applyAction(seat, { kind: 'gz_lock' });
    }
    return JSON.stringify(g.last);
  };
  assert.equal(run(), run());
});

test('a human cannot forge a bot command batch', () => {
  const g = start('forge');
  g.applyAction(0, { kind: 'gz_lock' });
  const bot = aiGuozhan(g, 1);
  assert.ok(bot && bot.kind === 'gz_bot');
  assert.throws(
    () => g.applyAction(1, { kind: 'gz_bot', commands: bot.commands, token: 'wrong' }),
    (err) => err && err.code === 'NOT_AUTHORIZED',
  );
  // the genuine Host path still works
  g.applyAction(1, { kind: 'gz_bot', commands: bot.commands, token: bot.token });
  assert.equal(g.session.turn, 2);
});

test('unclaimed factions are driven automatically', () => {
  const g = start('auto-fill');
  const bindings = g.session.bindingsList();
  assert.equal(bindings.length, 2);
  // 4 factions, 2 seats -> the remaining 2 are AI and must already be locked
  const waiting = g.session.waitingSeats();
  assert.deepEqual(waiting, [0, 1], 'only seated players should be waited on');
  g.applyAction(0, { kind: 'gz_lock' });
  g.applyAction(1, { kind: 'gz_lock' });
  assert.equal(g.session.turn, 2, 'AI factions should have submitted and resolved');
});

test('fixed scenarios also start and resolve', () => {
  for (const scenario of ['iron-front', 'warring-states']) {
    const g = start('fixed', scenario, ['甲', '乙', '丙', '丁']);
    const v = g.viewFor(0);
    assert.equal(v.phase, 'playing');
    assert.ok(v.map.regions.length >= 19);
    for (let seat = 0; seat < 4; seat++) g.applyAction(seat, { kind: 'gz_lock' });
    assert.equal(g.session.turn, 2, `${scenario} did not advance`);
  }
});

test('shipped engine has no external LLM/network/Node layer', () => {
  for (const forbidden of [
    'clientFromEnv', 'AiAdvisor', 'api.openai.com', 'deepseek', 'anthropic',
    'node:', 'require("http")', 'XMLHttpRequest',
  ]) {
    assert.equal(ENGINE.includes(forbidden), false, `engine bundle contains ${forbidden}`);
  }
  assert.equal(/\bfetch\s*\(/.test(ENGINE), false, 'engine bundle contains fetch()');
  // sanity: the deterministic core really is in there
  for (const required of ['GuozhanSession', 'resolveTurn', 'enumerateLegalActions', 'deriveSelfReview']) {
    assert.ok(ENGINE.includes(required), `engine bundle missing ${required}`);
  }
  // build artifacts should not be accidentally empty
  assert.ok(ENGINE.length > 200_000, 'engine bundle looks truncated');
  assert.ok(readFileSync(new URL('../src/guozhan.js', import.meta.url), 'utf8').includes('GZ_SCENARIOS'));
});

test('optional unlimited turns uses maxTurns=0 and exposes it to the UI', () => {
  const g = new GuozhanGame({ playerNames: ['甲', '乙'] });
  g.start({ seed: 'unlimited-ui', scenario: 'random-front-v2', unlimitedTurns: true });
  assert.equal(g.session.maxTurns, 0);
  assert.equal(g.viewFor(0).scenario.maxTurns, 0);
  assert.equal(g.phase, 'playing');
});

test('without the unlimited option the scenario cap is preserved', () => {
  const g = new GuozhanGame({ playerNames: ['甲', '乙'] });
  g.start({ seed: 'capped-ui', scenario: 'random-front-v2' });
  assert.ok(g.session.maxTurns > 0);
  assert.ok(g.viewFor(0).scenario.maxTurns > 0);
});

test('房间重建沿用上次选的剧本（不会悄悄回到默认六角图）', () => {
  const host = new Host({ game: 'guozhan', playerName: '房主' });
  try {
    host.addBot('AI');
    const r = host.execute(host.hostSeat, { t: 'act', kind: 'start', scenario: 'warring-states-full', seed: 'scenario-keep' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(host.game.scenarioId, 'warring-states-full');
    host.resetRound();
    assert.equal(host.game.phase, 'lobby');
    assert.equal(host.game.scenarioId, 'warring-states-full', '重建后剧本不能回到默认图');
  } finally {
    host.stopLlmLoop?.();
  }
});
