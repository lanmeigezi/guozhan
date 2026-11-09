/**
 * 人类 UI 的动作空间不能被 per-kind cap 截断。
 *
 * 现场问题：中后期单位/边境一多，攻击最多只列 12 条、征兵 8 条；被挤掉的
 * 相邻敌国在界面上表现为“这个地块什么都不能做”，很像规则缺了进攻机制。
 * 全量枚举（uncapped）必须覆盖所有合法进攻；LLM/军师仍可使用有上限的列表。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario } from '../../src/server/config-loader.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';

test('全量动作包含被 per-kind cap 挤掉的进攻目标', () => {
  const sc = loadScenario('warring-states', 'legal-coverage-0001', 'config');
  const fid = 'wei';
  const state = {
    ...sc.initialState,
    units: { ...sc.initialState.units } as Record<string, (typeof sc.initialState.units)[string]>,
  };
  // 两个高战力部队在大梁（4 个目标），再放一支弱旅在河东（另有 2 个独有目标）。
  // 默认 cap=12 时，12 个名额会被大梁的高 ratio 目标占满，河东的 guanzhong/jinyang 消失。
  const base = state.units['u_wei_1']!;
  for (let i = 0; i < 2; i++) {
    state.units[`probe-strong-${i}`] = { ...base, id: `probe-strong-${i}`, troops: 20000 - i * 1000, movedThisTurn: false };
  }
  state.units['probe-weak'] = { ...state.units['u_wei_3']!, id: 'probe-weak', troops: 1, movedThisTurn: false };

  const all = enumerateLegalActions(state, sc.world, fid, { maxActions: 2000, uncapped: true })
    .filter((a) => a.kind === 'attack');
  const capped = enumerateLegalActions(state, sc.world, fid, { maxActions: 120 })
    .filter((a) => a.kind === 'attack');

  assert.equal(capped.length, 12, '夹具应触发默认每类上限');
  assert.ok(all.length > capped.length, '全量动作应多于截断后的动作');
  const allTargets = new Set(all.map((a) => a.targetRegion));
  const cappedTargets = new Set(capped.map((a) => a.targetRegion));
  assert.ok(allTargets.has('guanzhong') && allTargets.has('jinyang'), '全量列表必须包含所有相邻目标');
  assert.ok(!cappedTargets.has('guanzhong') && !cappedTargets.has('jinyang'), '夹具应复现截断丢失目标');

  const limited = enumerateLegalActions(state, sc.world, fid, { maxActions: 5, uncapped: true });
  assert.equal(limited.length, 5, 'uncapped 仍必须尊重总条数上限');
});
