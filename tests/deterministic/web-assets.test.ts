/**
 * 网页客户端静态闸门。
 *
 * 起因：首轮浏览器实测时，app.js 连接成功后去拿 `$('connectDrawer')`，
 * 而 HTML 里表单的 id 叫 `connectForm` —— 结果快照都加载完了，
 * 却在最后一步抛 `Cannot read properties of null (reading 'classList')`，
 * 连接徽标与事件流全断。这种错不会让任何后端测试变红，只有人手点才会发现。
 *
 * 本闸门把"手点才会发现"的那一类变成可复现：
 *   ① app.js 引用的每个 DOM id 必须存在于 index.html；
 *   ② index.html 的 id 不重复；
 *   ③ 页面入口引用的静态文件都在；
 *   ④ app.js / map-view.js 通过 `node --check`（语法至少是合法的）；
 *   ⑤ map-view.js 确实导出 app.js 需要的那几个符号。
 *
 * 变异自检：
 *   · 把 app.js 里任一 `$('...')` 改成不存在的 id → ① 红；
 *   · 在 index.html 里重复一个 id → ② 红；
 *   · 删掉 web/style.css → ③ 红；
 *   · 把 map-view.js 的 `export` 删掉 → ⑤ 红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const appPath = join(ROOT, 'web', 'app.js');
const mapPath = join(ROOT, 'web', 'map-view.js');
const htmlPath = join(ROOT, 'web', 'index.html');
const cssPath = join(ROOT, 'web', 'style.css');
const clientPath = join(ROOT, 'extensions', 'sillytavern-guozhan', 'lib', 'client.js');

const appSource = readFileSync(appPath, 'utf8');
const mapSource = readFileSync(mapPath, 'utf8');
const htmlSource = readFileSync(htmlPath, 'utf8');

test('app.js 引用的每个 DOM id 都存在于 index.html（防 connectDrawer 那类空引用）', () => {
  const htmlIds = new Set<string>();
  for (const m of htmlSource.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]!);

  const refs = new Set<string>();
  for (const m of appSource.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) refs.add(m[1]!);
  for (const m of appSource.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) refs.add(m[1]!);

  const missing = [...refs].filter((id) => !htmlIds.has(id)).sort();
  assert.deepEqual(
    missing,
    [],
    `app.js 引用了 index.html 中不存在的 id：${missing.join('、')}\n` +
    `（这类错误在浏览器里表现为 null.classList / null.textContent，后端测试抓不到）`,
  );
});

test('index.html 的 id 唯一（getElementById 只会拿到第一个，重复即静默错配）', () => {
  const counts = new Map<string, number>();
  for (const m of htmlSource.matchAll(/\bid="([^"]+)"/g)) {
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const dup = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
  assert.deepEqual(dup, [], `以下 id 在 index.html 重复：${dup.join('、')}`);
});

test('页面入口的静态文件齐全：style.css / app.js / map-view.js / 共享传输层', () => {
  for (const path of [cssPath, appPath, mapPath, clientPath]) {
    assert.equal(existsSync(path), true, `静态文件缺失：${path}`);
  }
  assert.match(htmlSource, /<link[^>]+href="\.\/style\.css"/, 'index.html 未加载 style.css');
  assert.match(htmlSource, /<script[^>]+type="module"[^>]+src="\.\/app\.js"/, 'index.html 未以 ES module 加载 app.js');
  assert.match(appSource, /from\s+'\.\/map-view\.js'/, 'app.js 未从 map-view.js 导入渲染器');
  assert.match(appSource, /sillytavern-guozhan\/lib\/client\.js/, '网页端必须复用酒馆扩展的传输层');
});

test('两个前端模块通过 node --check（语法错误不得拖到浏览器才暴露）', () => {
  for (const path of [appPath, mapPath]) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' }),
      `${path} 存在语法错误`,
    );
  }
});

test('map-view.js 导出 app.js 依赖的符号', async () => {
  const mod = await import(pathToFileURL(mapPath).href);
  for (const name of ['createMapView', 'ACTION_KIND_META', 'TERRAIN_META', 'FALLBACK_FACTION_COLORS']) {
    assert.equal(typeof mod[name] !== 'undefined', true, `map-view.js 缺少导出：${name}`);
  }
  assert.equal(typeof mod.createMapView, 'function');
  assert.equal(typeof mod.ACTION_KIND_META.attack, 'object');
});

test('势力显示色对比度：深色势力被提亮，且彼此可区分', async () => {
  const { displayFactionColor } = await import(
    pathToFileURL(join(ROOT, 'web', 'faction-colors.js')).href
  );
  const factions = JSON.parse(
    readFileSync(join(ROOT, 'config', 'scenarios', 'warring-states', 'factions.json'), 'utf8'),
  ).factions as Array<{ id: string; color: string }>;
  const colors = factions.map((f) => ({ id: f.id, hex: displayFactionColor(f.color, f.id) }));
  const rgb = (hex: string) => {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255] as const;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = rgb(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  for (const { id, hex } of colors) {
    assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(luminance(hex) > 0.25, `${id} 的显示色仍太暗：${hex}`);
  }
  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const a = rgb(colors[i]!.hex);
      const b = rgb(colors[j]!.hex);
      minDistance = Math.min(minDistance, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  assert.ok(minDistance >= 50, `势力显示色过于接近，最小 RGB 距离 ${minDistance.toFixed(1)}`);
  const qin = colors.find((c) => c.id === 'qin');
  assert.ok(qin && luminance(qin.hex) > 0.5, '秦的黑色必须被显示色提亮');
});

test('六角地图不出现 emoji 图标（项目约定：UI 只用文字/符号字形）', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u;
  const files: Array<[string, string]> = [
    ['app.js', appSource],
    ['map-view.js', mapSource],
    ['index.html', htmlSource],
  ];
  for (const [name, source] of files) {
    const hit = emoji.exec(source);
    assert.equal(hit, null, `${name} 含 emoji 字符：${hit?.[0] ?? ''}`);
  }
});
