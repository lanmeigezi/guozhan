/**
 * 群星君主 · 桌游合集 APK 一键构建（可复跑）
 *
 *   node android/build-apk.mjs
 *
 * 前置：先跑 `node android/build-bundle.mjs`（本脚本会检查产物，不做静默兜底）。
 * 步骤：同步 assets/www → 改 versionCode/versionName → gradle assembleDebug
 *       → 复制成品到 D:/酒馆游戏/release 与 apk/ → 逐字节核对 APK 内资源
 *       → 备份壳工程源码到 android/shell/ → 出 SHA256SUMS。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WWW = path.resolve(ROOT, '..', 'board-games', 'app', 'src', 'main', 'assets', 'www');
const APK_ROOT = 'D:/测试/uno-bt';
const APK_WWW = path.join(APK_ROOT, 'app/src/main/assets/www');
const RELEASE = path.resolve(ROOT, '..', 'release');
const APK_DIR = path.resolve(ROOT, '..', 'apk');
const SHELL_OUT = path.join(__dirname, 'shell');
const SDK = 'C:/Users/蓝莓鸽子/AppData/Local/Android/Sdk';
const JDK = 'D:/测试/jdk17/jdk-17.0.20.1+1';
const GRADLE_BAT = 'D:/测试/gradle-dist/gradle-8.9/bin/gradle.bat';
const VERSION_CODE = 28;
const VERSION_NAME = '1.26';
const APK_NAME = '桌游合集-guozhan-1.26.apk';
const WWW_FILES = ['index.html', 'app.js', 'style.css', 'uno-core.bundle.js', 'civ-core.bundle.js', 'civ-ui.js'];

function need(file, what) { if (!fs.existsSync(file)) throw new Error(`缺少${what}：${file}`); }
function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600000, ...opts });
    if (r.error) throw new Error(`${cmd} 启动失败：${r.error.message}`);
    if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}\n${String(r.stdout || '').slice(-2500)}\n${String(r.stderr || '').slice(-2500)}`);
    return String(r.stdout || '');
}

// ---- 1. 前置检查 ----
for (const f of WWW_FILES) need(path.join(WWW, f), '前端资源');
need(APK_ROOT, 'Android 壳工程');
need(GRADLE_BAT, 'Gradle');
need(path.join(JDK, 'bin/java.exe'), 'JDK17');
need(path.join(SDK, 'build-tools/34.0.0/apksigner.bat'), 'apksigner');
need(path.join(APK_WWW, 'uno-core.bundle.js'), '壳工程 assets 目录');

// ---- 2. 同步 assets/www ----
console.log('[1/6] 同步前端资源到 Android 壳工程');
for (const f of WWW_FILES) {
    fs.copyFileSync(path.join(WWW, f), path.join(APK_WWW, f));
    console.log(`  ${f.padEnd(24)} ${fs.statSync(path.join(WWW, f)).size} B`);
}

// ---- 3. 版本号（幂等：重复跑不会累加） ----
const gradleFile = path.join(APK_ROOT, 'app/build.gradle');
let gradle = fs.readFileSync(gradleFile, 'utf8');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${VERSION_CODE}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${VERSION_NAME}"`);
fs.writeFileSync(gradleFile, gradle);
console.log(`[2/6] versionCode=${VERSION_CODE} / versionName=${VERSION_NAME}`);

// ---- 4. gradle assembleDebug ----
console.log('[3/6] gradle assembleDebug（首次编译可能耗时数分钟）…');
const env = { ...process.env, JAVA_HOME: JDK, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK };
const out = run('cmd.exe', ['/c', GRADLE_BAT, 'assembleDebug', '--no-daemon', '--console=plain'], { cwd: APK_ROOT, env });
console.log(out.trim().split('\n').slice(-8).join('\n'));
const built = path.join(APK_ROOT, 'app/build/outputs/apk/debug/app-debug.apk');
need(built, 'gradle 产物 app-debug.apk');

// ---- 5. 复制成品 ----
fs.mkdirSync(RELEASE, { recursive: true });
fs.mkdirSync(APK_DIR, { recursive: true });
const apkPath = path.join(RELEASE, APK_NAME);
fs.copyFileSync(built, apkPath);
fs.copyFileSync(built, path.join(APK_DIR, '桌游合集-1.26-debug.apk'));
console.log(`[4/6] 成品 ${apkPath} (${fs.statSync(apkPath).size} B)`);

// ---- 6. 校验：签名 / versionName / APK 内资源逐字节一致 ----
// 硬约束：aapt/apksigner 对中文路径 + 中文文件名会乱码，先复制到全 ASCII 路径再验。
const ASCII_TMP = 'C:/Temp/civ-apk-verify.apk';
fs.mkdirSync('C:/Temp', { recursive: true });
fs.copyFileSync(apkPath, ASCII_TMP);
const apksigner = path.join(SDK, 'build-tools/34.0.0/apksigner.bat');
const aapt = path.join(SDK, 'build-tools/34.0.0/aapt.exe');
run('cmd.exe', ['/c', apksigner, 'verify', ASCII_TMP], { cwd: RELEASE });
const badging = run('cmd.exe', ['/c', aapt, 'dump', 'badging', ASCII_TMP], { cwd: RELEASE });
if (!badging.includes(`versionName='${VERSION_NAME}'`)) throw new Error(`aapt 未读到 versionName=${VERSION_NAME}：${badging.slice(0, 300)}`);
if (!badging.includes(`versionCode='${VERSION_CODE}'`)) throw new Error(`aapt 未读到 versionCode=${VERSION_CODE}：${badging.slice(0, 300)}`);
console.log(`[5/6] ASCII 路径验签：apksigner verify + aapt badging 通过（versionCode ${VERSION_CODE} / ${VERSION_NAME}）`);

const buf = fs.readFileSync(apkPath);
function zipEntries(b) {
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65558); i -= 1) {
        if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('APK 不是合法 ZIP（无 EOCD）');
    const count = b.readUInt16LE(eocd + 10);
    let off = b.readUInt32LE(eocd + 16);
    const list = [];
    for (let i = 0; i < count; i += 1) {
        if (b.readUInt32LE(off) !== 0x02014b50) throw new Error('APK central directory 损坏');
        const method = b.readUInt16LE(off + 10);
        const csize = b.readUInt32LE(off + 20);
        const usize = b.readUInt32LE(off + 24);
        const nlen = b.readUInt16LE(off + 28);
        const elen = b.readUInt16LE(off + 30);
        const clen = b.readUInt16LE(off + 32);
        const local = b.readUInt32LE(off + 42);
        const name = b.toString('utf8', off + 46, off + 46 + nlen);
        list.push({ name, method, csize, usize, local });
        off += 46 + nlen + elen + clen;
    }
    return list;
}
function extract(b, e) {
    const nlen = b.readUInt16LE(e.local + 26);
    const elen = b.readUInt16LE(e.local + 28);
    const start = e.local + 30 + nlen + elen;
    const raw = b.subarray(start, start + e.csize);
    const data = e.method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (data.length !== e.usize) throw new Error(`${e.name} 解压长度不符`);
    return data;
}
const entries = zipEntries(buf);
const byName = new Map(entries.map((e) => [e.name, e]));
for (const f of WWW_FILES) {
    const key = `assets/www/${f}`;
    const e = byName.get(key);
    if (!e) throw new Error(`APK 缺少 ${key}`);
    const inside = extract(buf, e);
    const source = fs.readFileSync(path.join(WWW, f));
    if (!inside.equals(source)) throw new Error(`APK 内 ${key} 与源码不一致（${inside.length} vs ${source.length}）`);
}
if (!byName.has('classes.dex')) throw new Error('APK 缺少 classes.dex');
const core = extract(buf, byName.get('assets/www/civ-core.bundle.js')).toString('utf8');
if (!core.includes('global.CIVMONARCHS') || !core.includes('createHost')) throw new Error('civ-core.bundle.js 内容异常');
const html = extract(buf, byName.get('assets/www/index.html')).toString('utf8');
if (!html.includes('civ-core.bundle.js') || !html.includes('civ-ui.js')) throw new Error('index.html 未引入群星君主资源');
console.log(`[6/6] APK 内 ${WWW_FILES.length} 个资源逐字节一致；classes.dex 与 bundle 入口已核对`);

// ---- 7. 备份壳工程源码（让交付包自包含、可复跑） ----
const shellFiles = [
    'app/build.gradle', 'app/src/main/AndroidManifest.xml',
    'app/src/main/java/com/example/unobt/MainActivity.kt',
    'app/src/main/java/com/example/unobt/HomeActivity.kt',
    'app/src/main/java/com/example/unobt/BtJsBridge.kt',
    'app/src/main/java/com/example/unobt/BluetoothService.kt',
    'app/src/main/res/layout/activity_home.xml',
    'app/src/main/res/values/strings.xml', 'app/src/main/res/values/themes.xml',
];
for (const rel of shellFiles) {
    const src = path.join(APK_ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(SHELL_OUT, rel.replace(/^app\//, ''));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}
console.log(`壳工程源码已备份到 ${SHELL_OUT}`);

// ---- 8. 纯前端产物（方便别的壳直接套）+ SHA256SUMS ----
// 校验和用相对 release/ 的路径，保证 `cd release && sha256sum -c ...` 能跑通。
const WWW_OUT = path.join(RELEASE, 'civ-monarchs-1.26-www');
fs.mkdirSync(WWW_OUT, { recursive: true });
for (const f of WWW_FILES) fs.copyFileSync(path.join(WWW, f), path.join(WWW_OUT, f));
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sums = [
    `${sha(apkPath)}  ${APK_NAME}`,
    ...WWW_FILES.map((f) => `${sha(path.join(WWW_OUT, f))}  civ-monarchs-1.26-www/${f}`),
];
const sumsPath = path.join(RELEASE, 'civ-monarchs-apk-1.26-SHA256SUMS.txt');
fs.writeFileSync(sumsPath, sums.join('\n') + '\n', 'utf8');
console.log(`纯前端产物: ${WWW_OUT}`);
console.log(`\nSHA256SUMS: ${sumsPath}`);
console.log(`APK SHA256: ${sums[0].split('  ')[0]}`);
console.log('BUILD OK');
