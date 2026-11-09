/**
 * 超大陆剧本闸门。
 *
 * 锁住：
 *   ① 12 势力 / 100+ 区域 / 半径 6 地图可生成；
 *   ② 同种子逐位可复现，换种子换图；
 *   ③ 每家领地在规则图上连通、至少 4 区，且有港口与水师；
 *   ④ 旧 random-front / random-front-v2 的 contentHash 不受大地图改动影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, sha256, stableStringify } from '../../src/server/config-loader.ts';
import { MapLayoutSchema } from '../../src/protocol/map-layout.ts';
import type { GameState, WorldConfig } from '../../src/core/state.ts';

const CONFIG = 'config';
const digest = (s: GameState): string => sha256(stableStringify(s));
const fixtures = ['grand-seed-a', 'grand-seed-b', 'grand-seed-c'].map((seed) => ({
  seed,
  sc: loadScenario('grand-front', seed, CONFIG),
}));

function landIds(world: WorldConfig): string[] {
  return Object.keys(world.regions).sort();
}

function connected(world: WorldConfig, ids: readonly string[]): boolean {
  if (ids.length === 0) return true;
  const allowed = new Set(ids);
  const seen = new Set<string>([ids[0]!]);
  const stack = [ids[0]!];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const n of world.regions[cur]?.adjacency ?? []) {
      if (!allowed.has(n) || seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return seen.size === ids.length;
}

test('★超大陆：12 势力 / 100+ 区域 / 同种子逐位复现', () => {
  const [first, second] = fixtures;
  assert.ok(first && second);
  const a = loadScenario('grand-front', first.seed, CONFIG);
  const b = loadScenario('grand-front', second.seed, CONFIG);
  assert.equal(a.contentHash, first.sc.contentHash, '同种子 contentHash 必须相同');
  assert.deepEqual(a.mapLayout, first.sc.mapLayout, '同种子布局必须相同');
  assert.equal(digest(a.initialState), digest(first.sc.initialState));
  assert.notEqual(a.contentHash, b.contentHash, '不同种子必须换图');
  assert.equal(Object.keys(a.initialState.factions).length, 12);
  assert.ok(landIds(a.world).length >= 100, `区域数应 >=100，实得 ${landIds(a.world).length}`);
  const layout = MapLayoutSchema.parse(a.mapLayout);
  assert.equal(layout.kind, 'hexboard');
  assert.equal(layout.regions.length, landIds(a.world).length);
  assert.ok((layout.ports?.length ?? 0) >= 12, '每个势力至少一个港口');
});

test('★超大陆：每家领地连通、>=4 区、有港口/水师、桥与水路合法', () => {
  for (const { seed, sc } of fixtures) {
    const world = sc.world;
    const state = sc.initialState;
    const layout = MapLayoutSchema.parse(sc.mapLayout);
    const factions = Object.keys(state.factions).sort();
    assert.equal(factions.length, 12, `${seed}: 12 势力`);
    const portSet = new Set(layout.ports ?? []);
    const waterTypes = new Set(
      Object.values(world.unitTypes).filter((u) => u.domain === 'water').map((u) => u.id),
    );
    for (const fid of factions) {
      const owned = Object.keys(state.regions).filter((rid) => state.regions[rid]?.owner === fid).sort();
      assert.ok(owned.length >= 4, `${seed}: ${fid} 只有 ${owned.length} 区`);
      assert.ok(connected(world, owned), `${seed}: ${fid} 领地不连通`);
      const units = Object.values(state.units).filter((u) => u.ownerId === fid);
      assert.ok(units.some((u) => (world.unitTypes[u.typeId]?.domain ?? 'land') !== 'water'), `${seed}: ${fid} 没有陆军`);
      if (waterTypes.size > 0) {
        assert.ok(units.some((u) => waterTypes.has(u.typeId)), `${seed}: ${fid} 没有水师`);
        assert.ok(units.some((u) => waterTypes.has(u.typeId) && portSet.has(u.regionId)), `${seed}: ${fid} 水师不在港口`);
      }
    }
    assert.ok((layout.bridges?.length ?? 0) >= 1, `${seed}: 至少一座桥`);
    assert.ok((layout.waterRoutes?.length ?? 0) >= 11, `${seed}: 12 港口应形成连通水路`);
  }
});

test('★旧随机图的 contentHash 不被大地图生成器改动', () => {
  const v1 = loadScenario('random-front', 'legacy-hash-check', CONFIG);
  const v2 = loadScenario('random-front-v2', 'legacy-hash-check', CONFIG);
  // 0.7.0 基线；大地图分支只应在 roster>4 或 radius>3 时生效。
  assert.equal(v1.contentHash, 'b8d3903899cfae0c505b193977c94846c64eab0267dd29c771c7da9721aaad70');
  assert.equal(v2.contentHash, 'de8053406ffffe4fa00e69b9540d4bdc4a1d8e2e1b2b3e128154676a93aff837');
  assert.equal(Object.keys(v1.initialState.factions).length, 4);
  assert.equal(Object.keys(v2.initialState.factions).length, 4);
});
