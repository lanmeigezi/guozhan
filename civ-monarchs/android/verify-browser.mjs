/**
 * 群星君主 · 真实 Chromium（与 Android WebView 同引擎）file:// 冒烟验收
 *
 *   node android/verify-browser.mjs
 *
 * 生成一个临时 HTML（与 index.html 同源、同 script 顺序），在页面加载后自动
 * 点击「群星君主」卡片 →「本地对战」→「结算一回合」，把结果写进 body 属性，
 * 再用 Chrome headless --dump-dom 取回验证。跑完自动删除临时文件。
 * 这一步覆盖 VM 冒烟测不到的部分：真实 script 加载顺序、DOM 事件委托、CSS、
 * file:// 下 classic script 是否可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WWW = path.resolve(ROOT, '..', 'board-games', 'app', 'src', 'main', 'assets', 'www');
const TEMP = path.join(WWW, 'civ-verify.tmp.html');
// 跨平台解析 Chrome 可执行文件：先读环境变量，再试常见安装路径，最后回退到 PATH 查找。
function resolveChrome() {
  const envCandidates = [process.env.CHROME_BIN, process.env.PUPPETEER_EXECUTABLE_PATH].filter(Boolean);
  const platformPaths =
    process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];
  for (const c of [...envCandidates, ...platformPaths]) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const bin = process.platform === 'win32' ? 'chrome.exe' : 'google-chrome';
    const which = process.platform === 'win32' ? 'where' : 'command -v';
    const found = execFileSync(which, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    /* PATH 查找失败时忽略，继续走下面的报错分支 */
  }
  return null;
}

const CHROME = resolveChrome();
if (!CHROME) {
  console.error('FAIL  未找到 Chrome：无法在真实 Chromium 上验证（依据缺失，不计为通过）');
  process.exit(1);
}
console.error('INFO 使用 Chrome：' + CHROME);

const probe = `
<script>
(function () {
  function set(k, v) { document.body.setAttribute(k, v); }
  function run() {
    var card = document.querySelector('[data-action="select:civmonarchs"]');
    if (!card) { set('data-civ-check', 'NO_CARD'); return; }
    card.click();
    var local = document.querySelector('[data-action="local"]');
    if (!local) { set('data-civ-check', 'NO_LOCAL'); return; }
    local.click();
    var regions = document.querySelectorAll('.civ-region').length;
    var tabs = document.querySelectorAll('.civ-tabs .btn').length;
    var title = document.querySelector('.civ-title') ? document.querySelector('.civ-title').textContent.trim() : '';
    set('data-civ-check', regions + '|' + tabs + '|' + title);
    var adv = document.querySelector('[data-action="civ-advance"]');
    if (adv) adv.click();
    setTimeout(function () {
      var sub = document.querySelector('.civ-sub') ? document.querySelector('.civ-sub').textContent.trim() : '';
      set('data-civ-turn', sub);
      var save = null;
      try { save = localStorage.getItem('civmon-offline-v1'); } catch (_) {}
      set('data-civ-save', save ? String(save.length) : '0');

      // P2 回归：真实 Chromium 里推演到终局，按钮应置灰且点击不产生错误 toast。
      var h = window.CIVUI && window.CIVUI.host;
      if (!h) { set('data-civ-end', 'NO_HOST'); return; }
      var guard = 0;
      while (h.call('stateId').phase !== 'ended' && guard < 130) { h.call('advance'); guard += 1; }
      window.CIVUI.onAction('civ-tab:map');
      var adv = document.querySelector('[data-action="civ-advance"]');
      var auto = document.querySelector('[data-action="civ-auto"]');
      set('data-civ-end', (adv && adv.disabled ? 1 : 0) + '|' + (auto && auto.disabled ? 1 : 0) + '|' + guard);
      window.CIVUI.onAction('civ-advance');
      var t = document.getElementById('toast');
      set('data-civ-end-toast', t ? t.textContent : 'NO_TOAST');
    }, 250);
  }
  if (document.readyState === 'complete') setTimeout(run, 120);
  else window.addEventListener('load', function () { setTimeout(run, 120); });
})();
</script>
`;
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8').replace('</body>', probe + '</body>');
fs.writeFileSync(TEMP, html);

let out = '';
try {
    out = execFileSync(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        '--allow-file-access-from-files', '--virtual-time-budget=12000',
        '--dump-dom', pathToFileURL(TEMP).href,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
} finally {
    fs.rmSync(TEMP, { force: true });
}

const attr = (k) => {
    const m = out.match(new RegExp(k + '="([^"]*)"'));
    return m ? m[1] : null;
};
const checkAttr = attr('data-civ-check');
const turnAttr = attr('data-civ-turn');
const saveAttr = attr('data-civ-save');
const endAttr = attr('data-civ-end');
const endToast = attr('data-civ-end-toast');
const failures = [];
if (checkAttr === null) failures.push('探针未执行（script 未加载或被拦截）');
else {
    const parts = checkAttr.split('|');
    if (parts[0] !== '48') failures.push(`地图州数 ${parts[0]} ≠ 48`);
    if (parts[1] !== '8') failures.push(`页签数 ${parts[1]} ≠ 8`);
    if (!parts[2] || parts[2].indexOf('群星君主') < 0) failures.push(`标题异常：${parts[2]}`);
}
if (!turnAttr || turnAttr.indexOf('第 2 回合') < 0) failures.push(`结算未推进：${turnAttr}`);
if (!saveAttr || Number(saveAttr) < 1000) failures.push(`自动存档未落盘：${saveAttr} B`);
if (!endAttr || !/^1\|1\|\d+$/.test(endAttr)) failures.push(`终局按钮未置灰：${endAttr}`);
if (!endToast || endToast.indexOf('本局已终局') < 0 || endToast.indexOf('操作失败') >= 0) {
    failures.push(`终局点击 toast 异常：${endToast}`);
}

console.log('[真实 Chromium · file:// 冒烟]');
console.log(`  data-civ-check      = ${checkAttr}`);
console.log(`  data-civ-turn       = ${turnAttr}`);
console.log(`  data-civ-save       = ${saveAttr} B（localStorage）`);
console.log(`  data-civ-end        = ${endAttr}（结算/模型都置灰 | 结算次数）`);
console.log(`  data-civ-end-toast  = ${endToast}`);
if (failures.length) { failures.forEach((f) => console.log(`  FAIL  ${f}`)); process.exitCode = 1; }
else console.log('  PASS  首屏 → 离线开局 → 48 州 → 结算 → 自动存档 → 终局按钮置灰且无异常 toast，全链路通过');
