/**
 * 编成闸门：分兵 / 合兵。
 *
 * 不变量：
 *   ① 分兵兵力守恒、同区同兵种、id 确定性；
 *   ② 不能分出 0 或分出全部；
 *   ③ 合兵同区同兵种、兵力守恒、source 被移除；
 *   ④ 跨区/跨兵种合兵必须被拒；
 *   ⑤ 合法动作空间真的包含分兵/合兵（人类 UI 才能点）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { deriveSplitId } from '../../src/core/modules/formation.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import type { GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';

const SEED = 'formation-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('random-front-v2', SEED, 'config');
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
function pickUnit(state: GameState): { fid: string; unitId: string } {
  for (const fid of Object.keys(state.factions).sort()) {
    const u = Object.values(state.units)
      .filter((x) => x.ownerId === fid && x.troops > 1)
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (u) return { fid, unitId: u.id };
  }
  throw new Error('夹具失效：没有可分的部队');
}

test('★分兵：兵力守恒、同区同兵种、id 确定性、事件齐全', () => {
  const { fid, unitId } = pickUnit(sc.initialState);
  const unit = sc.initialState.units[unitId]!;
  const count = Math.floor(unit.troops / 2);
  const a = run(clone(sc.initialState), [order(fid, fid, { kind: 'split_unit', unitId, count })]);
  const b = run(clone(sc.initialState), [order(fid, fid, { kind: 'split_unit', unitId, count })]);
  assert.deepEqual(a.rejected, []);
  const evA = (a.events as DomainEvent[]).find((e) => e.type === 'units_split');
  const evB = (b.events as DomainEvent[]).find((e) => e.type === 'units_split');
  assert.ok(evA && evA.type === 'units_split');
  assert.ok(evB && evB.type === 'units_split');
  assert.equal(evA.newUnitId, evB.newUnitId, '同输入必须派生同一个新 unit id');
  const newUnit = a.state.units[evA.newUnitId]!;
  assert.ok(newUnit, '新部队必须存在');
  assert.equal(newUnit.ownerId, fid);
  assert.equal(newUnit.regionId, unit.regionId);
  assert.equal(newUnit.typeId, unit.typeId);
  assert.equal(newUnit.troops, count);
  assert.equal(a.state.units[unitId]!.troops, unit.troops - count);
  assert.equal(a.state.units[unitId]!.troops + newUnit.troops, unit.troops, '兵力必须守恒');
  assert.equal(evA.remaining, unit.troops - count);
  assert.equal(evA.count, count);
});

test('分兵拒绝面：分出 0 / 分出全部都不行', () => {
  const { fid, unitId } = pickUnit(sc.initialState);
  const troop = sc.initialState.units[unitId]!.troops;
  for (const count of [0, troop]) {
    const out = run(clone(sc.initialState), [order(fid, fid, { kind: 'split_unit', unitId, count })]);
    assert.equal(out.rejected[0]?.code, 'MALFORMED_PAYLOAD', `count=${count} 必须被拒`);
    assert.equal(out.state.units[unitId]!.troops, troop, '拒绝不得改状态');
  }
});

test('★合兵：同区同兵种合并、source 移除、兵力守恒', () => {
  const { fid, unitId } = pickUnit(sc.initialState);
  const unit = sc.initialState.units[unitId]!;
  const count = Math.max(1, Math.floor(unit.troops / 3));
  const split = run(clone(sc.initialState), [order(fid, fid, { kind: 'split_unit', unitId, count })]);
  const newId = (split.events as DomainEvent[]).find(
    (e): e is Extract<DomainEvent, { type: 'units_split' }> => e.type === 'units_split',
  )!.newUnitId;
  const totalBefore = split.state.units[unitId]!.troops + split.state.units[newId]!.troops;
  const merged = run(split.state, [
    order(fid, fid, { kind: 'merge_units', unitId: newId, targetUnitId: unitId }),
  ]);
  assert.deepEqual(merged.rejected, []);
  assert.equal(merged.state.units[newId], undefined, 'source 必须移除');
  assert.equal(merged.state.units[unitId]!.troops, totalBefore, '合兵必须守恒');
  const ev = (merged.events as DomainEvent[]).find((e) => e.type === 'units_merged');
  assert.ok(ev && ev.type === 'units_merged');
  assert.equal(ev.count, count);
  assert.equal(ev.total, totalBefore);
});

test('合兵拒绝面：跨区 / 跨兵种 / 并自己都拒绝', () => {
  const { fid, unitId } = pickUnit(sc.initialState);
  const state = clone(sc.initialState);
  const unit = state.units[unitId];
  const otherType = Object.keys(sc.world.unitTypes).find((t) => t !== unit.typeId)!;
  const otherRegion = Object.keys(state.regions).find((r) => r !== unit.regionId)!;
  state.units['u_manual_a'] = { ...unit, id: 'u_manual_a', troops: 1000, typeId: otherType, regionId: unit.regionId };
  state.units['u_manual_b'] = { ...unit, id: 'u_manual_b', troops: 1000, typeId: unit.typeId, regionId: otherRegion };

  const self = run(clone(state), [order(fid, fid, { kind: 'merge_units', unitId, targetUnitId: unitId })]);
  assert.equal(self.rejected[0]?.code, 'SELF_TARGET_NOT_ALLOWED');

  const crossType = run(clone(state), [
    order(fid, fid, { kind: 'merge_units', unitId: 'u_manual_a', targetUnitId: unitId }),
  ]);
  assert.equal(crossType.rejected[0]?.code, 'MALFORMED_PAYLOAD');

  const crossRegion = run(clone(state), [
    order(fid, fid, { kind: 'merge_units', unitId: 'u_manual_b', targetUnitId: unitId }),
  ]);
  assert.equal(crossRegion.rejected[0]?.code, 'MALFORMED_PAYLOAD');
});

test('★合法动作包含分兵/合兵，且同区同兵种才出现 merge', () => {
  const { fid, unitId } = pickUnit(sc.initialState);
  const acts = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 90 });
  const splits = acts.filter((a) => a.kind === 'split_unit' && a.command['unitId'] === unitId);
  assert.ok(splits.length >= 1, '应有至少一种分兵比例');
  assert.ok(splits.every((a) => Number(a.command['count']) > 0));
  assert.ok(acts.some((a) => a.kind === 'merge_units') === false, '开局同区同兵种不足时不应凭空出现合兵');

  const split = run(clone(sc.initialState), [order(fid, fid, splits[0]!.command)]);
  const nextActs = enumerateLegalActions(split.state, sc.world, fid, { maxActions: 90 });
  assert.ok(nextActs.some((a) => a.kind === 'merge_units'), '分兵后同区同兵种应能合兵');
});


test('分兵 id 分配有硬上限，候选耗尽时返回 null 而不是无限循环', () => {
  const units: Record<string, unknown> = {};
  for (let n = 1; n <= 1000; n++) units[`u_x_1_s${n}`] = {};
  for (let n = 1; n <= 1000; n++) units[`u_x_5_s${n}`] = {};
  const fakeCtx = { state: { units }, turn: 5 } as never;
  assert.equal(deriveSplitId(fakeCtx, 'x', 5, 'u_x_1'), null);

  const emptyCtx = { state: { units: {} }, turn: 5 } as never;
  assert.equal(deriveSplitId(emptyCtx, 'x', 5, 'u_x_1'), 'u_x_1_s1');
});
