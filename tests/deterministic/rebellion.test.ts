/**
 * 自动起义 / 外交宣称 / 守城民兵 / 原属国重占 闸门。
 *
 * 锁住：
 *   ① 动乱 100 自动起义，区域脱离原主，当地人口化为低战力民兵；
 *   ② 未归附起义区只有原属国能进攻，且必须杀光全部民兵才能占领；
 *   ③ 民心更高的相邻势力可宣称归附：动乱 90、最多 2 万守城民兵、不可调动；
 *   ④ 归附后 3 回合内征兵会再次起义；
 *   ⑤ 动乱 ≤50 恢复正常，守城头衔与锁定解除；
 *   ⑥ 快照/合法动作/拒绝码正确接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import { rebelTroopsInRegion, unitsIn, type GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';

const SEED = 'rebellion-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('grand-front', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (state: GameState): string => sha256(stableStringify(state));

function clone<T>(value: T): any {
  return JSON.parse(JSON.stringify(value)) as any;
}
function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}
function run(state: GameState, commands: readonly AcceptedOrder[] = [], turn = state.turn): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world: sc.world,
    modules: MODULES,
    orders: commands,
    rootSeed: SEED,
    turn,
    now: FIXED_NOW,
    digest,
  });
}

/** 找一块有外国邻居的领地，并强制其动乱到 100 */
function makeUprising(): {
  prev: any;
  state: any;
  rid: string;
  original: string;
  foreign: string;
} {
  const prev = clone(sc.initialState);
  let found: { rid: string; original: string; foreign: string } | null = null;
  for (const rid of Object.keys(prev.regions).sort()) {
    const original = prev.regions[rid]!.owner;
    if (!original) continue;
    const foreign = (sc.world.regions[rid]?.adjacency ?? [])
      .map((n) => prev.regions[n]?.owner)
      .find((o) => o && o !== original);
    if (foreign) { found = { rid, original, foreign }; break; }
  }
  assert.ok(found, '夹具失效：没有带外国邻居的领地');
  prev.regions[found.rid]!.unrest = 100;
  const out = run(prev);
  assert.deepEqual(out.rejected, []);
  return { prev, state: out.state, rid: found.rid, original: found.original, foreign: found.foreign! };
}

test('★动乱 100 自动起义：区域脱离原主，人口化为起义民兵', () => {
  const { state, rid, original } = makeUprising();
  const st = state.regions[rid]!;
  assert.equal(st.owner, null, '起义区不再属于原主');
  assert.equal(st.rebellion?.from, original);
  assert.equal(st.unrest, 100);
  const rebels = unitsIn(state, rid).filter((u) => u.title === 'rebel_militia');
  assert.equal(rebels.length, 1);
  assert.equal(rebels[0]!.ownerId, 'neutral');
  assert.equal(rebels[0]!.garrisonOnly, true);
  assert.ok(rebelTroopsInRegion(state, rid) > 0);
});

test('★起义区只有原属国能进攻；民兵未死光不能夺城', () => {
  const { state, rid, original, foreign } = makeUprising();
  const originalActs = enumerateLegalActions(state, sc.world, original, { maxActions: 5000, uncapped: true });
  assert.ok(originalActs.some((a) => a.kind === 'attack' && a.targetRegion === rid), '原属国必须能进攻起义区');
  assert.equal(originalActs.some((a) => a.kind === 'claim_rebellion'), false, '原属国不能“宣称”自己的起义区');

  const foreignActs = enumerateLegalActions(state, sc.world, foreign, { maxActions: 5000, uncapped: true });
  assert.equal(foreignActs.some((a) => a.kind === 'attack' && a.targetRegion === rid), false, '非原属国不得直接进攻未归附起义区');

  // 直接提交非原属国进攻命令也必须被 core 拒绝（从相邻的 foreign 领地出发）
  const staging = (sc.world.regions[rid]?.adjacency ?? []).find((n) => state.regions[n]?.owner === foreign);
  assert.ok(staging, '夹具失效：宣称国没有相邻领地');
  (state.units as any)['u_foreign_test'] = {
    id: 'u_foreign_test',
    ownerId: foreign,
    regionId: staging!,
    typeId: 'militia',
    troops: 5000,
    movedThisTurn: false,
  };
  const attacked = run(state, [order('s', foreign, { kind: 'attack', unitId: 'u_foreign_test', targetRegion: rid })]);
  assert.equal(attacked.rejected[0]?.code, 'REBELLION_NOT_YOURS');
});

test('★更高民心势力宣称归附：动乱 90，最多 2 万守城民兵且不可调动', () => {
  const { state, rid, foreign } = makeUprising();
  const claimant = foreign;
  const claimantState = state.factions[claimant]!;
  claimantState.morale = Math.max(claimantState.morale, state.factions[state.regions[rid]!.rebellion!.from]!.morale + 10);
  const acts = enumerateLegalActions(state, sc.world, claimant, { maxActions: 5000, uncapped: true });
  const claim = acts.find((a) => a.kind === 'claim_rebellion' && a.command['regionId'] === rid);
  assert.ok(claim, '更高民心的相邻势力必须能看到宣称动作');

  const out = run(state, [order('s', claimant, claim!.command)]);
  assert.deepEqual(out.rejected, []);
  const st = out.state.regions[rid]!;
  assert.equal(st.owner, claimant);
  assert.equal(st.unrest, sc.world.rebellion!.claimedUnrest);
  assert.equal(st.rebellion?.claimedBy, claimant);
  const garrison = unitsIn(out.state, rid).find((u) => u.title === 'rebel_garrison');
  assert.ok(garrison, '必须留下守城民兵');
  assert.ok(garrison!.troops <= sc.world.rebellion!.claimedGarrisonCap);
  assert.equal(garrison!.garrisonOnly, true);

  // 守城民兵不可移动/分兵/合兵
  const moveTarget = (sc.world.regions[rid]?.adjacency ?? []).find((n) => out.state.regions[n]?.owner === claimant);
  if (moveTarget) {
    const moved = run(out.state, [order('s', claimant, { kind: 'move_units', unitId: garrison!.id, toRegion: moveTarget })]);
    assert.equal(moved.rejected[0]?.code, 'GARRISON_LOCKED');
  }
  const split = run(out.state, [order('s', claimant, { kind: 'split_unit', unitId: garrison!.id, count: 500 })]);
  assert.equal(split.rejected[0]?.code, 'GARRISON_LOCKED');
});

test('★归附后 3 回合内征兵再次起义；动乱 ≤50 恢复正常', () => {
  const { state, rid, foreign } = makeUprising();
  const claimant = foreign;
  state.factions[claimant]!.morale = 100;
  state.factions[claimant]!.gold = 100_000;
  state.factions[claimant]!.food = 100_000;
  const claim = enumerateLegalActions(state, sc.world, claimant, { maxActions: 5000, uncapped: true })
    .find((a) => a.kind === 'claim_rebellion' && a.command['regionId'] === rid)!;
  let out = run(state, [order('s', claimant, claim.command)]);
  assert.deepEqual(out.rejected, []);
  const claimed = out.state;
  assert.equal(claimed.regions[rid]!.rebellion?.claimedTurn, claimed.turn);

  // 下一回合在该区征兵 → 自动再起义
  const recruit = { kind: 'recruit', regionId: rid, unitType: sc.world.rebellion!.rebelUnitType, count: 1000 };
  out = run(claimed, [order('s2', claimant, recruit)], claimed.turn + 1);
  const after = out.state.regions[rid]!;
  assert.equal(after.owner, null, '征兵触发再起义');
  assert.equal(after.rebellion?.from, claimant);
  assert.equal(after.rebellion?.claimedBy, undefined);
  assert.ok((out.events as DomainEvent[]).some((e) => e.type === 'rebellion_started' && e.cause === 'claimed_conscription'));
  assert.equal(unitsIn(out.state, rid).some((u) => u.ownerId === claimant), false, '征兵军被起义吞没');

  // 另取一份归附状态，把动乱压到 50 → 恢复正常
  const normalize = clone(claimed);
  normalize.regions[rid]!.unrest = 50;
  const ended = run(normalize);
  assert.equal(ended.state.regions[rid]!.rebellion, undefined);
  const normalGarrison = unitsIn(ended.state, rid).find((u) => u.title === 'rebel_garrison');
  assert.equal(normalGarrison, undefined, '恢复正常后头衔解除');
  assert.ok((ended.events as DomainEvent[]).some((e) => e.type === 'rebellion_ended' && e.reason === 'unrest_recovered'));
});

test('★原属国杀光全部民兵后重占：动乱钳到 90，起义状态清除', () => {
  const { state, rid, original } = makeUprising();
  const rebel = unitsIn(state, rid).find((u) => u.title === 'rebel_militia')!;
  (rebel as any).troops = 100;
  // 找一块与原起义区相邻的原属国区域，塞一支大军用于进攻
  const staging = (sc.world.regions[rid]?.adjacency ?? []).find((n) => state.regions[n]?.owner === original);
  assert.ok(staging, '夹具失效：原属国没有相邻集结区');
  (state.units as any)['u_test_avenger'] = {
    id: 'u_test_avenger',
    ownerId: original,
    regionId: staging!,
    typeId: 'militia',
    troops: 500_000,
    movedThisTurn: false,
  };
  // 第一次进攻：民兵溃散但未死光 ⇒ 不能夺城
  const first = run(state, [order('s', original, { kind: 'attack', unitId: 'u_test_avenger', targetRegion: rid })]);
  assert.deepEqual(first.rejected, []);
  assert.equal(first.state.regions[rid]!.owner, null, '民兵未死光不得重占');
  assert.ok(first.state.regions[rid]!.rebellion);

  // 把残余民兵压到 1，再进攻一次 ⇒ 全灭后重占
  const survivors = unitsIn(first.state, rid).filter((u) => u.title === 'rebel_militia');
  assert.ok(survivors.length > 0, '第一次进攻后应仍有残余民兵');
  (survivors[0] as any).troops = 1;
  const out = run(first.state, [order('s', original, { kind: 'attack', unitId: 'u_test_avenger', targetRegion: rid })], first.state.turn + 1);
  assert.deepEqual(out.rejected, []);
  const after = out.state.regions[rid]!;
  assert.equal(after.owner, original);
  assert.equal(after.rebellion, undefined);
  assert.equal(after.unrest, sc.world.rebellion!.originalReoccupyUnrest);
  assert.equal(unitsIn(out.state, rid).some((u) => u.title === 'rebel_militia'), false);
  assert.ok((out.events as DomainEvent[]).some((e) => e.type === 'rebellion_ended' && e.reason === 'reoccupied'));
});

test('★快照暴露起义状态与民兵头衔；行动列表含宣称', () => {
  const { state, rid } = makeUprising();
  const snap = buildSnapshot({
    state,
    world: sc.world,
    recipient: 'spec',
    viewer: null,
    digest: digest(state),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    maxLegalActions: 300,
  });
  const region = snap.regions.find((r) => r.id === rid)!;
  assert.ok(region.rebellion);
  assert.equal(region.rebellion!.original, state.regions[rid]!.rebellion!.from);
  assert.ok((region.rebellion!.rebelTroops ?? 0) > 0);
  assert.ok(region.stacks?.some((s) => s.title === 'rebel_militia'));
});

test('grand-front 的征兵/战火动乱高于共享旧值', () => {
  const low = sc.world.governance!.lowMoraleUnrest;
  assert.equal(low.recruitBase, 8);
  assert.equal(low.battleBase, 10);
  assert.equal(low.captureBase, 35);
  assert.equal(low.warDeclarationBase, 15);
  assert.equal(sc.world.rebellion?.levyRatio, 1);
  assert.equal(sc.world.rebellion?.claimedGarrisonCap, 20000);
  assert.equal(sc.world.rebellion?.normalizeUnrest, 50);
});
