/**
 * 群星君主 · 浏览器化 bundle 生成器（零依赖，可复跑）
 *
 *   node android/build-bundle.mjs
 *
 * 输入：
 *   - config/*.json                → 生成 android/src/config.generated.js（内嵌常量）
 *   - android/src/crypto-shim.js   → 替换 node:crypto（同步 sha256，与 Node 版逐位一致）
 *   - android/src/browser-host.js  → 入口（BrowserHost + 自接 LLM + 降级）
 *   - src/core/*.js, src/ai/*.js   → 原样复用，0.3.0 源码零改动
 * 输出：
 *   - board-games/app/src/main/assets/www/civ-core.bundle.js（classic script → window.CIVMONARCHS）
 *   - 若 D:/测试/uno-bt 工程存在，同步一份到它的 assets/www
 *
 * 约束（与 board-games/scripts/build-web.mjs 一致）：只用命名 import/export、
 * 无 default export、无 dynamic import、无循环依赖、除 node:crypto 外无 node: 前缀。
 * Android WebView 从 file:// 加载 ES module 会被当作 opaque origin，必须打成单文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ANDROID = __dirname;
const CORE = path.join(ROOT, 'src');
const ENTRY = path.join(ANDROID, 'src', 'browser-host.js');
const CRYPTO_SHIM = path.join(ANDROID, 'src', 'crypto-shim.js');
const CONFIG_MODULE = path.join(ANDROID, 'src', 'config.generated.js');
const BOARD_WWW = path.resolve(ROOT, '..', 'board-games', 'app', 'src', 'main', 'assets', 'www');
const APK_WWW = 'D:/测试/uno-bt/app/src/main/assets/www';

// ---- 1. 把 4 份 JSON 内嵌成一个 ESM 模块 ----
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', name), 'utf8'));
const configSource = [
    '/*! 自动生成：android/build-bundle.mjs 从 config/*.json 内嵌，请勿手工编辑。 */',
    `export const RULES = ${JSON.stringify(readJson('rules.json'), null, 2)};`,
    `export const MONARCHS = ${JSON.stringify(readJson('monarchs.json'), null, 2)};`,
    `export const WORLD_CFG = ${JSON.stringify(readJson('world.json'), null, 2)};`,
    `export const SEATS_CFG = ${JSON.stringify(readJson('seats.json'), null, 2)};`,
    '',
].join('\n');
fs.writeFileSync(CONFIG_MODULE, configSource);

// ---- 2. ESM 解析 ----
function parseNames(s) {
    return s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
        const parts = x.split(/\s+as\s+/);
        const binding = parts[0].trim();          // 模块内部 / 来源模块里的名字
        const exposed = (parts[1] || parts[0]).trim(); // 暴露出去的名字 / 本地别名
        return { binding, exposed };
    });
}

function resolveSpec(fromDir, spec) {
    if (spec === 'node:crypto') return CRYPTO_SHIM;
    if (spec.startsWith('node:')) throw new Error(`浏览器 bundle 不支持 ${spec}`);
    if (!spec.startsWith('.')) throw new Error(`浏览器 bundle 不支持裸模块：${spec}`);
    return path.resolve(fromDir, spec);
}

function parseModule(abs) {
    let code = fs.readFileSync(abs, 'utf8');
    const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g)]
        .map((m) => ({ spec: m[2], names: parseNames(m[1]) }));
    const reExports = [...code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g)]
        .map((m) => ({ spec: m[2], names: parseNames(m[1]) }));
    code = code.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '');
    code = code.replace(/export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '');

    const declExports = [...code.matchAll(/export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
        .map((m) => m[3]);
    const plainExports = [...code.matchAll(/export\s*\{([^}]*)\}\s*;?/g)]
        .flatMap((m) => parseNames(m[1]));
    code = code.replace(/export\s+(async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g, '$1$2 $3');
    code = code.replace(/export\s*\{[^}]*\}\s*;?/g, '');

    const exportNames = [
        ...declExports.map((n) => ({ binding: n, exposed: n })),
        ...plainExports.map((n) => ({ binding: n.binding, exposed: n.exposed })),
    ];
    const dir = path.dirname(abs);
    const refs = [...imports, ...reExports].map((r) => ({ ...r, abs: resolveSpec(dir, r.spec) }));
    return { code, imports, reExports, exportNames, refs, dir };
}

const modules = [];
const byUrl = new Map();
function collect(abs) {
    if (byUrl.has(abs)) return byUrl.get(abs);
    const mod = parseModule(abs);
    const idx = modules.length;
    modules.push(mod);
    byUrl.set(abs, idx);
    for (const ref of mod.refs) collect(ref.abs);
    return idx;
}
const entryIndex = collect(ENTRY);
const indexOf = (mod, spec) => byUrl.get(resolveSpec(mod.dir, spec));

// ---- 3. 生成 classic script ----
let defs = '';
modules.forEach((m, i) => {
    const pre = m.imports.flatMap((r) => r.names
        .map((n) => `  const ${n.exposed} = __req(${indexOf(m, r.spec)}).${n.binding};`)).join('\n');
    const rex = m.reExports.flatMap((r) => r.names
        .map((n) => `  __exports.${n.exposed} = __req(${indexOf(m, r.spec)}).${n.binding};`)).join('\n');
    const exps = m.exportNames.map((n) => `  __exports.${n.exposed} = ${n.binding};`).join('\n');
    defs += `function __mod${i}(__req, __exports) {\n${pre}\n${m.code}\n${rex}\n${exps}\n}\n`;
});

const runtime = `
var __mods = [${modules.map((_, i) => `__mod${i}`).join(', ')}];
var __cache = [undefined];
function __req(i) {
  if (__cache[i]) return __cache[i];
  var __exports = {};
  __cache[i] = __exports;
  __mods[i](__req, __exports);
  return __exports;
}
var CIV = __req(${entryIndex});
`;

const banner = `/*! civ-core.bundle.js — generated by civ-monarchs/android/build-bundle.mjs. Do not edit; edit src/ or android/src/ instead. */`;
const bundle = [
    banner,
    '(function (global) {',
    '  // director.js / adapter.js 里有 process.env 读取；单机版不调用这些路径，',
    '  // 但旧版 WebView 没有全局 process，给出空环境垫片避免 ReferenceError。',
    '  var process = { env: Object.create(null) };',
    defs,
    runtime,
    '  global.CIVMONARCHS = CIV;',
    '  if (typeof module !== "undefined" && module.exports) module.exports = CIV;',
    '})(typeof window !== "undefined" ? window : globalThis);',
    '',
].join('\n');

const outputs = [path.join(BOARD_WWW, 'civ-core.bundle.js')];
if (fs.existsSync(APK_WWW)) outputs.push(path.join(APK_WWW, 'civ-core.bundle.js'));
for (const out of outputs) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bundle);
    console.log(`wrote ${out} (${modules.length} modules, ${bundle.length} bytes)`);
}
console.log(`config: ${path.relative(ROOT, CONFIG_MODULE)} (${configSource.length} bytes)`);
