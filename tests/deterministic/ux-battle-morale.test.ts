/**
 * 网页可读性闸门：战斗时间线 + 民心/动乱/基建说明必须真的接到 DOM 与渲染器上。
 *
 * 这类改动最容易"后端全绿、浏览器一片空白"：接口字段有了，但 UI 没渲染。
 * 本文件只做静态对账（DOM id 存在性/关键文案/渲染器方法），真实浏览器交互由人工实测补足。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadScenario } from '../../src/server/config-loader.ts';
import { MapLayoutSchema } from '../../src/protocol/map-layout.ts';
import { enumerateLegalActions } from '../../src/core/legal.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const app = read('web/app.js');
const map = read('web/map-view.js');
const html = read('web/index.html');
const css = read('web/style.css');

test('战斗可视化 DOM 与播放器方法齐备', () => {
  for (const id of ['battleHud', 'battleHudTitle', 'battleHudStep', 'battleHudSides', 'battleHudMeta', 'battleHudStatus', 'battleHudLocate', 'battleHudSkip', 'battleHudClose', 'battleReport', 'battleTurn']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html 缺少 ${id}`);
    assert.match(app, new RegExp(`\\$\\('${id}'\\)`), `app.js 未使用 ${id}（DOM 可能只是摆设）`);
  }
  for (const method of ['playBattle', 'showBattleMarkers', 'clearBattleMarkers', 'focusRegion']) {
    assert.match(map, new RegExp(`function ${method}\\(`), `map-view.js 缺少 ${method}`);
  }
  assert.match(map, /battle-strike/, '进攻箭头样式未接入');
  assert.match(map, /is-battle-now/, '战场高亮样式未接入');
  assert.match(app, /playBattleSequence/, 'app.js 缺少逐场战斗时间线');
  assert.match(app, /skipBattlePlayback/, '必须能跳过战斗动画（长回合不能锁住页面）');
  assert.match(app, /战斗结束/, 'UI 必须有明确的"战斗结束"提示');
  assert.match(css, /\.battle-hud\b/, 'style.css 缺少 .battle-hud');
  assert.match(css, /\.battle-report\b/, 'style.css 缺少 .battle-report');
});

test('全国民心与地区动乱的文案/面板分明', () => {
  assert.match(app, /全国民心/, 'UI 必须明确写"全国民心"');
  assert.match(app, /地区动乱/, 'UI 必须明确写"地区动乱"');
  assert.match(app, /低民心/, 'UI 必须解释低民心对动乱的放大');
  assert.match(app, /战力系数/, 'UI 必须显示民心→战力系数');
  assert.match(css, /\.morale-card\b/, 'style.css 缺少民心卡');
  assert.match(css, /\.morale-meter\b/, 'style.css 缺少民心刻度条');
  assert.match(html, /全国民心/, '势力表头必须写全国民心');
});

test('基建动作在合法空间与 UI 中都可见，并说明三项效果', () => {
  const loaded = loadScenario('random-front-v2', 'ux-ui-seed', 'config');
  const layout = MapLayoutSchema.parse(loaded.mapLayout);
  assert.ok(layout.rules?.infrastructure, 'layout 必须下发基建帮助信息');
  assert.ok(layout.rules?.lowMorale, 'layout 必须下发低民心动乱参数');
  assert.ok(layout.rules?.unrestEffects, 'layout 必须下发地区动乱惩罚参数');
  assert.equal(layout.rules!.infrastructure!.levels.length, layout.rules!.infrastructure!.maxLevel);

  const fid = Object.keys(loaded.initialState.factions).sort()[0]!;
  const actions = enumerateLegalActions(loaded.initialState, loaded.world, fid, { maxActions: 60 });
  const infra = actions.find((a) => a.kind === 'build_infrastructure');
  assert.ok(infra, '合法空间必须包含基建');
  assert.match(String(infra!.description), /本区动乱.*本区人口.*全国民心/s);

  assert.match(map, /build_infrastructure: \{ icon: '基'/, '地图动作元数据缺少基建');
  assert.match(app, /build_infrastructure/, '动作筛选/分组缺少基建');
  assert.match(app, /每 6 点 \+1 全国民心/, 'UI 必须解释基建点如何汇总为全国民心');
  assert.match(css, /\.detail-note--infra\b/, 'style.css 缺少基建说明样式');
});

test('战斗证据字段（民心系数/动乱拆分/航线）被 UI 消费', () => {
  for (const field of ['moraleFactorAttacker', 'moraleFactorDefender', 'lowMoraleFactor', 'defenderUnrestFactor', 'attackPath']) {
    assert.match(app, new RegExp(field), `app.js 未消费战斗证据字段 ${field}`);
  }
});

test('兵种图鉴：数值/成本/克制关系随 layout 下发并被 UI 渲染', () => {
  const loaded = loadScenario('random-front-v2', 'unit-codex-seed', 'config');
  const layout = MapLayoutSchema.parse(loaded.mapLayout);
  assert.ok(Array.isArray(layout.units) && layout.units.length >= 6, 'layout.units 必须包含兵种图鉴');
  const spearman = layout.units!.find((u) => u.id === 'spearman')!;
  assert.equal(spearman.counters.cavalry, 0.5, '槍兵对騎兵 +50% 必须随 layout 下发');
  assert.ok(layout.units!.every((u) => u.attack >= 0 && u.defense >= 0 && u.movement >= 0));
  assert.match(html, /id="unitCodex"/, 'index.html 缺兵种图鉴容器');
  assert.match(app, /renderUnitCodex/, 'app.js 未渲染兵种图鉴');
  assert.match(app, /克制/, 'UI 必须显示克制关系');
  assert.match(css, /\.unit-codex\b/, 'style.css 缺兵种图鉴样式');
  assert.match(css, /\.unit-counters\b/, 'style.css 缺克制关系样式');
  assert.match(app, /counterBonus/, '战斗动作/战报必须消费克制加成');
});

test('分兵/合兵/裁军在 UI 动作层可见', () => {
  assert.match(map, /split_unit: \{ icon: '分'/, '地图动作元数据缺分兵');
  assert.match(map, /merge_units: \{ icon: '合'/, '地图动作元数据缺合兵');
  assert.match(app, /'split_unit', 'merge_units'/, '动作分组缺分兵/合兵');
  assert.match(app, /分兵 \/ 合兵/, '区域详情缺分兵/合兵分组');
  assert.match(app, /裁军/, '区域详情缺裁军分组');
});

test('外交面板 / 地块快捷操作 / 终局提示都接到 DOM', () => {
  for (const id of ['diplomacyPanel', 'regionActions']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html 缺少 ${id}`);
    assert.match(app, new RegExp(`\\$\\('${id}'\\)`), `app.js 未使用 ${id}`);
  }
  assert.match(html, /外交/, 'index.html 缺少外交面板标题');
  assert.match(app, /renderDiplomacy/, 'app.js 缺少外交面板渲染');
  assert.match(app, /renderRegionActions/, 'app.js 缺少地块快捷操作渲染');
  assert.match(app, /send_spy/, 'app.js 未接入间谍动作');
  assert.match(map, /send_spy: \{ icon: '谍'/, '地图动作元数据缺少谍报');
  assert.match(css, /\.diplomacy-panel\b/, 'style.css 缺少外交面板样式');
  assert.match(css, /\.region-action\b/, 'style.css 缺少地块快捷操作样式');
  assert.match(app, /endReasonLabel/, '终局必须显示明确原因');
  assert.match(css, /\.game-over\b/, 'style.css 缺少终局提示样式');
});
