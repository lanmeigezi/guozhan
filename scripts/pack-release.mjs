/**
 * guozhan 发布包生成器（零外部依赖，可复跑）
 *
 *   node scripts/pack-release.mjs
 *
 * 前置：先 `npm run build`（本脚本不代跑，避免把「未重建的 dist」悄悄打进包）。
 * 输出（写在 release/）：
 *   guozhan-<ver>-<stamp>.zip / .tar.gz
 *   酒馆国战桌游合集-<ver>-供应商包.zip（= 主 zip 副本）
 *   SHA256SUMS-<ver>.txt
 *
 * 清单是显式白名单，硬排除：data/（含 llm.env）、node_modules/、release/、
 * .env、*.log、*.zip、*.tar.gz、*.apk（apk/ 只取最新一个）、超大对话导出 md、
 * 各类 .ui-data* / .preview / .qoder-credits 临时目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// 默认取当天；同一版本重打包（如收尾修复后刷新包内前端资源）用 PACK_STAMP 固定 stamp，
// 覆盖同名产物，保持文件名 / 文档引用 / SHA256SUMS 稳定。例：PACK_STAMP=20261108 node scripts/pack-release.mjs
const d = new Date();
const STAMP = process.env.PACK_STAMP
    || `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const PREFIX = `guozhan-${VERSION}`;
const ZIP_NAME = `${PREFIX}-${STAMP}.zip`;
const TGZ_NAME = `${PREFIX}-${STAMP}.tar.gz`;
const VENDOR_NAME = `酒馆国战桌游合集-${VERSION}-供应商包.zip`;

const TOP_DIRS = ['config', 'src', 'tests', 'tools', 'web', 'extensions', 'deploy', 'docs',
    'board-games', 'civ-monarchs', 'dist', 'scripts', 'apk'];
const TOP_FILES = ['.dockerignore', '.env.example', '.gitignore', 'Dockerfile', 'docker-compose.yaml',
    'DELIVERY.md', 'README.md', 'RELEASE-NOTES.md', 'HANDOFF-remaining.md',
    'guozhan-架构深度研究报告.md', 'dsh-archived-ids-20261027.json',
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsup.config.ts'];
const EXCLUDE_DIRS = new Set(['release', 'node_modules', '.git', 'data', '.workbuddy', '.workbuddy-ai',
    '.release-stage', '.preview', '.qoder-credits', 'dsh-splash-previews', '.ai-balance2.mjs']);
const EXCLUDE_EXT = new Set(['.log', '.zip', '.tar.gz', '.apk']);
const MAX_MD = 2 * 1024 * 1024; // 对话导出 md 有 16–27 MB，不是交付内容

function excluded(base) {
    if (base === '.env' || base.endsWith('.log') || base.endsWith('.zip') || base.endsWith('.tar.gz')) return true;
    if (base.endsWith('.apk')) return true;
    if (base.endsWith('.md') && fs.statSync(path.join(ROOT, base)).size > MAX_MD) return true;
    return false;
}
function walk(dir, acc = []) {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = path.relative(ROOT, full).split(path.sep).join('/');
        if (EXCLUDE_DIRS.has(name) || name.startsWith('.ui-data')) continue;
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, acc);
        else if (!excluded(rel)) acc.push({ rel, full, mtime: st.mtime });
    }
    return acc;
}

const files = [];
for (const dir of TOP_DIRS) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) walk(p, files);
}
for (const f of TOP_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && !excluded(f)) files.push({ rel: f, full: p, mtime: fs.statSync(p).mtime });
}
// apk/ 只带最新一个 APK（release/ 里的成品），避免把 1.17 等历史包一起塞进去
const apks = fs.readdirSync(path.join(ROOT, 'apk')).filter((n) => n.endsWith('.apk'))
    .map((n) => ({ n, t: fs.statSync(path.join(ROOT, 'apk', n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
if (!apks.length) throw new Error('apk/ 目录没有 APK，无法生成发布包');
const latestApk = apks[0].n;
files.push({ rel: `apk/${latestApk}`, full: path.join(ROOT, 'apk', latestApk), mtime: fs.statSync(path.join(ROOT, 'apk', latestApk)).mtime });
files.sort((a, b) => a.rel.localeCompare(b.rel, 'en'));

// ---- dist 新鲜度闸门：绝不允许把旧战斗规则打进包 ----
const distMain = fs.readFileSync(path.join(ROOT, 'dist/main.js'), 'utf8');
const esc = (s) => [...s].map((c) => c.codePointAt(0) > 127 ? `\\u${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c).join('');
const MUST_HAVE = [esc('收复故土'), esc('士气大振'), esc('守住'), 'function clampFaction(draft, fid, f, troops0, food0'];
const MUST_NOT = ['goldGain', 'goldLoss', 'gold0'];
for (const s of MUST_HAVE) if (!distMain.includes(s)) throw new Error(`dist/main.js 缺少新版规则标记：${s} —— 请先 npm run build`);
for (const s of MUST_NOT) if (distMain.includes(s)) throw new Error(`dist/main.js 仍含旧的金矿钳制：${s} —— 请先 npm run build`);
console.log(`dist 闸门：3 条新文案 + clampFaction 无 gold0 命中，goldGain/goldLoss/gold0 全 0`);

// ---- CRC32 / ZIP(deflate) ----
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function dosTime(t) { return [((t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1)), ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate()]; }
function buildZip(entries) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(`${PREFIX}/${e.rel}`, 'utf8');
        const raw = e.data;
        const data = zlib.deflateRawSync(raw, { level: 6 });
        const crc = crc32(raw);
        const [tm, dt] = dosTime(e.mtime);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
        lh.writeUInt16LE(8, 8); lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
        lh.writeUInt16LE(name.length, 26);
        locals.push(Buffer.concat([lh, name, data]));
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
        cd.writeUInt16LE(tm, 12); cd.writeUInt16LE(dt, 14);
        cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24);
        cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([cd, name]));
        offset += lh.length + name.length + data.length;
    }
    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cdBuf, eocd]);
}

// ---- tar (ustar) + gzip，纯 Node，不依赖系统 tar / 中文路径编码 ----
function tarHeader(name, size, mtime) {
    const b = Buffer.alloc(512);
    const full = Buffer.from(`${PREFIX}/${name}`, 'utf8');
    let prefix = Buffer.alloc(0), rest = full;
    if (full.length > 100) {
        const s = `${PREFIX}/${name}`;
        const cut = s.lastIndexOf('/', s.length - 1);
        if (cut > 0) { prefix = Buffer.from(s.slice(0, cut), 'utf8'); rest = Buffer.from(s.slice(cut + 1), 'utf8'); }
        if (prefix.length > 155 || rest.length > 100) throw new Error(`tar 路径过长：${s}`);
    }
    rest.copy(b, 0); prefix.copy(b, 345);
    b.write('0000644\0', 100, 8, 'ascii');
    b.write('0000000\0', 108, 8, 'ascii');
    b.write('0000000\0', 116, 8, 'ascii');
    b.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    b.write(Math.floor(mtime.getTime() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    b.fill(32, 148, 156);
    b.write('0', 156, 1, 'ascii');
    b.write('ustar\0', 257, 6, 'ascii'); b.write('00', 263, 2, 'ascii');
    let sum = 0; for (const x of b) sum += x;
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return b;
}
function buildTarGz(entries) {
    const parts = [];
    for (const e of entries) {
        parts.push(tarHeader(e.rel, e.data.length, e.mtime));
        parts.push(e.data);
        const pad = (512 - (e.data.length % 512)) % 512;
        if (pad) parts.push(Buffer.alloc(pad));
    }
    parts.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(parts), { mtime: 0 });
}

const entries = files.map((f) => ({ rel: f.rel, data: fs.readFileSync(f.full), mtime: f.mtime }));
fs.mkdirSync(RELEASE, { recursive: true });
const zip = buildZip(entries);
const tgz = buildTarGz(entries);
fs.writeFileSync(path.join(RELEASE, ZIP_NAME), zip);
fs.writeFileSync(path.join(RELEASE, TGZ_NAME), tgz);
fs.copyFileSync(path.join(RELEASE, ZIP_NAME), path.join(RELEASE, VENDOR_NAME));

const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// 只校验三个主项目包；用裸文件名，`cd release && sha256sum -c SHA256SUMS-<ver>.txt` 可直接通过。
// APK 由 civ-monarchs/android/build-apk.mjs 单独出 civ-monarchs-apk-<ver>-SHA256SUMS.txt，
// 不再在此混入（旧的字典序排序会把远古 1.9.apk 误当成"最新"）。
const sums = [ZIP_NAME, TGZ_NAME, VENDOR_NAME].map((n) => `${sha(path.join(RELEASE, n))}  ${n}`);
fs.writeFileSync(path.join(RELEASE, `SHA256SUMS-${VERSION}.txt`), sums.join('\n') + '\n', 'utf8');

console.log(`\n${PREFIX} · ${STAMP} · ${entries.length} 文件`);
console.log(`  ${ZIP_NAME.padEnd(46)} ${(zip.length / 1024).toFixed(1).padStart(9)} KB`);
console.log(`  ${TGZ_NAME.padEnd(46)} ${(tgz.length / 1024).toFixed(1).padStart(9)} KB`);
console.log(`  ${VENDOR_NAME.padEnd(46)} ${(zip.length / 1024).toFixed(1).padStart(9)} KB（主包副本）`);
console.log(`  APK：apk/${latestApk}（最新）`);
console.log(`  SHA256SUMS-${VERSION}.txt`);
console.log('PACK OK');
