/**
 * “先移动再进攻”组合动作：
 *   · 合法动作中应出现带 moveTo 的 attack；
 *   · 结算时 movement 先机动、combat 再按新落点开打；
 *   · 若机动失败，combat 必须拒绝，不能从旧位置偷袭。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { isAttackAdjacent } from '../../src/core/state.ts';
import type { GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SEED = 'move-attack-seed-0001';
const sc = loadScenario('warring-states', SEED, 'config');
const digest = (s: GameState): string => sha256(stableStringify(s));

function order(command: Record<string, unknown>): AcceptedOrder {
  return { seatId: 'qin', factionId: 'qin', command, kind: String(command['kind']), index: 0 } as AcceptedOrder;
}
function run(command: Record<string, unknown>) {
  return resolveTurn({
    state: sc.initialState,
    world: sc.world,
    modules: buildModules(sc.meta.moduleOrder),
    orders: [order(command)],
    rootSeed: SEED,
    turn: sc.initialState.turn,
    now: 0,
    digest,
  });
}

test('合法动作会给出“移动后进攻”，且目标只在移动落点相邻', () => {
  const action = enumerateLegalActions(sc.initialState, sc.world, 'qin', { maxActions: 2000, uncapped: true, moveAttacks: true })
    .find((a) => a.kind === 'attack' && a.command.unitId === 'u_qin_1' && a.command.moveTo === 'luoyang' && a.command.targetRegion === 'daliang');
  assert.ok(action, '夹具失效：找不到 qin 的移动后进攻');
  const type = sc.world.unitTypes[sc.initialState.units['u_qin_1']!.typeId]!;
  assert.equal(isAttackAdjacent(sc.world, type, 'guanzhong', 'daliang'), false, '原地不应能直接打到大梁');
  assert.equal(isAttackAdjacent(sc.world, type, 'luoyang', 'daliang'), true, '移动到洛阳后应能打到大梁');
  assert.deepEqual(action.path, ['guanzhong', 'luoyang', 'daliang']);
});

test('组合动作先移动、再按新落点进攻', () => {
  const action = enumerateLegalActions(sc.initialState, sc.world, 'qin', { maxActions: 2000, uncapped: true, moveAttacks: true })
    .find((a) => a.kind === 'attack' && a.command.unitId === 'u_qin_1' && a.command.moveTo === 'luoyang' && a.command.targetRegion === 'daliang');
  assert.ok(action);
  const out = run(action.command);
  assert.deepEqual(out.rejected, []);
  assert.ok(out.events.some((e: any) => e.type === 'units_moved' && e.unitId === 'u_qin_1' && e.to === 'luoyang'));
  assert.equal(out.events.filter((e: any) => e.type === 'combat_resolved').length, 1, '必须发生一场按新落点计算的战斗');
  assert.notEqual(out.state.units['u_qin_1']?.regionId, 'guanzhong', '部队应先离开原区');
});

test('机动失败时组合动作不得从旧位置进攻', () => {
  const action = enumerateLegalActions(sc.initialState, sc.world, 'qin', { maxActions: 2000, uncapped: true, moveAttacks: true })
    .find((a) => a.kind === 'attack' && a.command.unitId === 'u_qin_1' && a.command.moveTo === 'luoyang' && a.command.targetRegion === 'daliang');
  assert.ok(action);
  const out = run({ ...action.command, moveTo: 'liaodong' });
  assert.equal(out.events.filter((e: any) => e.type === 'combat_resolved').length, 0, '机动失败后不得开战');
  assert.equal(out.state.units['u_qin_1']?.regionId, 'guanzhong', '机动失败后部队应留在原区');
  assert.ok(out.rejected.some((r: any) => r.code === 'MOVE_NOT_RESOLVED'), '必须显式拒绝未机动的组合进攻');
});
