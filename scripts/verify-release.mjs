/**
 * 发布包独立验收（零外部依赖，可复跑）
 *
 *   node scripts/verify-release.mjs [release/guozhan-<ver>-<stamp>.zip]
 *
 * 1. 解压到仓库内 .verify-stage/（向上能解析到仓库 node_modules，等价于「已装依赖的机器」）；
 * 2. 校验 dist/main.js 的新版规则标记（中文在 esbuild 产物里是 \uXXXX 大写转义，不能按字面 grep）；
 * 3. 校验包内不含 data/ / node_modules / .env / 密钥 / 日志 / 大对话导出；
 * 4. **不执行 build**，直接 `npm start` 起解压包的服务 → /health 200；
 * 5. 用 scripts/smoke.mjs 以解压后的 cwd 走完一整个回合；
 * 6. 保留 .verify-stage/ 供复查，杀掉自己起的进程。全程用 8897/8898 空闲端口，不碰 8080/8766/8788。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const arg = process.argv[2];
const zipPath = arg ? path.resolve(arg) : (() => {
    const list = fs.readdirSync(RELEASE).filter((n) => /^guozhan-.*\.zip$/.test(n) && !n.includes('供应商包'))
        .map((n) => ({ n, t: fs.statSync(path.join(RELEASE, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!list.length) throw new Error('release/ 里没有 guozhan-*.zip');
    return path.join(RELEASE, list[0].n);
})();
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PKG = `guozhan-${VERSION}`;
const STAGE = path.join(ROOT, '.verify-stage');
const STAGE_PKG = path.join(STAGE, PKG);
const fail = (m) => { throw new Error(m); };
const ok = (m) => console.log(`  PASS  ${m}`);
const esc = (s) => [...s].map((c) => c.codePointAt(0) > 127 ? `\\u${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c).join('');

// 验收产物保留在 .verify-stage/ 供复查（unzip -o 覆盖，不删除项目内目录）。
fs.mkdirSync(STAGE, { recursive: true });
const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', STAGE], { encoding: 'utf8' });
if (unzip.status !== 0) fail(`unzip 失败：${unzip.stderr || unzip.stdout}`);
if (!fs.existsSync(path.join(STAGE_PKG, 'dist/main.js'))) fail('解压包缺少 dist/main.js');
console.log(`[发布包验收] ${path.basename(zipPath)}`);

// ---- 2. dist 新鲜度（按 esbuild 的 \uXXXX 大写转义检查） ----
const dist = fs.readFileSync(path.join(STAGE_PKG, 'dist/main.js'), 'utf8');
for (const s of [esc('收复故土'), esc('士气大振'), esc('守住'), 'function clampFaction(draft, fid, f, troops0, food0']) {
    if (!dist.includes(s)) fail(`dist/main.js 缺少新版规则标记：${s}`);
}
for (const s of ['goldGain', 'goldLoss', 'gold0']) if (dist.includes(s)) fail(`dist/main.js 仍含旧的金矿钳制：${s}`);
if (!dist.includes('node:sqlite')) fail('dist/main.js 丢失 node:sqlite（removeNodeProtocol 被改过）');
ok('dist 含收复故土 / 士气大振 / 守住，金矿钳制已移除，node:sqlite 保留');

// ---- 3. 清单卫生 ----
const listing = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const bad = listing.filter((n) => {
    const rel = n.replace(`${PKG}/`, '');
    const base = rel.split('/').pop();
    return /(^|\/)(data|node_modules|release|\.git)\//.test(rel)
        || base === '.env' || (base.startsWith('.env.') && base !== '.env.example')
        || /\.(log|zip|tar\.gz)$/.test(base)
        || /llm\.env|api[_-]?key|secret/i.test(rel);
});
if (bad.length) fail(`包内含排除项：${bad.slice(0, 6).join(', ')}`);
ok(`${listing.length} 个文件，无 data/ / node_modules / .env / 密钥 / 日志 / 压缩包`);

// ---- 4. 不 build，直接 npm start ----
const PORT = 8897;
const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
    GUOZHAN_DATA_DIR: path.join(STAGE, `runtime-data-${Date.now()}`),
    GUOZHAN_TOKEN: 'verify-release-token-0123456789',
    GUOZHAN_ORIGINS: `http://127.0.0.1:${PORT}`,
};
const child = spawn('cmd.exe', ['/c', 'npm', 'start'], { cwd: STAGE_PKG, env, stdio: ['ignore', 'pipe', 'pipe'] });
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });
async function waitHealth(timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/health`);
            if (r.ok) return await r.text();
        } catch (_) { /* 还没起来 */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
}
let health = null;
try {
    health = await waitHealth();
    if (!health) fail(`npm start 未就绪：${childLog.slice(-600)}`);
    ok(`解压包直接 npm start（未执行 build）→ /health 200：${String(health).slice(0, 80)}`);
} finally {
    // cmd.exe /c npm start 会派生 node.exe；先按进程树杀，再按端口兜底清残留。
    try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    const net = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
    for (const line of net.split('\n')) {
        if (line.includes(`:${PORT} `) && line.includes('LISTENING')) {
            const pid = line.trim().split(/\s+/).pop();
            if (/^\d+$/.test(pid)) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
        }
    }
    await new Promise((r) => setTimeout(r, 400));
}

// ---- 5. 用解压后的 dist 跑完整一回合 ----
const smoke = spawnSync(process.execPath, [path.join(ROOT, 'scripts/smoke.mjs')], {
    cwd: STAGE_PKG, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, SMOKE_PORT: '8898' },
});
if (smoke.status !== 0) fail(`解压包 smoke 失败：\n${String(smoke.stdout || '').slice(-1800)}\n${String(smoke.stderr || '').slice(-600)}`);
if (!String(smoke.stdout).includes('[smoke] PASS')) fail('解压包 smoke 未打印 PASS');
ok('解压包 dist 走完 建房→认领→快照→下令→锁定→AI 行动→结算→战报→事件(HTTP+WS)');

console.log(`验收产物保留在 ${STAGE}（含解压包与运行数据，可手动清理）`);
console.log('VERIFY RELEASE OK');
