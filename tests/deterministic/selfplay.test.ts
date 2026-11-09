/**
 * 自我复盘 / 策略迭代闸门。
 *
 * 锁住：
 *   ① 上回合失地、进攻失败、命令被拒 → 下一回合提高进攻门槛与守备权重；
 *   ② 粮草/民心/动乱/情报缺口 → 产出对应 lessons 与税率/基建/谍报策略；
 *   ③ 启发式真的消费这些策略参数（基建、谍报、税率、maxCommands）；
 *   ④ 复盘只给自己席位，观战端不拿别人的复盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario } from '../../src/server/config-loader.ts';
import { deriveSelfReview } from '../../src/ai/selfplay.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import { SnapshotSchema } from '../../src/protocol/snapshot.ts';
import { sha256, stableStringify } from '../../src/server/config-loader.ts';
import { decideHeuristic, PROFILES } from '../../src/ai/heuristic.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import type { AiPolicy } from '../../src/protocol/snapshot.ts';
import { relationKey } from '../../src/core/state.ts';

const sc = loadScenario('random-front-v2', 'selfplay-seed-0001', 'config');
const fid = Object.keys(sc.initialState.factions).sort()[0]!;
const other = Object.keys(sc.initialState.factions).find((x) => x !== fid)!;

function policy(overrides: Partial<AiPolicy> = {}): AiPolicy {
  return {
    attackRatio: 99,
    defenseBias: 0,
    infraBias: 0,
    spyBias: 0,
    taxTarget: sc.initialState.factions[fid]!.taxRate,
    lawBias: 0,
    maxCommands: 6,
    ...overrides,
  };
}

function previousFacts(overrides: {
  captured?: boolean;
  lost?: boolean;
  attackLost?: boolean;
  rejected?: number;
  gold?: number;
  food?: number;
  morale?: number;
} = {}) {
  const events: unknown[] = [];
  if (overrides.captured) events.push({ type: 'region_captured', to: fid, from: other, regionId: 'h01' });
  if (overrides.lost) events.push({ type: 'region_captured', to: other, from: fid, regionId: 'h02' });
  if (overrides.attackLost) {
    events.push({
      type: 'combat_resolved',
      evidence: { attacker: { factionId: fid }, defender: { factionId: other }, outcome: 'defender_win' },
    });
  }
  return {
    turn: 1,
    events,
    baseline: [
      { scope: `faction:${fid}`, field: 'gold', delta: overrides.gold ?? 0 },
      { scope: `faction:${fid}`, field: 'food', delta: overrides.food ?? 0 },
      { scope: `faction:${fid}`, field: 'morale', delta: overrides.morale ?? 0 },
    ],
    rejectedForSeat: overrides.rejected ?? 0,
  };
}

test('★失地 + 进攻失败 + 命令被拒 ⇒ 提高进攻门槛/守备权重，并给出复盘 lesson', () => {
  const review = deriveSelfReview({
    state: sc.initialState,
    world: sc.world,
    factionId: fid,
    aggression: 0.5,
    previous: previousFacts({ lost: true, attackLost: true, rejected: 2 }),
  });
  assert.equal(review.metrics.regionsLost, 1);
  assert.equal(review.metrics.attacksLost, 1);
  assert.equal(review.metrics.rejectedCommands, 2);
  assert.ok(review.policy!.attackRatio > 1.4, `失败后进攻门槛应提高：${review.policy!.attackRatio}`);
  assert.ok(review.policy!.defenseBias >= 0.5, `失地后守备权重应提高：${review.policy!.defenseBias}`);
  assert.ok(review.lessons.some((l) => l.includes('失守')));
  assert.ok(review.lessons.some((l) => l.includes('进攻失利')));
  assert.ok(review.lessons.some((l) => l.includes('被拒')));
});

test('★得地/进攻得手 ⇒ 略微降低进攻门槛，但不低于 0.9', () => {
  const review = deriveSelfReview({
    state: sc.initialState,
    world: sc.world,
    factionId: fid,
    aggression: 0.9,
    previous: previousFacts({ captured: true }),
  });
  assert.equal(review.metrics.regionsGained, 1);
  assert.ok(review.policy!.attackRatio < 1.05);
  assert.ok(review.policy!.attackRatio >= 0.9);
  assert.ok(review.lessons.some((l) => l.includes('得手')));
});

test('粮草/民心/动乱 → 降低税率、提高基建权重；战争无情报 → 提高谍报权重', () => {
  const low = {
    ...sc.initialState,
    factions: {
      ...sc.initialState.factions,
      [fid]: { ...sc.initialState.factions[fid]!, food: -100, morale: 35 },
    },
    regions: Object.fromEntries(
      Object.entries(sc.initialState.regions).map(([rid, r]) => [
        rid,
        r.owner === fid ? { ...r, unrest: 70 } : r,
      ]),
    ),
  };
  const review = deriveSelfReview({
    state: low,
    world: sc.world,
    factionId: fid,
    aggression: 0.9,
    previous: previousFacts({ food: -2000 }),
  });
  assert.ok(review.policy!.taxTarget <= 0.2, `粮尽/低民心应压税：${review.policy!.taxTarget}`);
  assert.ok(review.policy!.infraBias >= 0.7, `高动乱应提高基建权重：${review.policy!.infraBias}`);
  assert.ok(review.lessons.some((l) => l.includes('粮草')));
  assert.ok(review.lessons.some((l) => l.includes('民心')));
  assert.ok(review.lessons.some((l) => l.includes('动乱')));

  const warState = {
    ...low,
    relations: {
      ...low.relations,
      [relationKey(fid, other)]: { kind: 'war' as const, sinceTurn: 0 },
    },
    factions: {
      ...low.factions,
      [fid]: { ...low.factions[fid]!, intel: {} },
    },
  };
  const warReview = deriveSelfReview({
    state: warState,
    world: sc.world,
    factionId: fid,
    aggression: 0.9,
    previous: previousFacts(),
  });
  assert.ok(warReview.policy!.spyBias >= 0.6, `交战无情报应提高谍报权重：${warReview.policy!.spyBias}`);
  assert.ok(warReview.lessons.some((l) => l.includes('情报')));
});

test('★国库充足时目标税率回到 20% 中性；国库告急才加税', () => {
  const rich = structuredClone(sc.initialState) as any;
  rich.factions[fid]!.gold = 5000;
  rich.factions[fid]!.morale = 80;
  const richReview = deriveSelfReview({
    state: rich,
    world: sc.world,
    factionId: fid,
    aggression: 0.5,
    previous: previousFacts({ gold: 5000 }),
  });
  assert.equal(richReview.policy!.taxTarget, 0.2, '国库充足不应长期背高税民心惩罚');

  const poor = structuredClone(sc.initialState) as any;
  poor.factions[fid]!.gold = 100;
  poor.factions[fid]!.morale = 80;
  poor.factions[fid]!.food = 5000;
  for (const rid of Object.keys(poor.regions)) {
    if (poor.regions[rid].owner === fid) poor.regions[rid].unrest = 0;
  }
  const poorReview = deriveSelfReview({
    state: poor,
    world: sc.world,
    factionId: fid,
    aggression: 0.5,
    previous: previousFacts(),
  });
  assert.ok(poorReview.policy!.taxTarget >= 0.5, `国库告急应加税：${poorReview.policy!.taxTarget}`);
});

test('★启发式消费策略：高基建权重会修基建，高谍报权重会派间谍，税率目标会改税', () => {
  const legal = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 90 });
  const profile = PROFILES['balanced']!;

  const infra = decideHeuristic(sc.initialState, sc.world, fid, profile, [], legal, policy({ infraBias: 1 }));
  assert.ok(
    infra.commands.some((c) => (c.command as { kind: string }).kind === 'build_infrastructure'),
    `高 infraBias 必须修基建：${infra.rationale}`,
  );

  const spy = decideHeuristic(sc.initialState, sc.world, fid, profile, [], legal, policy({ spyBias: 1 }));
  assert.ok(
    spy.commands.some((c) => (c.command as { kind: string }).kind === 'send_spy'),
    `高 spyBias 必须派间谍：${spy.rationale}`,
  );

  const taxTarget = sc.initialState.factions[fid]!.taxRate >= 0.45 ? 0.2 : 0.5;
  const tax = decideHeuristic(sc.initialState, sc.world, fid, profile, [], legal, policy({ taxTarget }));
  assert.ok(
    tax.commands.some((c) => (c.command as { kind: string }).kind === 'set_tax'),
    `税率目标 ${taxTarget} 必须产生 set_tax：${tax.rationale}`,
  );
});

test('★复盘随快照只下发给本席位，且过协议 schema', () => {
  const review = deriveSelfReview({
    state: sc.initialState,
    world: sc.world,
    factionId: fid,
    aggression: 0.5,
    previous: previousFacts({ lost: true }),
  });
  const digest = sha256(stableStringify(sc.initialState));
  const self = buildSnapshot({
    state: sc.initialState,
    world: sc.world,
    recipient: fid,
    viewer: fid,
    digest,
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    selfReview: review,
  });
  assert.deepEqual(self.selfReview, review);
  SnapshotSchema.parse(self);

  const spectator = buildSnapshot({
    state: sc.initialState,
    world: sc.world,
    recipient: 'spectator',
    viewer: null,
    digest,
    alerts: [],
    tokenUsed: 0,
    tokenCap: 0,
  });
  assert.equal(spectator.selfReview, undefined, '观战端不得拿到某个席位的复盘');
  SnapshotSchema.parse(spectator);
});

test('策略的 maxCommands 被严格遵守，且命令仍全部来自合法动作空间', () => {
  const legal = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 90 });
  const ids = new Set(legal.map((a) => a.id));
  const d = decideHeuristic(sc.initialState, sc.world, fid, PROFILES['aggressive']!, [], legal, policy({ maxCommands: 3, infraBias: 1, spyBias: 1 }));
  assert.ok(d.commands.length <= 3, `maxCommands=3 实得 ${d.commands.length}`);
  for (const c of d.commands) assert.ok(ids.has(c.legalActionId), `自造动作 ${c.legalActionId}`);
});
