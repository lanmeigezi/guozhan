/**
 * 本轮三条规则的回归闸门：
 *   ① 地块起义后 15 回合内不能再次自动叛乱（冷却从「爆发回合」起算，重占/归附后仍有效）；
 *      唯一例外是「归附后立即征兵」，且每次真正爆发会重置冷却起点。
 *   ② 发动战争只扣发动方 5 民心；该场战争的战胜增益累计最多回补 5，
 *      不能靠打仗刷民心（战争净收益 ≤ 0）。
 *   ③ 被攻击方在丢失地块之前，不因与该国交战而降低民心；失守 −8 是失地代价。
 *   ④ 未启用 governance.warMorale 的旧剧本行为逐字不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { rebellionModule } from '../../src/core/modules/rebellion.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import {
  isRebellionOnCooldown,
  rebellionCooldownRemaining,
  relationKey,
  warMoraleParams,
  type GameState,
} from '../../src/core/state.ts';
import type { AcceptedOrder, DeltaRecord, Mutation, ResolveContext } from '../../src/core/module.ts';

const SEED = 'war-morale-cooldown-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('grand-front', SEED, 'config');
const legacy = loadScenario('random-front-v2', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const LEGACY_MODULES = buildModules(legacy.meta.moduleOrder);
const digest = (s: GameState): string => sha256(stableStringify(s));
const COOLDOWN = sc.world.rebellion!.rebellionCooldownTurns;
const WM = sc.world.governance!.warMorale!;

function clone<T>(value: T): any {
  return JSON.parse(JSON.stringify(value)) as any;
}
function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: String(command['kind']), index: 0 } as AcceptedOrder;
}
function run(
  state: GameState,
  world = sc.world,
  modules = MODULES,
  commands: readonly AcceptedOrder[] = [],
  turn = state.turn,
): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world,
    modules,
    orders: commands,
    rootSeed: SEED,
    turn,
    now: FIXED_NOW,
    digest,
  });
}
const deltasOf = (out: ReturnType<typeof resolveTurn>): readonly DeltaRecord[] => out.deltas;
const eventsOf = (out: ReturnType<typeof resolveTurn>): Array<{ type: string; cause?: string }> =>
  out.events as Array<{ type: string; cause?: string }>;

/** 只跑起义模块：绕开 economy 的动乱衰减，精确验证「冷却是否压住起义」 */
function rebellionOnly(state: GameState, turn: number, orders: readonly AcceptedOrder[] = []) {
  const mutations: Mutation[] = [];
  const events: Array<{ type: string; cause?: string }> = [];
  const rejected: string[] = [];
  const ctx = {
    state,
    world: sc.world,
    orders,
    turn,
    now: FIXED_NOW,
    rootSeed: SEED,
    rng: () => { throw new Error('起义模块不应使用 rng'); },
    mutate: (m: Mutation) => mutations.push(m),
    emit: (e: unknown) => events.push(e as { type: string; cause?: string }),
    reject: (_o: AcceptedOrder, code: string) => rejected.push(code),
    recordDelta: () => {},
    deltas: [],
  } as unknown as ResolveContext;
  rebellionModule.resolve(ctx);
  return { mutations, events, rejected };
}

function firstOwnedRegion(state: GameState): { rid: string; owner: string } {
  const rid = Object.keys(state.regions).sort().find((r) => state.regions[r]!.owner !== null)!;
  return { rid, owner: state.regions[rid]!.owner! };
}

/** 找一条打向真实敌国（非中立、非自己）的合法进攻 */
function findEnemyAttack(state: GameState, needDefenders = false) {
  for (const fid of Object.keys(state.factions).sort()) {
    const acts = enumerateLegalActions(state, sc.world, fid, { maxActions: 5000, uncapped: true });
    const action = acts.find((a) => {
      if (a.kind !== 'attack') return false;
      const rid = String(a.command['targetRegion']);
      const owner = state.regions[rid]?.owner;
      if (owner == null || owner === fid) return false;
      if (!needDefenders) return true;
      return Object.values(state.units).some((u) => u.regionId === rid && u.ownerId === owner && u.troops > 0);
    });
    if (!action) continue;
    const rid = String(action.command['targetRegion']);
    return { fid, rid, defender: state.regions[rid]!.owner!, action };
  }
  throw new Error('夹具失效：找不到打向敌国的合法进攻');
}

/** grand-front 开局自带几组交战关系；要让「进攻即宣战」成立，先把这对关系清成非战争 */
function clearWarRelation(state: GameState, a: string, b: string): void {
  delete (state.relations as Record<string, unknown>)[relationKey(a, b)];
}

// ─────────────────────────────────────────────────────────────
// ① 叛乱冷却
// ─────────────────────────────────────────────────────────────

test('配置接线：grand-front 冷却 15 / 宣战 −5 回补 ≤5；旧治理剧本不启用战争民心', () => {
  assert.equal(COOLDOWN, 15);
  assert.deepEqual({ ...WM }, { declarationCost: 5, victoryGainCap: 5 });
  assert.equal(legacy.world.governance?.warMorale, undefined, '共享 governance.json 不得启用新机制');
  assert.equal(warMoraleParams(legacy.world), null);
  assert.ok(warMoraleParams(sc.world));
});

test('冷却口径：爆发 T 后 T+1…T+15 被压住，T+16 恢复', () => {
  const T = 20;
  const region = { lastRebellionTurn: T };
  assert.equal(rebellionCooldownRemaining(region, T, COOLDOWN), 0, '爆发当回合由 rebellion 状态本身挡住');
  assert.equal(rebellionCooldownRemaining(region, T + 1, COOLDOWN), 15);
  assert.equal(rebellionCooldownRemaining(region, T + 15, COOLDOWN), 1);
  assert.equal(rebellionCooldownRemaining(region, T + 16, COOLDOWN), 0);
  assert.equal(isRebellionOnCooldown(region, T + 15, COOLDOWN), true);
  assert.equal(isRebellionOnCooldown(region, T + 16, COOLDOWN), false);
  assert.equal(rebellionCooldownRemaining({}, 99, COOLDOWN), 0, '旧存档没有起点 ⇒ 不受限');
});

test('★冷却期内动乱满 100 也不再自动起义；过了 15 回合立刻恢复判定', () => {
  const state: GameState = clone(sc.initialState);
  const { rid } = firstOwnedRegion(state);
  const T = state.turn + 20;
  (state.regions[rid] as any).unrest = 100;
  delete (state.regions[rid] as any).rebellion;

  // 冷却中（爆发于 T-3 / 边界 T-15）：一律压住
  for (const last of [T - 3, T - 15]) {
    (state.regions[rid] as any).lastRebellionTurn = last;
    const r = rebellionOnly(state, T);
    assert.equal(r.events.filter((e) => e.type === 'rebellion_started').length, 0, `T-${T - last} 仍在冷却`);
    assert.equal(r.mutations.some((m) => m.op === 'set_region_owner' && m.owner === null), false);
  }

  // 对照 1：没有冷却起点 ⇒ 同回合必须起义，且把起点落库、事件带 cooldownTurns
  delete (state.regions[rid] as any).lastRebellionTurn;
  const fresh = rebellionOnly(state, T);
  const started = fresh.events.filter((e) => e.type === 'rebellion_started');
  assert.equal(started.length, 1);
  const rebMutation = fresh.mutations.find((m) => m.op === 'set_region_rebellion') as Extract<
    Mutation,
    { op: 'set_region_rebellion' }
  >;
  assert.equal(rebMutation.lastRebellionTurn, T, '每次爆发起义都要重置冷却起点');
  assert.ok(rebMutation.rebellion, '起义状态要落地');

  // 对照 2：冷却已过期（T-16）⇒ 恢复判定
  (state.regions[rid] as any).lastRebellionTurn = T - 16;
  assert.equal(rebellionOnly(state, T).events.filter((e) => e.type === 'rebellion_started').length, 1);
});

test('★例外：冷却期内「归附后立即征兵」仍能再起义，并重置冷却起点', () => {
  const state: GameState = clone(sc.initialState);
  const { rid, owner } = firstOwnedRegion(state);
  const T = state.turn + 10;
  (state.regions[rid] as any).unrest = 90; // 高于 normalizeUnrest，不会被先一步恢复正常
  (state.regions[rid] as any).rebellion = {
    from: 'someone_else',
    sinceTurn: T - 8,
    claimedBy: owner,
    claimedTurn: T - 1,
  };
  (state.regions[rid] as any).lastRebellionTurn = T - 5; // 冷却中
  assert.equal(isRebellionOnCooldown(state.regions[rid]!, T, COOLDOWN), true);

  const recruit = order('s', owner, {
    kind: 'recruit',
    regionId: rid,
    unitType: sc.world.rebellion!.rebelUnitType,
    count: 1000,
  });
  const r = rebellionOnly(state, T, [recruit]);
  assert.equal(
    r.events.filter((e) => e.type === 'rebellion_started' && e.cause === 'claimed_conscription').length,
    1,
    '立即征兵是冷却唯一例外',
  );
  const rebMutation = r.mutations.find((m) => m.op === 'set_region_rebellion') as Extract<
    Mutation,
    { op: 'set_region_rebellion' }
  >;
  assert.equal(rebMutation.lastRebellionTurn, T, '再起义也要重置冷却起点');

  // 不征兵 ⇒ 冷却期内不动
  assert.equal(rebellionOnly(state, T).events.filter((e) => e.type === 'rebellion_started').length, 0);
});

test('全链路：起义把冷却起点落库，快照把「还剩几回合」下发给右侧区域详情', () => {
  const state: GameState = clone(sc.initialState);
  const { rid, owner } = firstOwnedRegion(state);
  (state.regions[rid] as any).unrest = 100;
  // 避免高动乱的其他区同回合一起起义干扰断言
  for (const [id, r] of Object.entries(state.regions)) {
    if (id !== rid && r.owner === owner) (r as any).unrest = 0;
  }
  const out = run(state);
  const after = out.state.regions[rid]!;
  assert.ok(after.rebellion, '夹具失效：该区应起义');
  assert.equal(after.lastRebellionTurn, state.turn, '冷却起点必须落库');

  const snap = buildSnapshot({
    state: out.state,
    world: sc.world,
    recipient: 'spec',
    viewer: null,
    digest: digest(out.state),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    maxLegalActions: 300,
  });
  // 快照按「下一回合」下发（房间层会把 state.turn 推进 1）
  const nextTurnState = { ...out.state, turn: out.state.turn + 1 } as GameState;
  const snapNext = buildSnapshot({
    state: nextTurnState,
    world: sc.world,
    recipient: 'spec',
    viewer: null,
    digest: digest(nextTurnState),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    maxLegalActions: 300,
  });
  assert.ok(snap.regions.find((r) => r.id === rid));
  const cd = snapNext.regions.find((r) => r.id === rid)!.rebellionCooldown;
  assert.ok(cd, '右侧要能拿到冷却状态');
  assert.equal(cd!.totalTurns, COOLDOWN);
  assert.equal(cd!.remainingTurns, COOLDOWN, '下一回合还剩整整 15 回合');
  assert.equal(cd!.lastRebellionTurn, state.turn);
});

// ─────────────────────────────────────────────────────────────
// ②③ 战争民心
// ─────────────────────────────────────────────────────────────

test('★主动宣战：只扣发动方 5 民心，账本挂在关系上；被攻击方不扣', () => {
  const state: GameState = clone(sc.initialState);
  const [a, b] = Object.keys(state.factions).sort().slice(0, 2) as [string, string];
  const out = run(state, sc.world, MODULES, [order('s', a, { kind: 'diplomacy', to: b, action: 'declare_war' })]);
  const d = deltasOf(out);
  const cost = d.filter((x) => x.scope === `faction:${a}` && x.field === 'morale' && x.reason === '宣战失民');
  assert.equal(cost.length, 1, '发动方记一笔宣战损失');
  assert.equal(cost[0]!.delta, -WM.declarationCost);
  assert.equal(
    d.some((x) => x.scope === `faction:${b}` && x.reason === '宣战失民'),
    false,
    '被攻击方不因交战掉民心',
  );
  const rel = out.state.relations[relationKey(a, b)]!;
  assert.equal(rel.kind, 'war');
  assert.equal(rel.warMoraleInitiator, a);
  assert.equal(rel.warMoraleRemaining, WM.victoryGainCap);
});

test('★战胜回补累计封顶：攻取 +5 用满额度，收复故土 +6 被钳成 0', () => {
  const state: GameState = clone(sc.initialState);
  const atk = findEnemyAttack(state);
  clearWarRelation(state, atk.fid, atk.defender); // 让本回合真的「进攻即宣战」
  // 清空守军 → 必胜；标记旧土 → 同时触发 +5 与 +6
  for (const [uid, u] of Object.entries(state.units)) {
    if (u.regionId === atk.rid && u.ownerId === atk.defender) delete (state.units as any)[uid];
  }
  (state.regions[atk.rid] as any).lastOwner = atk.fid;
  const out = run(state, sc.world, MODULES, [
    order('s', atk.fid, { ...atk.action.command, commitment: 1 }),
  ]);
  assert.ok(eventsOf(out).some((e) => e.type === 'region_captured'), '夹具失效：应夺城');
  const d = deltasOf(out);
  const declaration = d.find((x) => x.scope === `faction:${atk.fid}` && x.reason === '宣战失民');
  assert.ok(declaration && declaration.delta === -WM.declarationCost, '进攻即宣战也要扣 5');

  const capture = d.find((x) => x.scope === `faction:${atk.fid}` && /攻取/.test(x.reason));
  assert.ok(capture && capture.delta === 5, '首场胜仗回补 +5');
  const recapture = d.find((x) => x.scope === `faction:${atk.fid}` && /收复故土/.test(x.reason));
  assert.equal(recapture, undefined, '额度用尽后 +6 必须被钳成 0，不产生增量');

  const rel = out.state.relations[relationKey(atk.fid, atk.defender)]!;
  assert.equal(rel.warMoraleInitiator, atk.fid);
  assert.equal(rel.warMoraleRemaining, 0, '额度逐条扣减到 0');
  // 净收益 = −5 + 5 = 0：战争最多把宣战损失补回来
  const warDeltas = d.filter(
    (x) => x.scope === `faction:${atk.fid}` && x.field === 'morale' &&
      (x.reason === '宣战失民' || /攻取|收复故土|守住/.test(x.reason)),
  );
  assert.equal(warDeltas.reduce((s, x) => s + x.delta, 0), 0);
});

test('★被攻击方守城成功：不掉民心，仍有 +3 士气；宣战损失只归发动方', () => {
  const state: GameState = clone(sc.initialState);
  const atk = findEnemyAttack(state, true);
  clearWarRelation(state, atk.fid, atk.defender);
  const unitId = String(atk.action.command['unitId']);
  (state.units[unitId] as { troops: number }).troops = 1; // 破不了城
  const out = run(state, sc.world, MODULES, [
    order('s', atk.fid, { ...atk.action.command, commitment: 0.1 }),
  ]);
  assert.equal(eventsOf(out).some((e) => e.type === 'region_captured'), false, '夹具失效：不该夺城');
  const d = deltasOf(out);
  assert.ok(d.some((x) => x.scope === `faction:${atk.fid}` && x.reason === '宣战失民'), '发动方付代价');
  assert.equal(
    d.some((x) => x.scope === `faction:${atk.defender}` && x.reason === '宣战失民'),
    false,
  );
  assert.equal(
    d.some((x) => x.scope === `faction:${atk.defender}` && /失守/.test(x.reason)),
    false,
    '没丢地就不该有失守惩罚',
  );
  const hold = d.find((x) => x.scope === `faction:${atk.defender}` && /士气大振/.test(x.reason));
  assert.ok(hold && hold.delta === 3, '守城 +3 保持原样');
  assert.ok(
    out.state.factions[atk.defender]!.morale >= state.factions[atk.defender]!.morale,
    '失地之前民心不得因这场战争下降',
  );
});

test('旧治理剧本：宣战不扣民心，夺城 +5 / 收复 +6 原封不动', () => {
  const state: GameState = clone(legacy.initialState);
  const [a, b] = Object.keys(state.factions).sort().slice(0, 2) as [string, string];
  const out = run(state, legacy.world, LEGACY_MODULES, [
    order('s', a, { kind: 'diplomacy', to: b, action: 'declare_war' }),
  ]);
  assert.equal(deltasOf(out).some((x) => x.reason === '宣战失民'), false);
  assert.equal(out.state.relations[relationKey(a, b)]?.warMoraleInitiator, undefined);
});
