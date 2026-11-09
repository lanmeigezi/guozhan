/**
 * 可读性/政令说明闸门。
 *
 * 业主反馈：税率选项的"民心变化"大量相同，且法令只显示花费、看不懂效果。
 * 现在税率直接参与全国民心结算：10% 轻税 +2、20% 中性、30% 起逐档扣民心。
 *
 * 本测试锁住：
 *   · 税率的说明必须给真实税金/民心/动乱，且不同档位不能报同一串数字；
 *   · 10% 必须是正的民心收益，30/40/50/60% 必须逐档更痛；
 *   · 法令动作必须带持续效果说明，layout 也必须下发法令图鉴。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario } from '../../src/server/config-loader.ts';
import { MapLayoutSchema } from '../../src/protocol/map-layout.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';

const loaded = loadScenario('warring-states', 'ux-help-seed', 'config');

test('法令图鉴随 layout 下发：名称/描述/效果/成本齐全', () => {
  const layout = MapLayoutSchema.parse(loaded.mapLayout);
  assert.ok(Array.isArray(layout.laws) && layout.laws.length >= 5, 'layout.laws 应包含全部法令');
  const ids = new Set(layout.laws!.map((l) => l.id));
  for (const id of ['juntian', 'yantie', 'junxian', 'jingbing', 'fuyi', 'jianmin']) {
    assert.ok(ids.has(id), `法令图鉴缺少 ${id}`);
  }
  for (const law of layout.laws!) {
    assert.ok(law.name.length > 0, `${law.id} 缺名称`);
    assert.ok(law.description.length > 0, `${law.id} 缺描述`);
    assert.ok(Object.keys(law.effects).length > 0, `${law.id} 缺效果`);
    assert.ok(law.enactGold >= 0, `${law.id} 成本非法`);
  }
});

test('税率动作说明真实差异：税金/民心/动乱逐档不同', () => {
  const actions = enumerateLegalActions(loaded.initialState, loaded.world, 'qin', {
    maxActions: 20,
    kinds: ['set_tax', 'set_law'],
  });
  const taxes = actions.filter((a) => a.kind === 'set_tax');
  assert.ok(taxes.length >= 4, '应有多档税率可调整');
  const byRate = new Map(taxes.map((t) => [Number(t.command['rate']), t]));
  const expectedMorale: ReadonlyArray<readonly [number, number]> = [
    [0.1, 2], [0.2, 0], [0.4, -8], [0.5, -12], [0.6, -16],
  ];
  for (const [rate, morale] of expectedMorale) {
    const tax = byRate.get(rate);
    assert.ok(tax, `缺少 ${rate * 100}% 税档`);
    assert.equal(typeof tax.estimate?.['taxRevenue'], 'number', `${tax.id} 缺税金估算`);
    assert.equal(typeof tax.estimate?.['goldDeltaPerTurn'], 'number', `${tax.id} 缺税金变化`);
    assert.equal(typeof tax.estimate?.['taxUnrestPerTurn'], 'number', `${tax.id} 缺税率动乱`);
    assert.equal(tax.estimate?.['taxMoralePerTurn'], morale, `${tax.id} 的税后民心应为 ${morale}`);
    assert.equal(typeof tax.estimate?.['moraleDeltaPerTurn'], 'number', `${tax.id} 缺民心变化`);
    assert.match(String(tax.description), /民心 (?:[+-]\d+|±0)/, `${tax.id} 必须写明税率对民心的影响`);
  }
  const revenues = new Set(taxes.map((t) => Number(t.estimate?.['goldDeltaPerTurn'])));
  assert.ok(revenues.size >= 4, `不同税档的金收入变化必须可区分，实得 ${[...revenues].join(',')}`);
  const moraleValues = new Set(taxes.map((t) => Number(t.estimate?.['taxMoralePerTurn'])));
  assert.ok(moraleValues.size >= 4, `民心变化不能所有税档一样，实得 ${[...moraleValues].join(',')}`);
  assert.equal(byRate.get(0.1)?.estimate?.['taxMoralePerTurn'], 2, '10% 必须是轻税回民');
  assert.ok(
    taxes.some((a) => Number(a.estimate?.['taxUnrestPerTurn']) > 0),
    '超过 40% 的税档必须明确显示动乱代价',
  );
});

test('法令动作说明持续效果，而不是只给一个花费', () => {
  const actions = enumerateLegalActions(loaded.initialState, loaded.world, 'qin', {
    maxActions: 20,
    kinds: ['set_law'],
  });
  assert.ok(actions.length >= 2, '秦应还有可颁布的法令');
  for (const law of actions) {
    assert.match(String(law.description), /持续生效：/, `${law.id} 缺效果说明`);
    assert.match(
      String(law.description),
      /粮产|金收入|军费|征兵成本|战力|民心|动乱/,
      `${law.id} 的效果说明应为人类可读项`,
    );
  }
});
