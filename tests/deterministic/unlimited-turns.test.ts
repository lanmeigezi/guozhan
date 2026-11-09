/**
 * 国战“不限回合”：world.maxTurns=0 表示不按回合数强制结束；
 * 仍然必须能因征服/灭亡正常结束（由其它测试覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import type { GameState } from '../../src/core/state.ts';

const SEED = 'unlimited-turns-0001';
const sc = loadScenario('warring-states', SEED, 'config');

test('maxTurns=0 不产生 turn_limit，回合可以继续推进', () => {
  const state: GameState = { ...sc.initialState, turn: 999 };
  const out = resolveTurn({
    state,
    world: { ...sc.world, maxTurns: 0 },
    modules: buildModules(sc.meta.moduleOrder),
    orders: [],
    rootSeed: SEED,
    turn: 999,
    now: 0,
    digest: (s) => sha256(stableStringify(s)),
  });
  assert.notEqual(out.state.endReason, 'turn_limit');
  assert.notEqual(out.state.phase, 'ended');
  assert.equal(out.events.some((e: any) => e.type === 'match_ended'), false);
  assert.ok(out.events.some((e: any) => e.type === 'turn_resolved'));
});
