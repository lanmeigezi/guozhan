/**
 * 六角地图布局闸门 —— 让"可视化"也有可证伪的验收，而不是肉眼看着差不多。
 *
 * 覆盖四类事故：
 *   ① 布局漏一个区域 ⇒ 该格永远画不出来（地图少一块，玩家无法下令）；
 *   ② 两格中心太近 ⇒ 六角重叠，文字/兵力数字互相盖住；
 *   ③ 越界 ⇒ 缩放后有一半在画布外；
 *   ④ 布局里混入 name/owner/terrain ⇒ 静态端点成了战争迷雾的旁路。
 *
 * 变异自检：
 *   · 删掉 regions 里任意一项 → "覆盖"用例红；
 *   · 把两个坐标改成相同值 → "重叠"用例红；
 *   · 给某格加 "name" 字段 → 严格形状用例红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadScenario } from '../../src/server/config-loader.ts';
import { HexLayoutFileSchema, MapLayoutSchema } from '../../src/protocol/map-layout.ts';

const ROOT = 'config';
const regionsDoc = JSON.parse(readFileSync(join(ROOT, 'map', 'regions.json'), 'utf8')) as {
  regions: Array<{ id: string; name: string; adjacency: string[] }>;
};
const rawLayout = JSON.parse(readFileSync(join(ROOT, 'map', 'layout.json'), 'utf8')) as Record<string, unknown>;
const layoutFile = HexLayoutFileSchema.parse({
  canvas: rawLayout['canvas'],
  hexSize: rawLayout['hexSize'],
  regions: rawLayout['regions'],
});

const regionIds = regionsDoc.regions.map((r) => r.id);
const regionById = new Map(regionsDoc.regions.map((r) => [r.id, r]));

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test('布局区域与 regions.json 一一对应（不多不少）', () => {
  const laidOut = layoutFile.regions.map((r) => r.id);
  assert.deepEqual(
    [...laidOut].sort(),
    [...regionIds].sort(),
    '布局覆盖与地图区域表不一致：漏掉的格子画不出来，多出的格子没有规则实体',
  );
  assert.equal(new Set(laidOut).size, laidOut.length, '布局存在重复区域 id');
});

test('布局按 id 字典序排列（避免 JSON 顺序变化制造无意义 diff）', () => {
  const ids = layoutFile.regions.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort(), 'layout.json 的 regions 必须按 id 排序');
});

test('六角格不重叠：任意两格中心距 ≥ 2×hexSize+4', () => {
  const tooClose: string[] = [];
  const minAllowed = layoutFile.hexSize * 2 + 4;
  for (let i = 0; i < layoutFile.regions.length; i++) {
    for (let j = i + 1; j < layoutFile.regions.length; j++) {
      const a = layoutFile.regions[i]!;
      const b = layoutFile.regions[j]!;
      const d = distance(a, b);
      if (d < minAllowed) tooClose.push(`${a.id}↔${b.id}=${d.toFixed(1)} < ${minAllowed}`);
    }
  }
  assert.deepEqual(tooClose, [], `以下六角格重叠或过近：\n  ${tooClose.join('\n  ')}`);
});

test('六角格完整落在画布内（含外接圆半径）', () => {
  const { width, height } = layoutFile.canvas;
  const r = layoutFile.hexSize;
  const out: string[] = [];
  for (const reg of layoutFile.regions) {
    if (reg.x - r < 0 || reg.y - r < 0 || reg.x + r > width || reg.y + r > height) {
      out.push(`${reg.id}(${reg.x},${reg.y}) 半径 ${r} 超出 ${width}×${height}`);
    }
  }
  assert.deepEqual(out, [], `以下格子在画布外：\n  ${out.join('\n  ')}`);
});

test('★布局不得夹带迷雾信息：每格只允许 id/x/y 三个字段', () => {
  for (const reg of rawLayout['regions'] as Array<Record<string, unknown>>) {
    assert.deepEqual(
      Object.keys(reg).sort(),
      ['id', 'x', 'y'],
      `${String(reg['id'])} 的布局字段夹带了非展示信息；归属/兵力必须走投影后的 Snapshot`,
    );
  }
});

test('邻接道路长度可读：任意一条道路 ≤ 460px（否则格子在棋盘上放错了）', () => {
  const byId = new Map(layoutFile.regions.map((r) => [r.id, r]));
  const bad: string[] = [];
  for (const reg of regionsDoc.regions) {
    for (const n of reg.adjacency) {
      if (reg.id > n) continue; // 每条无向边只查一次
      const a = byId.get(reg.id);
      const b = byId.get(n);
      assert.ok(a && b, `布局缺格：${reg.id} / ${n}`);
      const d = distance(a!, b!);
      if (d > 460) bad.push(`${reg.id}↔${n}=${d.toFixed(0)}px`);
    }
  }
  assert.deepEqual(bad, [], `以下道路过长，视觉上会像跨海连线：${bad.join('、')}`);
});

test('两剧本都能装配布局：覆盖率 19、阵营色合法、首都落在自己领地', () => {
  for (const scenarioId of ['warring-states', 'aria']) {
    const loaded = loadScenario(scenarioId, `layout-gate-${scenarioId}`, ROOT);
    const layout = MapLayoutSchema.parse(loaded.mapLayout);

    assert.equal(layout.regions.length, regionIds.length, `${scenarioId} 布局区域数不对`);
    assert.deepEqual(
      layout.regions.map((r) => r.id).sort(),
      [...regionIds].sort(),
      `${scenarioId} 布局覆盖不完整`,
    );

    for (const [fid, color] of Object.entries(layout.factionColors)) {
      assert.match(color, /^#[0-9a-f]{6}$/, `${scenarioId}/${fid} 颜色不合法：${color}`);
    }
    assert.equal(
      Object.keys(layout.factionColors).length,
      Object.keys(loaded.initialState.factions).length,
      `${scenarioId} 有势力缺颜色`,
    );
    assert.equal(new Set(Object.values(layout.factionColors)).size, Object.keys(layout.factionColors).length,
      `${scenarioId} 阵营色重复，地图上无法区分势力`);

    for (const [fid, capital] of Object.entries(layout.capitals)) {
      assert.ok(regionById.has(capital), `${scenarioId}/${fid} 首都 ${capital} 不在区域表`);
      assert.equal(
        loaded.initialState.regions[capital]?.owner,
        fid,
        `${scenarioId}/${fid} 的首都 ${capital} 开局不属于自己 —— 星标会标错人`,
      );
    }
  }
});
