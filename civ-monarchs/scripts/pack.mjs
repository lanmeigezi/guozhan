/**
 * 发布打包：零外部依赖的自写 ZIP(store) 生成器，输出 3 个包 + SHA256SUMS。
 * 不依赖 npm ci / 7z / PowerShell，Windows / Linux 结果一致。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'release');
const PARENT_RELEASE = join(ROOT, '..', 'release');
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const VERSION = '0.4.0';

const EXCLUDE_DIRS = new Set(['release', 'node_modules', '.git', '.workbuddy', 'data', 'dist', '.release-stage']);

function walk(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = relative(ROOT, full).replace(/\\/g, '/');
        const parts = rel.split('/');
        if (parts.some((p) => EXCLUDE_DIRS.has(p))) continue;
        const st = statSync(full);
        if (st.isDirectory()) walk(full, acc);
        else {
            const base = parts[parts.length - 1];
            if (base === '.env' || base.endsWith('.zip') || base.endsWith('.log') || base === 'SHA256SUMS.txt') continue;
            acc.push(rel);
        }
    }
    return acc;
}

// ── CRC32 / ZIP(store) ──
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const flags = 0x0800; // UTF-8 文件名
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const data = e.data;
        const crc = crc32(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(flags, 6);
        lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(dosTime, 10);
        lh.writeUInt16LE(dosDate, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(data.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        lh.writeUInt16LE(0, 28);
        const local = Buffer.concat([lh, name, data]);
        locals.push(local);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(flags, 8);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(dosTime, 12);
        cd.writeUInt16LE(dosDate, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(0, 38);
        cd.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([cd, name]));
        offset += local.length;
    }

    const cdBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, cdBuf, eocd]);
}

const files = walk(ROOT).sort();
const read = (rel) => readFileSync(join(ROOT, rel));
const zipOf = (prefix, picked, transform) => buildZip(picked.map((rel) => ({
    name: `${prefix}${transform(rel)}`,
    data: read(rel),
})));

const packages = [
    {
        file: `civ-monarchs-${VERSION}-${STAMP}.zip`,
        desc: '完整发布包（后端 + 扩展 + 卡片 + 网页 + 离线单机 APK 源码 + 文档 + 测试）',
        entries: zipOf(`civ-monarchs-${VERSION}/`, files, (r) => r),
    },
    {
        file: `sillytavern-civ-monarchs-${VERSION}.zip`,
        desc: '纯酒馆扩展（zip 根目录即 manifest.json，可直接「安装扩展」）',
        entries: zipOf('', files.filter((r) => r.startsWith('extensions/sillytavern-civ-monarchs/')), (r) => r.replace('extensions/sillytavern-civ-monarchs/', '')),
    },
    {
        file: `civ-monarchs-cards-${VERSION}.zip`,
        desc: '角色卡 + 世界书（DM 卡、12 张君主卡、世界书、说明）',
        entries: zipOf('', files.filter((r) => r.startsWith('cards/')), (r) => r.replace('cards/', '')),
    },
];

mkdirSync(OUT, { recursive: true });
const sums = [];
for (const p of packages) {
    const path = join(OUT, p.file);
    writeFileSync(path, p.entries);
    const hash = createHash('sha256').update(p.entries).digest('hex');
    sums.push(`${hash}  ${p.file}`);
    console.log(`  ${p.file.padEnd(48)} ${(p.entries.length / 1024).toFixed(1).padStart(8)} KB  ${p.desc}`);
}
writeFileSync(join(OUT, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'utf8');

const manifest = [
    `civ-monarchs ${VERSION} · 生成于 ${new Date().toISOString()}`,
    `主包文件数：${files.length}`,
    '',
    '发布包：',
    ...packages.map((p) => `  - ${p.file}  ${p.desc}`),
    '',
    '主包顶层内容：',
    ...['config/', 'src/', 'android/（离线单机 APK 源码 + 壳工程备份 + 3 套验收）', 'extensions/', 'cards/', 'web/', 'tests/', 'scripts/', 'deploy/', 'docs/',
        'package.json', 'README.md', 'RELEASE.md', 'HANDOFF.md', '.env.example', 'mcp-client.example.json']
        .map((x) => `  ${x}`),
    '',
    '不含：node_modules / .git / release / .env / 任何 API Key / 运行时存档与日志',
    '校验：sha256sum -c SHA256SUMS.txt',
    '',
].join('\n');
writeFileSync(join(OUT, 'PACKAGE-MANIFEST.txt'), manifest, 'utf8');

// 与用户既有的 D:\酒馆游戏\release 发布目录保持并列，方便直接发给合作酒馆服务器
if (existsSync(dirname(PARENT_RELEASE))) {
    mkdirSync(PARENT_RELEASE, { recursive: true });
    for (const p of packages) copyFileSync(join(OUT, p.file), join(PARENT_RELEASE, p.file));
    copyFileSync(join(OUT, 'SHA256SUMS.txt'), join(PARENT_RELEASE, `civ-monarchs-${VERSION}-SHA256SUMS.txt`));
    console.log(`\n已同步到 ${PARENT_RELEASE}`);
}
console.log(`\n打包完成：${OUT}\n${manifest.split('\n').slice(0, 3).join('\n')}`);
