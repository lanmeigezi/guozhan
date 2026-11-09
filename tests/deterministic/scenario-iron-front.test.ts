/**
 * 第二模式（鐵河棋局）闸门 —— 连续六角棋盘 + 水域/桥 + 水师多格水路。
 *
 * 核心不变量：
 *   ① 陆军只能走普通邻接；两座桥是唯一的跨河普通邻接。
 *   ② 水师只能走 waterRoutes，端点必须是港口；一条命令可以连走多条水路。
 *   ③ 水师可以沿一条水路直接突击对岸港口，但陆军不行。
 *   ④ 旧剧本 contentHash 不得因第二模式扩展而改变（旧存档必须还能读）。
 *   ⑤ 六角棋盘的网格必须连续；桥必须与规则层的跨水普通邻接逐一对应，
 *      非桥格的跨水方向不得有普通邻接。
 *
 * 变异自检：
 *   · 把 b2-c2 从 adjacency 删掉 → 桥/布局一致性用例红；
 *   · 把 waterRoutes 的某条边给陆军 → "陆军不能走水路"用例红；
 *   · 把 riverfleet.domain 改成 land → 多格水路用例红；
 *   · 把旧剧本哈希约束删掉 → 旧存档兼容用例红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { discoverScenarios, findHoles, loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { MapLayoutSchema } from '../../src/protocol/map-layout.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';
import { findPath, reachableRegions } from '../../src/core/modules/movement.ts';
import { buildModules } from '../../src/core/modules/index.ts';
import { resolveTurn } from '../../src/core/apply.ts';
import { isAdjacent, type GameState } from '../../src/core/state.ts';
import { buildMapText, visibleRegions } from '../../src/core/projection.ts';
import type { AcceptedOrder, TurnOutcome } from '../../src/core/module.ts';
import type { DomainEvent } from '../../src/protocol/events.ts';

const CONFIG_ROOT = 'config';
const SEED = 'iron-front-test-seed-0001';
const FIXED_NOW = 1_700_000_000_000;
const sc = loadScenario('iron-front', SEED, CONFIG_ROOT);
const { world, initialState } = sc;
const MODULES = buildModules(sc.meta.moduleOrder);
const digest = (state: GameState): string => sha256(stableStringify(state));

function order(seatId: string, factionId: string, command: Record<string, unknown>): AcceptedOrder {
  return { seatId, factionId, command, kind: command['kind'] as string };
}

function run(accepted: AcceptedOrder): TurnOutcome {
  return resolveTurn({
    state: initialState,
    world,
    modules: MODULES,
    orders: [accepted],
    rootSeed: SEED,
    turn: 1,
    now: FIXED_NOW,
    digest,
  });
}

function regionAt(layout: ReturnType<typeof MapLayoutSchema.parse>, row: number, col: number) {
  const r = layout.regions.find((x) => x.row === row && x.col === col);
  assert.ok(r, `布局缺少格子 (row=${row}, col=${col})`);
  return r!;
}

// ─────────────────────────────────────────────────────────────
// 旧模式兼容
// ─────────────────────────────────────────────────────────────

test('★旧剧本 contentHash 保持逐字不变（第二模式不能把旧存档顶掉）', () => {
  const expected: Record<string, string> = {
    'warring-states': '366196c9670550f65dc6aaf87322eef6564b095e43c0be7dcabc09c3e870687d',
    aria: '229ac73bbac75685eeeb3349505241e7c6b81ea5906672b9a6230b145ac6540f',
  };
  for (const [id, hash] of Object.entries(expected)) {
    const loaded = loadScenario(id, 'hash-compat-seed', CONFIG_ROOT);
    assert.equal(loaded.contentHash, hash, `${id} 的 contentHash 变了 —— 旧存档会在 verifyIdentity 处 fail-closed`);
    assert.equal(loaded.meta.behaviorFingerprint, 36775, `${id} 的 behaviorFingerprint 变了`);
    assert.equal(loaded.mapLayout.kind, 'hex', `${id} 应保持六角模式`);
    assert.equal(loaded.mapLayout.waterRoutes.length, 0, `${id} 不应凭空获得水路`);
    assert.equal(loaded.mapLayout.ports.length, 0, `${id} 不应凭空获得港口`);
  }
});

// ─────────────────────────────────────────────────────────────
// 新剧本装载
// ─────────────────────────────────────────────────────────────

test('★iron-front 可被目录扫描发现并装载：24 区 / 4 势力 / 水师在港口', () => {
  assert.ok(discoverScenarios(CONFIG_ROOT).includes('iron-front'), 'iron-front 应被目录扫描发现');
  assert.equal(Object.keys(world.regions).length, 24, '铁河棋局应有 24 个陆地六角格');
  assert.equal(Object.keys(initialState.factions).length, 4, '应有 4 个势力');
  assert.equal(world.waterRoutes.length, 10, '应有 10 条水路');
  assert.equal(Object.keys(initialState.units).length, 13, '4 势力 × 3 部队 + 1 中立驻军');
  assert.equal(world.unitTypes['riverfleet']?.domain, 'water', '水师必须是 water 域');
  assert.ok((world.unitTypes['riverfleet']?.movement ?? 0) >= 6, '水师移动力应足够连走多格');

  const waterUnits = Object.values(initialState.units).filter(
    (u) => world.unitTypes[u.typeId]?.domain === 'water',
  );
  assert.equal(waterUnits.length, 4, '每个势力应有一支水师');
  for (const u of waterUnits) {
    assert.equal(world.regions[u.regionId]?.port, true, `水师 ${u.id} 必须开局在港口`);
  }
  assert.equal(initialState.regions['b4']?.owner, null, '中洲 b4 应为中立港');
  assert.ok(initialState.units['garrison_b4'], '中立港应有驻军');
  assert.deepEqual(findHoles(world), [], 'WorldConfig 不得有 undefined/NaN');
  assert.deepEqual(findHoles(initialState), [], '初始 GameState 不得有 undefined/NaN');

  // 拓扑文本要带上水路/港口，否则纯 LLM 席位不知道"水师为什么能一回合跑这么远"
  const mapText = buildMapText(
    initialState, world, 'north', visibleRegions(initialState, world, 'north'),
  );
  assert.match(mapText, /水路（仅水师，cost）：/, 'mapText 应包含水路静态提示');
  assert.match(mapText, /港口：/, 'mapText 应包含港口清单');
  assert.match(mapText, /河朔↔中津\(1\)/, 'mapText 的水路应带端点与成本');
});

test('水路网络：端点都是港口、无重边、规范排序；只有两座桥是普通跨河邻接', () => {
  const ports = new Set(Object.keys(world.regions).filter((id) => world.regions[id]?.port === true));
  assert.deepEqual([...ports].sort(), ['b1', 'b3', 'b4', 'b5', 'c1', 'c3', 'c4', 'c6']);
  const seen = new Set<string>();
  for (const route of world.waterRoutes) {
    assert.equal(route.a < route.b, true, `水路 ${route.a}-${route.b} 未规范化`);
    assert.equal(ports.has(route.a) && ports.has(route.b), true, `水路 ${route.a}-${route.b} 端点不是港口`);
    const key = `${route.a}|${route.b}`;
    assert.equal(seen.has(key), false, `水路 ${key} 重复`);
    seen.add(key);
  }

  for (let col = 0; col < 6; col++) {
    const north = `b${col + 1}`;
    const south = `c${col + 1}`;
    const shouldBridge = col === 1 || col === 4;
    assert.equal(
      isAdjacent(world, north, south),
      shouldBridge,
      `${north}-${south} 的普通邻接必须${shouldBridge ? '' : '不'}存在（只有 b2-c2、b5-c5 两座桥）`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
// 连续六角棋盘
// ─────────────────────────────────────────────────────────────

test('★六角棋盘：24 陆格 + 6 水格、网格连续、两座桥与普通邻接一致', () => {
  const layout = MapLayoutSchema.parse(sc.mapLayout);
  assert.equal(layout.kind, 'hexboard');
  assert.equal(layout.hexSize, 62);
  assert.equal(layout.regions.length, 24);
  assert.equal(layout.waterCells?.length, 6, '中间一排应有 6 个蓝色水格');
  assert.deepEqual(
    layout.waterCells?.map((c) => c.row),
    [2, 2, 2, 2, 2, 2],
    '水格必须集中在中间一排（0,1 北岸；2 水域；3,4 南岸）',
  );
  assert.deepEqual(layout.bridges, [{ a: 'b2', b: 'c2' }, { a: 'b5', b: 'c5' }]);
  assert.deepEqual(layout.ports, ['b1', 'b3', 'b4', 'b5', 'c1', 'c3', 'c4', 'c6']);
  assert.deepEqual(
    layout.waterRoutes,
    world.waterRoutes,
    '布局 DTO 的水路必须与规则层单一真源逐条一致（不能前端另抄一份）',
  );

  // 六角邻居：同排相邻 + 上下排斜邻；隔一格的不是邻居
  assert.equal(isAdjacent(world, 'a1', 'a2'), true, '同排相邻');
  assert.equal(isAdjacent(world, 'a2', 'b1'), true, '六角斜邻应连通');
  assert.equal(isAdjacent(world, 'a1', 'b2'), false, '隔一格的六角不得相邻');
  // 跨水普通邻接只允许两座桥
  for (let col = 0; col < 6; col++) {
    const north = `b${col + 1}`;
    const south = `c${col + 1}`;
    const shouldBridge = col === 1 || col === 4;
    assert.equal(
      isAdjacent(world, north, south),
      shouldBridge,
      `${north}-${south} 的普通邻接必须${shouldBridge ? '' : '不'}存在（只有 b2-c2、b5-c5 两座桥）`,
    );
  }
  for (const bridge of layout.bridges ?? []) {
    assert.equal(isAdjacent(world, bridge.a, bridge.b), true, `布局桥 ${bridge.a}-${bridge.b} 不是普通邻接`);
    const a = layout.regions.find((r) => r.id === bridge.a);
    const b = layout.regions.find((r) => r.id === bridge.b);
    assert.ok(a && b);
    assert.ok(
      Math.hypot(a!.x - b!.x, a!.y - b!.y) > layout.hexSize! * 1.9,
      '桥两端应跨过中间水排，距离大于普通六角邻居',
    );
  }

  // 陆地必须在 0/1/3/4 排，水格在 2 排；六角中心按 pointy-top 几何排布
  for (const r of layout.regions) {
    assert.ok([0, 1, 3, 4].includes(r.row ?? -1), `陆格 ${r.id} 不应落在水域排`);
  }
  const b2 = regionAt(layout, 1, 1);
  assert.equal(b2.y, 100 + 1.5 * 62 * 1);
  assert.equal(regionAt(layout, 3, 1).y, 100 + 1.5 * 62 * 3);
  assert.equal(layout.waterCells![0]!.y, 100 + 1.5 * 62 * 2);
});

// ─────────────────────────────────────────────────────────────
// 寻路：水师多格 / 陆军绕桥
// ─────────────────────────────────────────────────────────────

test('★水师一回合连走多格水路：b1→b3→b4→c4→c6，成本 4', () => {
  const fleet = world.unitTypes['riverfleet']!;
  const direct = findPath(initialState, world, 'north', 'b1', 'c6', { unitType: fleet });
  assert.ok(direct, '水师应能沿水路抵达 c6');
  assert.deepEqual(direct!.path, ['b1', 'b3', 'b4', 'c4', 'c6']);
  assert.equal(direct!.cost, 4);
  assert.ok(direct!.cost <= fleet.movement, '成本必须在水师移动力内');

  const reachable = reachableRegions(initialState, world, 'north', 'b1', fleet.movement, fleet);
  const b4 = reachable.find((r) => r.regionId === 'b4');
  assert.ok(b4, '水师应能抵达中立港 b4');
  assert.deepEqual(b4!.path, ['b1', 'b3', 'b4']);
  assert.equal(b4!.cost, 2);
});

test('★陆军不能走水路：b1→b3 只能绕 b2（3 格），不能直线 1 格', () => {
  const spear = world.unitTypes['spearman']!;
  const land = findPath(initialState, world, 'north', 'b1', 'b3', { unitType: spear });
  assert.ok(land);
  assert.deepEqual(land!.path, ['b1', 'b2', 'b3'], '陆军必须沿普通邻接绕行，而不是 waterRoutes');
  assert.equal(land!.cost, 3);
  assert.notDeepEqual(land!.path, ['b1', 'b3'], '陆军不得使用水师的直连航道');
});

test('水师不能上岸：b1→b2（非港口）不可达', () => {
  const fleet = world.unitTypes['riverfleet']!;
  assert.equal(findPath(initialState, world, 'north', 'b1', 'b2', { unitType: fleet }), null);
});

// ─────────────────────────────────────────────────────────────
// 合法动作：水师跨水突击、港口征兵、多格移动路径
// ─────────────────────────────────────────────────────────────

test('★合法动作包含水师多格移动与跨水进攻；水师只在港口可征募', () => {
  const acts = enumerateLegalActions(initialState, world, 'north', { maxActions: 40 });

  const fleetMove = acts.find((a) => a.id === 'move:u_north_3:c4');
  assert.ok(fleetMove, '水师 c4 多格移动应在 40 条上限内（否则 UI 看不到水路玩法）');
  assert.deepEqual(fleetMove!.path, ['b1', 'b3', 'b4', 'c4']);
  assert.equal(fleetMove!.estimate?.['movementCost'], 3);

  const waterAssault = acts.find((a) => a.id === 'attack:u_north_3:c1');
  assert.ok(waterAssault, '水师应能沿一条水路直接突击对岸港口 c1');

  const landAssault = acts.find((a) => a.id === 'attack:u_north_1:c1');
  assert.equal(landAssault, undefined, '陆军不能沿水路突击 c1');

  const riverRecruits = acts.filter((a) => a.kind === 'recruit' && a.command['unitType'] === 'riverfleet');
  assert.ok(riverRecruits.length > 0, '港口应有水师征兵动作');
  for (const a of riverRecruits) {
    assert.equal(world.regions[a.command['regionId'] as string]?.port, true, '水师征兵只能出现在港口');
  }
  assert.equal(
    riverRecruits.some((a) => a.command['regionId'] === 'b2'),
    false,
    '非港口 b2 不得出现水师征兵',
  );
});

// ─────────────────────────────────────────────────────────────
// 结算：多格移动事件 / 非港口拒绝 / 港口征募 / 跨水战斗
// ─────────────────────────────────────────────────────────────

test('★结算多格水路移动：事件 path 是完整航线，movementSpent=4', () => {
  const out = run(order('north', 'north', { kind: 'move_units', unitId: 'u_north_3', toRegion: 'c6' }));
  assert.deepEqual(out.rejected, [], `多格水路移动不应被拒：${JSON.stringify(out.rejected)}`);
  assert.equal(out.state.units['u_north_3']?.regionId, 'c6');
  const events = out.events as DomainEvent[];
  const moved = events.find((e): e is Extract<DomainEvent, { type: 'units_moved' }> => e.type === 'units_moved');
  assert.ok(moved, '应发出 units_moved 事件');
  assert.deepEqual(moved.path, ['b1', 'b3', 'b4', 'c4', 'c6']);
  assert.equal(moved.movementSpent, 4);
  // ★回合结束后行动标记必须复位，否则下一回合水师永久停摆（浏览器实测抓到过）
  assert.equal(out.state.units['u_north_3']?.movedThisTurn, false, '下一回合应重新可行动');
  const nextActs = enumerateLegalActions(out.state, world, 'north', { maxActions: 40 });
  assert.ok(
    nextActs.some((a) => a.command['unitId'] === 'u_north_3'),
    '复位后水师在下一回合应重新出现在合法动作里',
  );
});

test('水师不能上岸：b1→b2 被拒 UNIT_DOMAIN_MISMATCH；港口征募成功', () => {
  const bad = run(order('north', 'north', { kind: 'move_units', unitId: 'u_north_3', toRegion: 'b2' }));
  assert.equal(bad.rejected[0]?.code, 'UNIT_DOMAIN_MISMATCH', '水师进入非港口必须被明确拒绝');

  const badRecruit = run(order('north', 'north', { kind: 'recruit', regionId: 'b2', unitType: 'riverfleet', count: 1000 }));
  assert.equal(badRecruit.rejected[0]?.code, 'UNIT_DOMAIN_MISMATCH', '非港口征募水师必须被拒');

  const goodRecruit = run(order('north', 'north', { kind: 'recruit', regionId: 'b3', unitType: 'riverfleet', count: 1000 }));
  assert.deepEqual(goodRecruit.rejected, []);
  const spawned = goodRecruit.state.units['u_north_1_b3_riverfleet'];
  assert.ok(spawned, '港口征募应生成确定性 unit id');
  assert.equal(spawned!.typeId, 'riverfleet');
  assert.equal(spawned!.regionId, 'b3');
});

test('★水师跨水突击港口：不被 REGION_NOT_ADJACENT 拒绝，并产生战斗证据', () => {
  const out = run(order('north', 'north', { kind: 'attack', unitId: 'u_north_3', targetRegion: 'c1' }));
  assert.equal(
    out.rejected.some((r) => r.code === 'REGION_NOT_ADJACENT'),
    false,
    `跨水路突击不应走陆军邻接拒绝：${JSON.stringify(out.rejected)}`,
  );
  const events = out.events as DomainEvent[];
  const combats = events.filter(
    (e): e is Extract<DomainEvent, { type: 'combat_resolved' }> => e.type === 'combat_resolved',
  );
  assert.equal(combats.length, 1, '应产生一场跨水战斗');
  assert.equal(combats[0]!.regionId, 'c1');
});
