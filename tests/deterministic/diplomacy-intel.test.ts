/**
 * 外交 / 谍报 / 裁军 / 终局闸门。
 *
 * 锁住：
 *   ① 外交命令真的改关系（不是提交后静默丢弃）；
 *   ② 间谍花金写入 intel，投影在有效期内给 exact 视图，过期自动回落；
 *   ③ 裁军随时可用（不再只在缺粮时出现），且真的移除部队、回兵源；
 *   ④ 终局后合法动作必须为空，快照明确带 winner/endReason；
 *   ⑤ 旧剧本不启用外交模块，不受影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import { getRelation, INTEL_VALID_TURNS, type GameState } from '../../src/core/state.ts';
import { spyGoldCost } from '../../src/core/modules/statecraft.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';

const SEED = 'diplomacy-intel-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('random-front-v2', SEED, 'config');
// 未注册 statecraft 的剧本仍然必须'不带间谍/外交'（用 aria 当反例；战国七雄已升级为完整模块集）
const legacy = loadScenario('aria', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (state: GameState): string => sha256(stableStringify(state));

function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}

function run(state: GameState, commands: readonly AcceptedOrder[] = []): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world: sc.world,
    modules: MODULES,
    orders: commands,
    rootSeed: SEED,
    turn: state.turn,
    now: FIXED_NOW,
    digest,
  });
}

function pickFaction(state: GameState): string {
  for (const fid of Object.keys(state.factions).sort()) {
    if (Object.values(state.regions).some((r) => r.owner === fid)) return fid;
  }
  throw new Error('夹具失效：没有拥有区域的势力');
}

test('★新剧本接入外交模块；旧剧本没有外交/间谍动作', () => {
  assert.ok(sc.meta.moduleOrder.includes('statecraft'), 'random-front-v2 必须注册外交/谍报模块');
  const fid = pickFaction(sc.initialState);
  const acts = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 80 });
  assert.ok(acts.some((a) => a.kind === 'send_spy'), '新剧本必须暴露间谍动作');
  assert.ok(acts.some((a) => a.kind === 'diplomacy'), '新剧本必须暴露外交动作');
  assert.ok(
    acts.filter((a) => a.kind === 'diplomacy').every((a) => String(a.description).includes('AI 暂不讨价还价')),
    '外交说明必须明确当前是单方面宣告',
  );

  const legacyFid = Object.keys(legacy.initialState.factions)[0]!;
  const legacyActs = enumerateLegalActions(legacy.initialState, legacy.world, legacyFid, { maxActions: 80 });
  assert.equal(legacyActs.some((a) => a.kind === 'send_spy'), false, '未注册 statecraft 的剧本不得凭空获得间谍');
  assert.equal(legacy.meta.moduleOrder.includes('statecraft'), false);
});

test('★宣战/求和真的改关系，且发出 diplomacy_changed', () => {
  const fid = pickFaction(sc.initialState);
  const other = Object.keys(sc.initialState.factions).find(
    (x) => x !== fid && getRelation(sc.initialState, fid, x) !== 'war',
  )!;
  assert.ok(other, '夹具失效：找不到可宣战的势力');
  const war = run(clone(sc.initialState), [
    order(fid, fid, { kind: 'diplomacy', to: other, action: 'declare_war' }),
  ]);
  assert.deepEqual(war.rejected, []);
  assert.equal(getRelation(war.state, fid, other), 'war');
  assert.ok((war.events as DomainEvent[]).some((e) => e.type === 'diplomacy_changed'));

  const peace = run(clone(war.state), [
    order(fid, fid, { kind: 'diplomacy', to: other, action: 'propose_peace' }),
  ]);
  assert.deepEqual(peace.rejected, []);
  assert.equal(getRelation(peace.state, fid, other), 'peace');
});

test('外交 accept_* 不得被悄悄当成 propose：当前没有待答复提案就拒绝', () => {
  const fid = pickFaction(sc.initialState);
  const other = Object.keys(sc.initialState.factions).find((x) => x !== fid)!;
  const out = run(clone(sc.initialState), [
    order(fid, fid, { kind: 'diplomacy', to: other, action: 'accept_peace' }),
  ]);
  assert.equal(out.rejected[0]?.code, 'MALFORMED_PAYLOAD');
  assert.equal(getRelation(out.state, fid, other), getRelation(sc.initialState, fid, other));
});

test('★间谍：花金写 intel，目标区变 full；过期后回落', () => {
  const fid = pickFaction(sc.initialState);
  const target = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 80 })
    .find((a) => a.kind === 'send_spy')!;
  const rid = String(target.command['regionId']);
  const out = run(clone(sc.initialState), [order(fid, fid, target.command)]);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.state.factions[fid]!.intel[rid], 1, 'intel 必须记录侦察回合');
  const spyDelta = out.deltas.find(
    (d) => d.scope === `faction:${fid}` && d.reason.includes('遣间谍'),
  );
  assert.equal(spyDelta?.delta, -spyGoldCost(sc.world, rid), '间谍必须按目标地形扣情报费（经济收入先结算，所以不比绝对值）');
  const spied = (out.events as DomainEvent[]).find((e) => e.type === 'spy_reported');
  assert.ok(spied && spied.type === 'spy_reported');
  assert.equal(spied.expiresTurn, 1 + INTEL_VALID_TURNS);

  const snap = buildSnapshot({
    state: out.state,
    world: sc.world,
    recipient: fid,
    viewer: fid,
    digest: digest(out.state),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
  });
  const r = snap.regions.find((x) => x.id === rid)!;
  assert.equal(r.visibility, 'full', '侦察有效期内必须给 exact 视图');
  assert.ok(Array.isArray(r.stacks), 'exact 视图必须能看到精确驻军');

  const expired = clone(out.state);
  expired.turn = 1 + INTEL_VALID_TURNS + 1; // 超过有效期
  const oldSnap = buildSnapshot({
    state: expired,
    world: sc.world,
    recipient: fid,
    viewer: fid,
    digest: digest(expired),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
  });
  assert.notEqual(oldSnap.regions.find((x) => x.id === rid)!.visibility, 'full', '情报过期后必须回落');
});

test('间谍拒绝面：不能侦察己方；金不足被拒', () => {
  const fid = pickFaction(sc.initialState);
  const own = Object.keys(sc.initialState.regions).find((rid) => sc.initialState.regions[rid]!.owner === fid)!;
  const selfOut = run(clone(sc.initialState), [
    order(fid, fid, { kind: 'send_spy', regionId: own }),
  ]);
  assert.equal(selfOut.rejected[0]?.code, 'SELF_TARGET_NOT_ALLOWED');

  const poor = clone(sc.initialState);
  poor.factions[fid]!.gold = -1_000_000;
  const target = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 80 }).find(
    (a) => a.kind === 'send_spy',
  )!;
  const poorOut = run(poor, [order(fid, fid, target.command)]);
  assert.equal(poorOut.rejected[0]?.code, 'INSUFFICIENT_GOLD');
});

test('★裁军随时可用：真的移除部队并回兵源', () => {
  const fid = pickFaction(sc.initialState);
  const acts = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 80 });
  const disband = acts.find((a) => a.kind === 'disband');
  assert.ok(disband, '国库/粮草不缺时也必须能裁军');
  const unitId = String(disband!.command['unitId']);
  const manpowerBefore = sc.initialState.factions[fid]!.manpower;
  const out = run(clone(sc.initialState), [order(fid, fid, disband!.command)]);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.state.units[unitId], undefined, '裁光后部队必须从状态中移除');
  assert.ok(out.state.factions[fid]!.manpower > manpowerBefore, '裁军必须回兵源');
});

test('★终局后合法动作为空；快照明确带 winner/endReason', () => {
  const ended = clone(sc.initialState);
  ended.phase = 'ended';
  ended.winner = pickFaction(ended);
  ended.endReason = 'conquest';
  const fid = ended.winner;
  assert.deepEqual(enumerateLegalActions(ended, sc.world, fid, { maxActions: 80 }), []);
  const snap = buildSnapshot({
    state: ended,
    world: sc.world,
    recipient: fid,
    viewer: fid,
    digest: digest(ended),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
  });
  assert.equal(snap.winner, fid);
  assert.equal(snap.endReason, 'conquest');
});
