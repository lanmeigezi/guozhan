/**
 * 将领系统闸门（只启用于 warring-states-full）。
 *
 * 锁住：
 *   ① 名册只收史料可考的真实人物，每条特征都有出处；韩国记载稀薄要明说；
 *   ② 开局一人一军、将领与部队同国，名册进 contentHash；
 *   ③ 战力乘数实战与 UI 预估同源、战报证据可复算；攻城乘数只在攻方生效；
 *   ④ 调任：一人一军、不复活、不跨势力、不覆盖已有将领；行军加成 UI/结算同源；
 *   ⑤ 迷雾：名册公开但不含部署，敌方将领部署不泄漏；
 *   ⑥ 旧剧本（含经典版兼容基线）行为与 hash 不变，同种子重放一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { estimateBattle } from '../../src/core/modules/combat.ts';
import { reachableRegions } from '../../src/core/modules/movement.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import {
  generalCombatMultiplier,
  generalMovementBudget,
  type GameState,
} from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SEED = 'generals-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('warring-states-full', SEED, 'config');
const legacy = loadScenario('warring-states', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (s: GameState): string => sha256(stableStringify(s));

function clone<T>(value: T): any {
  return JSON.parse(JSON.stringify(value)) as any;
}
function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: String(command['kind']), index: 0 } as AcceptedOrder;
}
function run(
  state: GameState,
  commands: readonly AcceptedOrder[] = [],
  turn = state.turn,
): ReturnType<typeof resolveTurn> {
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
const eventsOf = (out: ReturnType<typeof resolveTurn>): Array<Record<string, any>> =>
  out.events as Array<Record<string, any>>;

/** 找一条打向真实敌国、且守军可清空的合法进攻 */
function firstEnemyAttack(state: GameState) {
  for (const fid of Object.keys(state.factions).sort()) {
    const acts = enumerateLegalActions(state, sc.world, fid, { maxActions: 5000, uncapped: true });
    const action = acts.find((a) => {
      if (a.kind !== 'attack') return false;
      const rid = String(a.command['targetRegion']);
      const owner = state.regions[rid]?.owner;
      return owner != null && owner !== fid;
    });
    if (!action) continue;
    const rid = String(action.command['targetRegion']);
    return { fid, rid, defender: state.regions[rid]!.owner!, unitId: String(action.command['unitId']), action };
  }
  throw new Error('夹具失效：找不到打向敌国的合法进攻');
}

// ─────────────────────────────────────────────────────────────
// ① 史料名册
// ─────────────────────────────────────────────────────────────

test('★名册：16 位史料可考将领，七雄皆有，每条特征都带出处', () => {
  const roster = sc.world.generals!;
  const list = Object.values(roster);
  assert.equal(list.length, 16);
  assert.equal(new Set(list.map((g) => g.factionId)).size, 7, '七雄都要有将领');
  for (const g of list) {
    assert.match(g.id, /^[a-z0-9][a-z0-9_-]*$/);
    assert.ok(g.name && g.source.includes('《'), `${g.id} 缺史料出处`);
    assert.ok(sc.initialState.factions[g.factionId], `${g.id} 的势力不存在`);
    assert.ok(g.traits.length >= 1, `${g.id} 至少要有一条特征`);
    for (const t of g.traits) assert.ok(t.text && t.source, `${g.id} 的特征缺 text/source`);
    const e = g.effects;
    assert.ok(e.attackMultiplier >= 0.5 && e.attackMultiplier <= 1.5);
    assert.ok(e.defenseMultiplier >= 0.5 && e.defenseMultiplier <= 1.5);
    assert.ok(e.siegeMultiplier >= 1 && e.siegeMultiplier <= 1.5);
    assert.ok(e.moraleMultiplier >= 0.8 && e.moraleMultiplier <= 1.3);
    assert.ok(Number.isInteger(e.movementBonus) && e.movementBonus >= 0 && e.movementBonus <= 2);
    if (e.unitAffinity) assert.ok(sc.world.unitTypes[e.unitAffinity.typeId], `${g.id} 兵种专精指向未知兵种`);
  }
  // 韩国记载稀薄要明说，不能拿虚构战功凑数
  const han = list.filter((g) => g.factionId === 'han');
  assert.equal(han.length, 1);
  assert.match(han[0]!.source, /记载稀薄/);
});

test('★开局：一人一军、将帅同国，名册写进 contentHash', () => {
  const roster = sc.world.generals!;
  const assigned: string[] = [];
  for (const g of Object.values(roster)) {
    const u = sc.initialState.units[g.assignedTo];
    assert.ok(u, `${g.id} 的开局部队不存在`);
    assert.equal(u.generalId, g.id, `${g.id} 未绑定到指定部队`);
    assert.equal(u.ownerId, g.factionId, `${g.id} 与部队不同国`);
    assigned.push(g.id);
  }
  assert.equal(new Set(assigned).size, assigned.length, '一名将领只能带一军');
  assert.equal(Object.values(sc.initialState.units).filter((u) => u.generalId).length, assigned.length);
  // 名册是内容而不是状态：改它会让旧存档 fail-closed
  assert.notEqual(sc.contentHash, legacy.contentHash);
});

// ─────────────────────────────────────────────────────────────
// ② 战力乘数
// ─────────────────────────────────────────────────────────────

test('★纯函数：攻/守/攻城/兵种专精/行军各自生效，未启用剧本恒为 1', () => {
  const w = sc.world;
  const baiqi = sc.initialState.units['u_qin_1']!;
  assert.equal(generalCombatMultiplier(w, baiqi, 'attack'), 1.239);   // 1.18 × 1.05
  assert.equal(generalCombatMultiplier(w, baiqi, 'defense'), 1.008);  // 0.96 × 1.05
  const wangjian = sc.initialState.units['u_qin_3']!;
  assert.equal(generalCombatMultiplier(w, wangjian, 'attack'), 1.1232); // 1.08 × 1.04
  assert.equal(generalCombatMultiplier(w, wangjian, 'attack', { siege: true }), 1.3478); // 再 × 1.2
  assert.equal(generalCombatMultiplier(w, wangjian, 'defense', { siege: true }), 1.1232, '守方不吃攻城乘数');
  const limu = sc.initialState.units['u_zhao_1']!;
  assert.equal(generalCombatMultiplier(w, limu, 'defense'), 1.4438); // 1.10 × 1.25(骑兵) × 1.05
  const simacuo = sc.initialState.units['u_qin_4']!;
  assert.equal(generalMovementBudget(w, simacuo, 2), 3);
  assert.equal(generalMovementBudget(w, {}, 2), 2);

  // 旧剧本：没有名册 ⇒ 任何部队乘数都是 1，行军也无加成
  assert.equal(generalCombatMultiplier(legacy.world, { typeId: 'spearman' }, 'attack'), 1);
  assert.equal(legacy.world.generals, undefined);
  assert.equal(Object.values(legacy.initialState.units).some((u) => u.generalId), false);
});

test('★实战与 UI 预估同源：去掉将领后战力按乘数等比下降', () => {
  const state: GameState = clone(sc.initialState);
  const atk = firstEnemyAttack(state);
  // 让白起带这支进攻部队（u_qin_1 本来就是白起，但枚举到的攻方可能是别的部队）
  const withGeneral = clone(state);
  (withGeneral.units[atk.unitId] as any).generalId = 'baiqi';
  const without = clone(state);
  delete (without.units[atk.unitId] as any).generalId;

  const a = estimateBattle({ state: withGeneral, world: sc.world }, atk.fid, [atk.unitId], atk.rid);
  const b = estimateBattle({ state: without, world: sc.world }, atk.fid, [atk.unitId], atk.rid);
  const mult = generalCombatMultiplier(sc.world, withGeneral.units[atk.unitId], 'attack', {
    siege: (state.regions[atk.rid]?.fortLevel ?? 0) > 0,
  });
  // estimateBattle 对外返回 Math.round 后的整数战力，故比值带取整误差；
  // 乘数本身仍是精确的（computePower 内部未取整），容差取 2e-3 足够区分 0.01 的乘数差。
  assert.ok(Math.abs(a.attackerPower / b.attackerPower - mult) < 2e-3,
    `战力比 ${a.attackerPower / b.attackerPower} 应约等于将领乘数 ${mult}`);
});

test('★战报证据带将领乘数，可逐条复算；同种子重放逐位一致', () => {
  const state: GameState = clone(sc.initialState);
  const atk = firstEnemyAttack(state);
  for (const [uid, u] of Object.entries(state.units)) {
    if (u.regionId === atk.rid && u.ownerId !== atk.fid) delete (state.units as any)[uid];
  }
  const orders = [order('s', atk.fid, { ...atk.action.command, commitment: 1 })];
  // 显式让白起带这支进攻部队，避免"枚举到的攻方恰好没将领"让断言空转
  (state.units[atk.unitId] as any).generalId = 'baiqi';
  for (const u of Object.values(state.units)) {
    if (u.id !== atk.unitId && u.generalId === 'baiqi') delete (u as any).generalId;
  }
  const out1 = run(state, orders);
  const out2 = run(clone(state), orders);
  assert.equal(out1.newStateDigest, out2.newStateDigest, '将领乘数不得破坏确定性重放');

  const ev = eventsOf(out1).find((e) => e.type === 'combat_resolved');
  assert.ok(ev, '夹具失效：应有战斗事件');
  const g = ev!.evidence.generals;
  assert.ok(g, '战报证据要带将领乘数');
  const withGen = g.attacker.find((x: any) => x.generalId === 'baiqi');
  assert.ok(withGen, '战报应逐条列出白起的乘数');
  assert.equal(withGen.multiplier, generalCombatMultiplier(sc.world, state.units[atk.unitId]!, 'attack', {
    siege: (state.regions[atk.rid]?.fortLevel ?? 0) > 0,
  }));
  assert.deepEqual(eventsOf(out2).find((e) => e.type === 'combat_resolved')?.evidence.generals, g);
});

// ─────────────────────────────────────────────────────────────
// ③ 调任与行军
// ─────────────────────────────────────────────────────────────

test('★调任：合法改派 / 一人一军 / 不跨势力 / 不覆盖已有将领 / 不复活', () => {
  const base: GameState = clone(sc.initialState);
  const ok = run(base, [order('s', 'qin', { kind: 'assign_general', generalId: 'baiqi', unitId: 'u_qin_2' })]);
  assert.deepEqual(ok.rejected, []);
  assert.equal(ok.state.units['u_qin_1']!.generalId, undefined, '原建制卸任');
  assert.equal(ok.state.units['u_qin_2']!.generalId, 'baiqi');
  assert.ok(eventsOf(ok).some((e) => e.type === 'general_assigned'));

  // 同一回合两条命令抢同一将领：两条都合法，但核心保证最终只带一军
  const dup = clone(base);
  dup.units['u_qin_extra'] = {
    id: 'u_qin_extra', ownerId: 'qin', regionId: base.units['u_qin_2']!.regionId,
    typeId: 'militia', troops: 1000, movedThisTurn: false,
  };
  const dupOut = run(dup, [
    order('a', 'qin', { kind: 'assign_general', generalId: 'baiqi', unitId: 'u_qin_2' }),
    order('b', 'qin', { kind: 'assign_general', generalId: 'baiqi', unitId: 'u_qin_extra' }),
  ]);
  assert.deepEqual(dupOut.rejected, []);
  const carriers = Object.values(dupOut.state.units).filter((u) => u.generalId === 'baiqi');
  assert.equal(carriers.length, 1, '一名将领只能带一军');
  assert.equal(dupOut.state.units['u_qin_extra']!.generalId, 'baiqi', '按 seatId 排序后由后一条生效');

  const foreign = run(base, [order('s', 'qin', { kind: 'assign_general', generalId: 'lianpo', unitId: 'u_qin_2' })]);
  assert.equal(foreign.rejected[0]?.code, 'GENERAL_NOT_OWNED');

  const occupied = run(base, [order('s', 'qin', { kind: 'assign_general', generalId: 'baiqi', unitId: 'u_qin_3' })]);
  assert.equal(occupied.rejected[0]?.code, 'MALFORMED_PAYLOAD');

  const gone = clone(base);
  delete gone.units['u_qin_1']; // 建制被歼 ⇒ 将领退场
  const revive = run(gone, [order('s', 'qin', { kind: 'assign_general', generalId: 'baiqi', unitId: 'u_qin_2' })]);
  assert.equal(revive.rejected[0]?.code, 'GENERAL_NOT_IN_SERVICE', '阵亡将领不得复活');

  const unknown = run(base, [order('s', 'qin', { kind: 'assign_general', generalId: 'zhugeliang', unitId: 'u_qin_2' })]);
  assert.equal(unknown.rejected[0]?.code, 'UNKNOWN_GENERAL', '不得凭空创造武将');
});

test('★行军加成：合法动作与实际结算共用同一预算', () => {
  const state: GameState = clone(sc.initialState);
  const u = state.units['u_qin_4']!; // 司马错，行军 +1
  const t = sc.world.unitTypes[u.typeId]!;
  assert.equal(generalMovementBudget(sc.world, u, t.movement), t.movement + 1);
  const withBonus = reachableRegions(state, sc.world, 'qin', u.regionId, t.movement + 1, t);
  const withoutBonus = reachableRegions(state, sc.world, 'qin', u.regionId, t.movement, t);
  assert.ok(withBonus.length >= withoutBonus.length);
  const acts = enumerateLegalActions(state, sc.world, 'qin', { maxActions: 5000, uncapped: true })
    .filter((a) => a.kind === 'move_units' && a.command['unitId'] === u.id);
  assert.ok(acts.every((a) => Number(a.estimate?.['movement']) === t.movement + 1), 'UI 显示的移动力要含将领加成');
});

// ─────────────────────────────────────────────────────────────
// ④ 迷雾与兼容
// ─────────────────────────────────────────────────────────────

test('★迷雾：名册公开但不含部署，敌方将领部署不泄漏', () => {
  const snap = buildSnapshot({
    state: sc.initialState,
    world: sc.world,
    recipient: 'qin-seat',
    viewer: 'qin',
    digest: digest(sc.initialState),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    maxLegalActions: 300,
  });
  assert.equal(snap.generalRoster?.length, 16);
  assert.ok(snap.generalRoster!.every((g) => !('unitId' in g) && !('regionId' in g)), '名册不得夹带部署');
  assert.ok(snap.regions.some((r) => r.stacks?.some((s) => s.generalName === '白起')), '己方将领可见');
  assert.equal(
    snap.regions.filter((r) => r.owner !== 'qin' && (r.stacks ?? []).some((s) => s.generalId)).length,
    0,
    '未侦察的敌国区域不得下发将领部署',
  );

  const legacySnap = buildSnapshot({
    state: legacy.initialState,
    world: legacy.world,
    recipient: 'qin-seat',
    viewer: 'qin',
    digest: digest(legacy.initialState),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    maxLegalActions: 300,
  });
  assert.equal(legacySnap.generalRoster, undefined, '经典兼容版不下发将领字段');
});

test('★兼容基线：warring-states（经典）与虚构剧本不启用将领', () => {
  assert.equal(legacy.world.generals, undefined);
  assert.equal(legacy.meta.behaviorFingerprint, 36775, '经典版是指纹锁定的旧存档基线');
  assert.equal(legacy.contentHash, '366196c9670550f65dc6aaf87322eef6564b095e43c0be7dcabc09c3e870687d');
  for (const id of ['aria', 'grand-front', 'iron-front', 'random-front-v2']) {
    const s = loadScenario(id, SEED, 'config');
    assert.equal(s.world.generals, undefined, `${id} 不应启用将领`);
    assert.equal(Object.values(s.initialState.units).some((u) => u.generalId), false);
  }
  const noGeneralActions = enumerateLegalActions(legacy.initialState, legacy.world, 'qin', { maxActions: 5000, uncapped: true });
  assert.equal(noGeneralActions.some((a) => a.kind === 'assign_general'), false);
});
