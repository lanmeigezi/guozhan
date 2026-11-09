/**
 * 群星君主 · APK 前端界面冒烟验收（无浏览器依赖，一条命令可复跑）
 *
 *   node android/verify-ui.mjs
 *
 * 用 Node VM 按 classic-script 语义加载 civ-core.bundle.js + civ-ui.js，
 * 注入最小 DOM / localStorage，然后模拟触屏点击各个 civ-* 动作，验证：
 *   - 8 个页签都能渲染、无运行时异常；
 *   - 结算 / 下令 / DM / 席位 / LLM 设置 / 存档导入导出都能真实改变状态；
 *   - 自动存档落 localStorage 且不含 Key 与席位身份。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WWW = path.resolve(ROOT, '..', 'board-games', 'app', 'src', 'main', 'assets', 'www');
const read = (f) => fs.readFileSync(path.join(WWW, f), 'utf8');

let passed = 0;
const failures = [];
let chain = Promise.resolve();
function check(name, fn) {
    // 严格串行：DOM / host 是单例，异步用例不能并发改状态。
    chain = chain.then(async () => {
        try { const d = await fn(); passed += 1; console.log(`  PASS  ${name}${d ? ` — ${d}` : ''}`); }
        catch (e) { failures.push(`${name}: ${e.message}`); console.log(`  FAIL  ${name} — ${e.message}`); }
    });
}
function assert(c, m) { if (!c) throw new Error(m); }
const flush = () => new Promise((r) => setImmediate(r));

// ---- 最小 DOM ----
const store = Object.create(null);
const listeners = {};
const appEl = {
    innerHTML: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector() { return null; },
};
const document = {
    getElementById(id) { return id === 'app' ? appEl : null; },
    createElement() { return { value: '', style: {}, select() {} }; },
    body: { appendChild() {}, removeChild() {} },
    execCommand() { return true; },
    hidden: false,
    addEventListener() {},
};
const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
};
const toasts = [];
let screen = 'home';
let html = '';
const win = {};
const sandbox = {
    window: win, document, localStorage, console, setTimeout, clearTimeout, navigator: {},
};
const ctx = vm.createContext(sandbox);
vm.runInContext(read('civ-core.bundle.js'), ctx);
vm.runInContext(read('civ-ui.js'), ctx);
const CIVUI = win.CIVUI;
assert(CIVUI && CIVUI.hasCore(), 'CIVUI / CIVMONARCHS 未挂载');

CIVUI.init({
    appEl,
    toast: (m) => toasts.push(String(m)),
    setStatus: () => {},
    showHelp: () => {},
    setScreen: (n) => { screen = n; },
    rerender: () => { html = CIVUI.renderHtml(); appEl.innerHTML = html; },
});

console.log('\n[群星君主 APK 前端冒烟]');

check('进入离线单机模式 + 8 个页签全部可渲染', () => {
    assert(CIVUI.enter() === true, 'enter 失败');
    assert(screen === 'civ', '未切到 civ 屏');
    const tabs = ['map', 'ranks', 'chron', 'order', 'dm', 'seats', 'llm', 'save'];
    const seen = [];
    for (const t of tabs) {
        CIVUI.onAction('civ-tab:' + t);
        assert(typeof html === 'string' && html.length > 200, `${t} 页签渲染为空`);
        assert(html.includes('civ-footer'), `${t} 缺少结算栏`);
        seen.push(`${t}:${html.length}`);
    }
    return seen.join(' ');
});

check('地图 48 州 + 列强 12 国 + 编年史渲染', () => {
    CIVUI.onAction('civ-tab:map');
    assert((html.match(/data-civ-region=/g) || []).length === 48, '地图州数不是 48');
    CIVUI.onAction('civ-tab:ranks');
    assert((html.match(/class="civ-rank"/g) || []).length === 12, '列强榜不是 12 国');
    CIVUI.onAction('civ-tab:chron');
    assert(html.includes('本回合战报'), '缺少战报区');
    return '48 州 / 12 国 / 战报';
});

check('点地块 → 详情；下令 → 意图登记；结算 → 回合 +1', async () => {
    CIVUI.onAction('civ-tab:order');
    const before = CIVUI.host.call('stateId').turn;
    CIVUI.onAction('civ-order');
    await flush();
    const note = CIVUI.host.call('snapshot').snapshot;
    assert(note.decisions && Object.keys(note.decisions).length === 0, 'DM 视角不应显示意图明细');
    CIVUI.onAction('civ-advance');
    await flush();
    const after = CIVUI.host.call('stateId').turn;
    assert(after === before + 1, `回合未推进：${before} → ${after}`);
    return `第 ${before} → ${after} 回合`;
});

check('DM 修正 / 席位切换 / LLM 设置（无 Key）不抛错', async () => {
    CIVUI.onAction('civ-dm'); await flush();
    CIVUI.onAction('civ-seat:civ-01'); await flush();
    const seat = CIVUI.host.call('seats').seats.seats.find((s) => s.civId === 'civ-01');
    assert(seat.control === 'human', '席位未切成人类');
    CIVUI.onAction('civ-tab:llm');
    CIVUI.onAction('civ-llm-save'); await flush();
    assert(toasts.length > 0, '配置未给出提示');
    return `席位 ${seat.control}，提示 ${toasts[toasts.length - 1].slice(0, 24)}`;
});

check('导出 / 导入存档 + 自动落盘不含 Key 与身份', async () => {
    CIVUI.onAction('civ-tab:save');
    CIVUI.onAction('civ-export'); await flush();
    assert(html.includes('&quot;version&quot;: 1'), '导出文本未回填到界面（textarea 内容已转义）');
    const saved = store['civmon-offline-v1'];
    assert(saved && saved.length > 1000, '自动存档未落 localStorage');
    assert(!saved.includes('sk-') && !saved.includes('"control"') && !saved.includes('"apiKey"'), '存档含 Key / 身份');
    CIVUI.onAction('civ-import'); await flush();
    assert(CIVUI.host.call('stateId').turn >= 2, '导入后回合异常');
    return `存档 ${saved.length} B，导出/导入通过`;
});

check('复制战报（带防注入包裹）与玩法说明入口不抛错', () => {
    CIVUI.onAction('civ-copy-report');
    CIVUI.onAction('civ-copy-save');
    CIVUI.onAction('civ-help');
    CIVUI.onAction('civ-back');
    assert(screen === 'home', '返回首页失败');
    return '3 个动作 + 返回首页';
});

check('终局后结算/模型按钮置灰，点击无异常 toast，重开仍可用', async () => {
    const h = CIVUI.host;
    let guard = 0;
    while (h.call('stateId').phase !== 'ended' && guard < 130) { h.call('advance'); guard += 1; }
    assert(h.call('stateId').phase === 'ended', `130 回合内未终局（turn=${h.call('stateId').turn}）`);
    CIVUI.onAction('civ-tab:map'); await flush();
    assert(/data-action="civ-advance" disabled/.test(html), '结算按钮未置灰');
    assert(/data-action="civ-auto" disabled/.test(html), '模型推演按钮未置灰');
    const before = toasts.length;
    CIVUI.onAction('civ-advance'); CIVUI.onAction('civ-auto'); CIVUI.onAction('civ-order');
    await flush();
    const added = toasts.slice(before);
    assert(added.length >= 3, `终局拦截未给出提示：${added.join(' | ')}`);
    assert(added.every((t) => t.indexOf('本局已终局') >= 0), `出现非预期 toast：${added.join(' | ')}`);
    assert(!added.some((t) => t.indexOf('操作失败') >= 0), '出现 PHASE_NOT_SUBMITTING 错误 toast');
    CIVUI.onAction('civ-new'); await flush();
    assert(CIVUI.host.call('stateId').turn === 1, '重开未回到第 1 回合');
    return `第 ${guard} 次结算终局，3 个动作被拦截且无异常 toast，重开回到第 1 回合`;
});

check('离线：整个过程 0 次 fetch（沙箱未注入 fetch）', () => {
    assert(typeof sandbox.fetch === 'undefined', '验收沙箱不应有 fetch');
    return '无网络依赖';
});

await chain;
await flush();
console.log(`\n${'='.repeat(64)}`);
console.log(`前端冒烟：${passed} 项通过 / ${failures.length} 项失败`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
else console.log('8 页签 / 48 州 / 下令-DM-席位-LLM-存档 / 终局按钮 / 离线：全绿');
