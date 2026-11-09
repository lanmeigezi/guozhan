/**
 * 随机六角地图闸门。
 *
 * 验收四件事：
 *   ① 同种子逐位可复现（contentHash / 布局 / 初始状态 digest 全同）；
 *   ② 换种子必须真的换地图（否则"随机"是死的）；
 *   ③ 每张生成图都合法：领地连通、每家都有港口/水师、至少一处接壤战争、
 *      水路连通、桥确实是跨水域的普通邻接、无 NaN/undefined；
 *   ④ 多跑几个种子，避免"某一张碰巧能过"的假绿。
 *
 * 变异自检：
 *   · 把 generator 里的 rng 换成 Math.random ⇒ 同种子用例红；
 *   · 把种子从指纹/生成输入里拿掉 ⇒ 换种子用例红；
 *   · 去掉港口分配 ⇒ 每家水师/港口用例红；
 *   · 删掉一座桥 ⇒ 连通性/桥用例红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findHoles, loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { MapLayoutSchema } from '../../src/protocol/map-layout.ts';
import { isAdjacent, type GameState, type WorldConfig } from '../../src/core/state.ts';

const CONFIG = 'config';
const SEEDS = ['alpha-seed', 'beta-seed', 'gamma-seed', 'delta-seed', 'epsilon-seed'];
const digest = (s: GameState): string => sha256(stableStringify(s));

function load(seed: string) {
  return loadScenario('random-front', seed, CONFIG);
}

function landIds(world: WorldConfig): string[] {
  return Object.keys(world.regions).sort();
}

test('★随机地图：同种子逐位可复现；不同种子确实不同', () => {
  const a = load('repeat-seed');
  const b = load('repeat-seed');
  assert.equal(a.contentHash, b.contentHash, '同种子 contentHash 必须相同');
  assert.deepEqual(a.mapLayout, b.mapLayout, '同种子布局必须逐位相同');
  assert.equal(digest(a.initialState), digest(b.initialState), '同种子初始状态 digest 必须相同');
  assert.equal(a.rootSeed, 'repeat-seed');

  const hashes = new Set<string>();
  const layouts = new Set<string>();
  for (const seed of SEEDS) {
    const s = load(seed);
    hashes.add(s.contentHash);
    layouts.add(stableStringify(s.mapLayout));
  }
  assert.equal(hashes.size, SEEDS.length, `不同种子应生成不同地图，实际只有 ${hashes.size} 种`);
  assert.equal(layouts.size, SEEDS.length, '不同种子的布局也不应完全相同');
});

test('★随机地图合法性：多 Seeds 逐张校验连通/领地/港口/水师/战争/桥/水路', () => {
  for (const seed of SEEDS) {
    const sc = load(seed);
    const { world, initialState: state, mapLayout } = sc;
    const layout = MapLayoutSchema.parse(mapLayout);
    const regions = landIds(world);
    const factionIds = Object.keys(state.factions).sort();
    assert.equal(factionIds.length, 4, `${seed}: 应有 4 个势力`);

    // 地图与布局覆盖
    assert.equal(layout.kind, 'hexboard');
    assert.equal(layout.regions.length, regions.length, `${seed}: 布局必须覆盖全部陆地`);
    assert.ok((layout.waterCells?.length ?? 0) >= 4, `${seed}: 至少要有几块水格`);
    assert.ok((layout.bridges?.length ?? 0) >= 1, `${seed}: 至少一座桥`);
    assert.ok((layout.ports?.length ?? 0) >= 4, `${seed}: 至少四个港口`);
    const layoutIds = new Set(layout.regions.map((r) => r.id));
    for (const id of regions) assert.ok(layoutIds.has(id), `${seed}: 布局缺格 ${id}`);

    // 规则图：对称、无自环、连通
    for (const id of regions) {
      const def = world.regions[id]!;
      for (const n of def.adjacency) {
        assert.ok(world.regions[n], `${seed}: ${id} 的邻居 ${n} 不存在`);
        assert.notEqual(n, id);
        assert.ok(world.regions[n]!.adjacency.includes(id), `${seed}: 邻接不对称 ${id}-${n}`);
      }
      assert.deepEqual(def.adjacency, [...def.adjacency].sort(), `${seed}: ${id}.adjacency 未排序`);
    }
    const seen = new Set<string>([regions[0]!]);
    const stack = [regions[0]!];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const n of world.regions[cur]!.adjacency) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    assert.equal(seen.size, regions.length, `${seed}: 陆地邻接图必须连通`);

    // 每个区域恰好一个势力；每家 >=3 块且连通；首都在自家
    const ownedBy = new Map<string, string>();
    for (const fid of factionIds) {
      const f = state.factions[fid]!;
      const own = regions.filter((id) => state.regions[id]!.owner === fid);
      assert.ok(own.length >= 3, `${seed}/${fid}: 领地过小 ${own.length}`);
      assert.equal(state.regions[f.capital]?.owner, fid, `${seed}/${fid}: 首都不属于自己`);
      assert.ok(own.includes(f.capital), `${seed}/${fid}: 首都未在自家领地`);
      // 自家领地在普通邻接上连通
      const start = f.capital;
      const reachable = new Set<string>([start]);
      const q = [start];
      while (q.length > 0) {
        const cur = q.pop()!;
        for (const n of world.regions[cur]!.adjacency) {
          if (!reachable.has(n) && state.regions[n]?.owner === fid) { reachable.add(n); q.push(n); }
        }
      }
      assert.equal(reachable.size, own.length, `${seed}/${fid}: 自家领地不连通`);
      for (const id of own) {
        assert.equal(ownedBy.get(id), undefined, `${seed}: 区域 ${id} 被两家同时拥有`);
        ownedBy.set(id, fid);
      }
      assert.ok(own.some((id) => world.regions[id]?.port === true), `${seed}/${fid}: 领地内没有港口`);
      const waterUnits = Object.values(state.units).filter(
        (u) => u.ownerId === fid && world.unitTypes[u.typeId]?.domain === 'water',
      );
      assert.ok(waterUnits.length >= 1, `${seed}/${fid}: 没有水师`);
      for (const u of waterUnits) {
        assert.equal(world.regions[u.regionId]?.port, true, `${seed}/${fid}: 水师 ${u.id} 不在港口`);
      }
    }
    assert.equal(ownedBy.size, regions.length, `${seed}: 有陆地无人拥有`);

    // 战争至少一场，且战争双方在普通邻接上接壤
    const wars = Object.entries(state.relations).filter(([, r]) => r.kind === 'war');
    assert.ok(wars.length >= 1, `${seed}: 至少应有一场战争`);
    for (const [key] of wars) {
      const [a, b] = key.split('|') as [string, string];
      const adjacent = regions.some((id) =>
        state.regions[id]?.owner === a &&
        world.regions[id]!.adjacency.some((n) => state.regions[n]?.owner === b),
      );
      assert.ok(adjacent, `${seed}: 战争双方 ${a}/${b} 不接壤`);
    }

    // 水路：端点都是港口、全港口通达
    const ports = layout.ports ?? [];
    for (const route of world.waterRoutes) {
      assert.equal(world.regions[route.a]?.port, true, `${seed}: 水路端点 ${route.a} 不是港口`);
      assert.equal(world.regions[route.b]?.port, true, `${seed}: 水路端点 ${route.b} 不是港口`);
    }
    const waterGraph = new Map(ports.map((p) => [p, [] as string[]]));
    for (const route of world.waterRoutes) {
      waterGraph.get(route.a)?.push(route.b);
      waterGraph.get(route.b)?.push(route.a);
    }
    const waterSeen = new Set<string>([ports[0]!]);
    const waterQueue = [ports[0]!];
    while (waterQueue.length > 0) {
      const cur = waterQueue.pop()!;
      for (const n of waterGraph.get(cur) ?? []) if (!waterSeen.has(n)) { waterSeen.add(n); waterQueue.push(n); }
    }
    assert.equal(waterSeen.size, ports.length, `${seed}: 水路网络未连通全部港口`);

    // 桥：每条布局桥都是普通邻接，且两端距离大于普通六角邻居
    const pos = new Map(layout.regions.map((r) => [r.id, r]));
    for (const bridge of layout.bridges ?? []) {
      const a = pos.get(bridge.a);
      const b = pos.get(bridge.b);
      assert.ok(a && b, `${seed}: 桥端点不在布局`);
      assert.equal(isAdjacent(world, bridge.a, bridge.b), true, `${seed}: 桥 ${bridge.a}-${bridge.b} 不是普通邻接`);
      assert.ok(
        Math.hypot(a!.x - b!.x, a!.y - b!.y) > layout.hexSize! * 1.6,
        `${seed}: 桥两端太近，不像跨水域`,
      );
    }

    assert.deepEqual(findHoles(world), [], `${seed}: WorldConfig 有 NaN/undefined`);
    assert.deepEqual(findHoles(state), [], `${seed}: GameState 有 NaN/undefined`);
  }
});

test('随机地图的势力花名册稳定：四家固定 id，跨种子可预测', () => {
  for (const seed of ['s1', 's2']) {
    const sc = load(seed);
    assert.deepEqual(Object.keys(sc.initialState.factions).sort(), ['east', 'north', 'south', 'west']);
    assert.equal(Object.keys(sc.initialState.units).length, 12, '四家各 3 支部队');
  }
});
