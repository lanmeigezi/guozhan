/**
 * 战斗命令的完整性闸门：
 *   ① 同一部队一回合只能发起一次进攻（UI/启发式去重之外，core 自己兜底）；
 *   ② commitment 即使绕过协议直接喂给 core，也会被钳在 0.1-1（0 不会变成“零兵进攻”）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import type { GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';

const SEED = 'combat-rules-seed-0001';
const sc = loadScenario('random-front-v2', SEED, 'config');
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (s: GameState): string => sha256(stableStringify(s));

function order(fid: string, command: Record<string, unknown>, index: number): AcceptedOrder {
  return { seatId: fid, factionId: fid, command, kind: String(command['kind']), index } as AcceptedOrder;
}
function run(state: GameState, orders: readonly AcceptedOrder[]): ReturnType<typeof resolveTurn> {
  return resolveTurn({
    state,
    world: sc.world,
    modules: MODULES,
    orders,
    rootSeed: SEED,
    turn: state.turn,
    now: 1_700_000_000_000,
    digest,
  });
}

test('同一部队重复进攻：只结算第一场，第二条被拒', () => {
  const fid = Object.keys(sc.initialState.factions).sort()[0]!;
  const attack = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 200 })
    .find((a) => a.kind === 'attack');
  assert.ok(attack, '夹具失效：找不到合法进攻');
  const out = run(sc.initialState, [
    order(fid, attack.command as Record<string, unknown>, 0),
    order(fid, attack.command as Record<string, unknown>, 1),
  ]);
  const battles = out.events.filter((e: any) => e.type === 'combat_resolved');
  assert.equal(battles.length, 1, '同一部队不应在同一回合结算两场进攻');
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0]?.code, 'MALFORMED_PAYLOAD');
});

test('core 对 commitment 做防御性钳制：0 不产生零兵进攻，2 不超过全军', () => {
  const fid = Object.keys(sc.initialState.factions).sort()[0]!;
  const attack = enumerateLegalActions(sc.initialState, sc.world, fid, { maxActions: 200 })
    .find((a) => a.kind === 'attack');
  assert.ok(attack);
  const unit = sc.initialState.units[String(attack.command['unitId'])]!;
  const base = attack.command as Record<string, unknown>;
  const low = run(sc.initialState, [order(fid, { ...base, commitment: 0 }, 0)]);
  const high = run(sc.initialState, [order(fid, { ...base, commitment: 2 }, 0)]);
  const lowEv = low.events.find((e: any) => e.type === 'combat_resolved') as any;
  const highEv = high.events.find((e: any) => e.type === 'combat_resolved') as any;
  assert.ok(lowEv && highEv, '两场进攻都应有战斗证据');
  assert.equal(lowEv.evidence.attacker.troopsBefore, Math.max(1, Math.round(unit.troops * 0.1)));
  assert.equal(highEv.evidence.attacker.troopsBefore, unit.troops);
});
