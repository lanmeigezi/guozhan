/**
 * 开荒模式 + 回合复盘 闸门。
 *
 * 锁住：
 *   ① frontier 剧本：4 个自定义国家各占 1 格，其余地块是原住民荒地；
 *   ② 必须先把部队移动进荒地，再用 settle_region 完成基建 Lv1 才能占领；
 *   ③ 普通进攻不能直接夺走荒地；
 *   ④ 开荒消耗金粮、吸收原住民、获得少量资金并建基建；
 *   ⑤ turn_recap 事件覆盖所有势力，UI 可显示每回合变化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { buildSnapshot } from '../../src/server/room/snapshot.ts';
import { unitsIn, type GameState } from '../../src/core/state.ts';
import type { AcceptedOrder } from '../../src/core/module.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';

const SEED = 'frontier-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('frontier', SEED, 'config');
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

test('★frontier 剧本：自定义国家/地名，每方只有一块地，其余为原住民荒地', () => {
  assert.equal(sc.meta.id, 'frontier');
  assert.equal(sc.world.frontier?.settledInfrastructure, 1);
  assert.equal(Object.keys(sc.initialState.factions).length, 4);
  for (const fid of Object.keys(sc.initialState.factions).sort()) {
    const owned = Object.values(sc.initialState.regions).filter((r) => r.owner === fid);
    assert.equal(owned.length, 1, `${fid} 开局必须只有 1 块地`);
  }
  const neutral = Object.values(sc.initialState.regions).filter((r) => r.owner === null);
  assert.equal(neutral.length, 15);
  for (const r of neutral) {
    assert.ok(unitsIn(sc.initialState, r.id, 'neutral').some((u) => u.troops > 0), `${r.id} 必须有原住民守军`);
  }
  assert.equal(sc.world.regions['guanzhong']?.name, '風息原');
  assert.equal(sc.initialState.factions.red?.name, '赤原裔');
  assert.equal(sc.world.regions['longxi']?.name, '白石崗');
});

test('★开荒图是半径 2 的正六边形：3/4/5/4/3 行、四首都对称', () => {
  const layout = sc.mapLayout as any;
  assert.equal(layout.regions.length, 19);
  const rows = new Map<number, number>();
  for (const r of layout.regions) rows.set(r.y, (rows.get(r.y) ?? 0) + 1);
  assert.deepEqual(
    [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n),
    [3, 4, 5, 4, 3],
    '正六边形应为 3/4/5/4/3 五行',
  );
  const p = Object.fromEntries(layout.regions.map((r: any) => [r.id, r]));
  const { red, blue, green, gold } = layout.capitals;
  assert.equal(p[red].y, p[blue].y, '红/蓝首都应在同一行');
  assert.equal(p[green].y, p[gold].y, '青/金首都应在同一行');
  assert.equal(p[red].x, p[green].x, '左侧两首都应对齐');
  assert.equal(p[blue].x, p[gold].x, '右侧两首都应对齐');
  assert.equal(p[blue].x - p[red].x, p[gold].x - p[green].x, '四角应左右对称');
  assert.equal(p[green].y - p[red].y, p[gold].y - p[blue].y, '四角应上下对称');

  let min = Infinity;
  for (let i = 0; i < layout.regions.length; i++) {
    for (let j = i + 1; j < layout.regions.length; j++) {
      const a = layout.regions[i];
      const b = layout.regions[j];
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  assert.ok(Math.abs(min - layout.hexSize * Math.sqrt(3)) < 0.5, '六角蜜格应边贴边且不重叠');
});

test('★先派兵进入荒地，再开荒完成基建 Lv1 才能占领', () => {
  const state = clone(sc.initialState);
  const unit = Object.values(state.units).find((u: any) => u.ownerId === 'red') as any;
  const target = 'longxi';
  assert.equal(state.regions[target].owner, null);
  const moved = run(state, [order('s', 'red', { kind: 'move_units', unitId: unit.id, toRegion: target })]);
  assert.deepEqual(moved.rejected, []);
  assert.equal((moved.state as any).units[unit.id].regionId, target);
  assert.ok(unitsIn(moved.state, target, 'neutral').length > 0);

  const acts = enumerateLegalActions(moved.state, sc.world, 'red', { maxActions: 5000, uncapped: true });
  const settle = acts.find((a) => a.kind === 'settle_region' && a.command['regionId'] === target);
  assert.ok(settle, '部队进入后必须出现开荒动作');

  const out = run(moved.state, [order('s2', 'red', settle!.command)], moved.state.turn);
  assert.deepEqual(out.rejected, []);
  assert.equal((out.state as any).regions[target].owner, 'red');
  assert.equal((out.state as any).regions[target].infrastructure, 1, '开荒必须完成基建 Lv1');
  assert.equal(unitsIn(out.state, target, 'neutral').length, 0, '原住民必须被吸收');
  assert.ok(out.state.factions.red!.manpower > moved.state.factions.red!.manpower);
  assert.ok((out.events as DomainEvent[]).some((e) => e.type === 'frontier_settled' && e.regionId === target));
});

test('普通进攻只能驱散原住民，不能夺走荒地', () => {
  const state = clone(sc.initialState);
  const unit = Object.values(state.units).find((u: any) => u.ownerId === 'red') as any;
  const out = run(state, [order('s', 'red', { kind: 'attack', unitId: unit.id, targetRegion: 'longxi' })], 1);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.state.regions.longxi!.owner, null);
  const combat = (out.events as DomainEvent[]).find((e) => e.type === 'combat_resolved') as any;
  assert.equal(combat?.evidence?.captured, false);
});

test('派兵与开荒必须分两回合：同回合 move+settle 被拒绝', () => {
  const state = clone(sc.initialState);
  const unit = Object.values(state.units).find((u: any) => u.ownerId === 'red') as any;
  const out = run(state, [
    order('s', 'red', { kind: 'move_units', unitId: unit.id, toRegion: 'longxi' }),
    order('s', 'red', { kind: 'settle_region', regionId: 'longxi' }),
  ], 1);
  assert.equal(out.rejected[0]?.code, 'FRONTIER_NEEDS_NEXT_TURN');
  assert.equal((out.state as any).regions.longxi.owner, null);

  // 合法动作空间也不能给“必然被拒”的开荒：部队本回合刚移动 ⇒ 开荒按钮不应出现
  const movedState = clone(state);
  (movedState.units as any)[unit.id].movedThisTurn = true;
  const acts = enumerateLegalActions(movedState, sc.world, 'red', { maxActions: 5000, uncapped: true });
  assert.ok(
    !acts.some((a) => a.kind === 'settle_region' && a.command['regionId'] === 'longxi'),
    '刚移动的部队不应出现开荒动作，否则玩家会点了才在结算时吃拒绝',
  );
});

test('开荒拒绝面：没有部队、重复开荒', () => {
  const state = clone(sc.initialState);
  const noTroops = run(state, [order('s', 'red', { kind: 'settle_region', regionId: 'longxi' })], 1);
  assert.equal(noTroops.rejected[0]?.code, 'FRONTIER_NO_TROOPS');

  const unit = Object.values(state.units).find((u: any) => u.ownerId === 'red') as any;
  const moved = run(state, [order('s', 'red', { kind: 'move_units', unitId: unit.id, toRegion: 'longxi' })]);
  const out = run(moved.state, [order('s2', 'red', { kind: 'settle_region', regionId: 'longxi' })], moved.state.turn);
  assert.deepEqual(out.rejected, []);
  const again = run(out.state, [order('s3', 'red', { kind: 'settle_region', regionId: 'longxi' })], out.state.turn);
  assert.equal(again.rejected[0]?.code, 'REGION_NOT_OWNED');
});

test('快照下发荒地原住民/开荒成本；turn_recap 覆盖全部势力', () => {
  const state = clone(sc.initialState);
  const snap = buildSnapshot({
    state,
    world: sc.world,
    recipient: 'red',
    viewer: 'red',
    digest: digest(state),
    alerts: [],
    tokenUsed: 0,
    tokenCap: 1000,
    maxLegalActions: 50,
  });
  const frontier = snap.regions.find((r) => r.id === 'longxi')!;
  assert.ok(frontier.frontier);
  assert.ok(frontier.frontier!.natives > 0);
  assert.equal(frontier.frontier!.goldCost, sc.world.frontier!.settleGoldCost);

  // 地块平民 = 总人口 − 本区驻军；frontier 启用平民劳动惩罚后，驻军多的首都会压低本区产出
  const capital = snap.regions.find((r) => r.id === 'guanzhong')!;
  const capitalTroops = unitsIn(state, 'guanzhong').reduce((sum, u) => sum + u.troops, 0);
  assert.ok(capital.population! > capitalTroops);
  assert.equal(capital.civilianPopulation, capital.population! - capitalTroops);
  assert.ok(capital.civilianOutputFactor !== undefined && capital.civilianOutputFactor < 1);

  const out = run(state, [], 1);
  const recap = (out.events as DomainEvent[]).find((e) => e.type === 'turn_recap') as any;
  assert.ok(recap);
  assert.deepEqual(recap.factions.map((f: any) => f.id).sort(), Object.keys(state.factions).sort());
  assert.ok(recap.factions.every((f: any) => typeof f.regionsBefore === 'number' && typeof f.goldDelta === 'number'));

  // 同一开局把首都驻军全部移出后，首都平民占比上升，粮/金地方产出必须不低于原状态
  const rich = clone(state);
  rich.factions.red.gold = 100000;
  const withoutGarrison = clone(rich);
  for (const u of Object.values(withoutGarrison.units) as any[]) {
    if (u.ownerId === 'red') u.regionId = 'longxi';
  }
  const outRich = run(rich, [], 1);
  const outNoGarrison = run(withoutGarrison, [], 1);
  const foodWith = outRich.state.factions.red!.food - rich.factions.red!.food;
  const foodWithout = outNoGarrison.state.factions.red!.food - rich.factions.red!.food;
  const goldWith = outRich.state.factions.red!.gold - rich.factions.red!.gold;
  const goldWithout = outNoGarrison.state.factions.red!.gold - rich.factions.red!.gold;
  assert.ok(foodWithout > foodWith, `撤走驻军后粮产应上升：${foodWithout} vs ${foodWith}`);
  assert.ok(goldWithout > goldWith, `撤走驻军后金产应上升：${goldWithout} vs ${goldWith}`);
});

test('frontier 剧本可被网页快速开局和规则模块识别', async () => {
  const fs = await import('node:fs/promises');
  const web = await fs.readFile('web/app.js', 'utf8');
  assert.match(web, /id: 'frontier'/);
  assert.match(web, /開荒 · 自訂地圖/);
  assert.ok(MODULES.some((m) => m.id === 'frontier'));
  assert.ok(sc.meta.moduleOrder.includes('frontier'));
});
