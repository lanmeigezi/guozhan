/**
 * 部署工件闸门 —— Dockerfile / compose / .env.example / scripts 的安全基线逐项断言。
 *
 * ★每一项都配"坏样本"自证：把该行从内容里抠掉，检查器必须能抓到。
 *   没有区分力的闸门等于没有闸门（正确对象须绿、每个坏样本须红）。
 *
 * 为什么这些项不可协商（逐条对应事故）：
 *   · read_only: true      —— 少了它：容器内任意写，webshell 落地即持久化
 *   · cap_drop: [ALL]      —— 少了它：默认 14 个 Linux capability，NET_RAW 可嗅探同网段
 *   · no-new-privileges    —— 少了它：suid 二进制可在容器内提权回 root
 *   · 端口只绑 127.0.0.1   —— 少了它：8788 直接暴露公网，绕过反代与 Origin 白名单
 *   · ${VAR:?} 必填语法     —— 少了它：忘填 token 时服务带空鉴权静默启动
 *   · USER node            —— 少了它：进程以 root 跑，容器逃逸半径扩大一整级
 *   · logging 5m×2         —— 少了它：小机器上日志无限增长写满磁盘
 *
 * 零依赖，裸 Node 可跑：
 *   node --experimental-strip-types --test tests/deterministic/deploy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(rel: string): string {
  assert.ok(existsSync(rel), `部署工件缺失：${rel}`);
  return readFileSync(rel, 'utf8');
}

/** 归一化：断言用的匹配不受空白风格影响，但保留行结构（坏样本按行抠除） */
const norm = (s: string): string => s.replace(/\r\n/g, '\n');

interface SecurityItem {
  readonly id: string;
  /** 在文件内容里必须命中的正则 */
  readonly pattern: RegExp;
  readonly why: string;
}

/** 通用检查器：返回缺失项清单（纯函数，便于坏样本自证） */
function missingItems(content: string, items: readonly SecurityItem[]): SecurityItem[] {
  return items.filter((it) => !it.pattern.test(norm(content)));
}

function assertAllPresent(file: string, items: readonly SecurityItem[]): void {
  const content = read(file);
  const missing = missingItems(content, items);
  assert.deepEqual(
    missing.map((m) => m.id),
    [],
    `${file} 缺失安全项：${missing.map((m) => `${m.id}（${m.why}）`).join('; ')}`,
  );
}

/** 坏样本自证：抠掉某一行后，检查器必须抓到 */
function assertItemIsLoadBearing(file: string, items: readonly SecurityItem[], dropLineMatching: RegExp, expectId: string): void {
  const content = norm(read(file));
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => dropLineMatching.test(l));
  assert.ok(idx >= 0, `自证前提：${file} 里应有一行匹配 ${dropLineMatching}`);
  const bad = [...lines.slice(0, idx), ...lines.slice(idx + 1)].join('\n');
  const missing = missingItems(bad, items).map((m) => m.id);
  assert.ok(
    missing.includes(expectId),
    `闸门没有区分力：从 ${file} 抠掉 "${lines[idx]!.trim()}" 后，检查器竟没报 ${expectId}`,
  );
}

// ─────────────────────────────────────────────────────────────
// Dockerfile
// ─────────────────────────────────────────────────────────────

const DOCKERFILE_ITEMS: readonly SecurityItem[] = [
  { id: 'base-node24-alpine', pattern: /^ARG NODE_IMAGE=node:24-alpine$/m, why: '基础镜像默认值必须是 node:24-alpine：node:sqlite 在 22.5–23.3 仍需实验标志' },
  { id: 'base-image-from-arg', pattern: /^FROM \$\{NODE_IMAGE\}$/m, why: 'FROM 必须走构建参数（国内服务器要用 daocloud 之类的镜像源覆盖）' },
  // ★实测过的镜像级缺陷：/app/data 不预建且不 chown，USER node 启动时 mkdir 直接 EACCES 退出
  { id: 'data-dir-created', pattern: /^RUN mkdir -p \/app\/data && chown -R node:node \/app\/data$/m, why: '数据目录必须预建并归 node 所有（否则容器启动即 EACCES）' },
  { id: 'data-volume', pattern: /^VOLUME \["\/app\/data"\]$/m, why: '声明数据卷，避免容器重建丢档' },
  { id: 'npm-ci-omit-dev', pattern: /npm ci --omit=dev --no-audit --no-fund/, why: '生产镜像不得装 devDependencies' },
  { id: 'npm-cache-clean', pattern: /npm cache clean --force/, why: '不清缓存 → 镜像层虚胖几百 MB' },
  { id: 'user-node', pattern: /^USER\s+node\s*$/m, why: '少了它：进程以 root 跑，容器逃逸半径扩大一整级' },
  { id: 'expose-8788', pattern: /^EXPOSE\s+8788\s*$/m, why: '端口声明缺失 → 编排工具无从做网络策略' },
  { id: 'healthcheck', pattern: /^HEALTHCHECK\s/m, why: '少了它：进程僵死时编排器不会重启它' },
  { id: 'cmd-source-maps', pattern: /CMD\s+\["node",\s*"--enable-source-maps",\s*"dist\/main\.js"\]/, why: '入口命令必须带 source-maps（线上报错可定位到 TS 行）' },
  { id: 'copy-dist-config', pattern: /COPY dist\/ \.\/dist\/[\s\S]*COPY config\/ \.\/config\//, why: '镜像必须自带 dist/ 与 config/' },
];

test('Dockerfile：存在且逐项含安全基线', () => {
  assertAllPresent('Dockerfile', DOCKERFILE_ITEMS);
});

test('Dockerfile：坏样本自证 —— 每一行都是承重的', () => {
  assertItemIsLoadBearing('Dockerfile', DOCKERFILE_ITEMS, /^USER\s+node\s*$/, 'user-node');
  assertItemIsLoadBearing('Dockerfile', DOCKERFILE_ITEMS, /^HEALTHCHECK\s/, 'healthcheck');
  assertItemIsLoadBearing('Dockerfile', DOCKERFILE_ITEMS, /npm cache clean --force/, 'npm-cache-clean');
});

// ─────────────────────────────────────────────────────────────
// docker-compose.yaml（★架构文档 §7.2 安全基线，整段照抄）
// ─────────────────────────────────────────────────────────────

const COMPOSE_ITEMS: readonly SecurityItem[] = [
  { id: 'read-only-rootfs', pattern: /read_only:\s*true/, why: '少了它：容器内任意写，webshell 落地即持久化' },
  { id: 'cap-drop-all', pattern: /cap_drop:\s*\[ALL\]/, why: '少了它：默认 capability 保留，NET_RAW 可嗅探同网段' },
  { id: 'no-new-privileges', pattern: /security_opt:\s*\[no-new-privileges:true\]/, why: '少了它：suid 二进制可在容器内提权回 root' },
  { id: 'init-true', pattern: /init:\s*true/, why: '少了它：node 当 PID 1，僵尸进程无人收尸、SIGTERM 语义不完整' },
  { id: 'port-loopback-only', pattern: /ports:\s*\["127\.0\.0\.1:8788:8788"\]/, why: '少了它（如写成 "8788:8788"）：服务直接暴露公网，绕过反代与 Origin 白名单' },
  { id: 'data-writable-volume', pattern: /- \.\/data:\/app\/data\s*(#.*)?$/m, why: 'read_only 根文件系统下 ./data 是唯一可写路径（SQLite）' },
  { id: 'config-readonly-volume', pattern: /- \.\/config:\/app\/config:ro/, why: 'config 必须只读挂载：运行时改配置=绕过配置闸门' },
  { id: 'token-required', pattern: /GUOZHAN_TOKEN:\s*\$\{GUOZHAN_TOKEN:\?/, why: '${VAR:?} 必填语法：少了它，忘填 token 时服务带空鉴权静默启动' },
  { id: 'origins-required', pattern: /GUOZHAN_ORIGINS:\s*\$\{GUOZHAN_ORIGINS:\?/, why: 'Origin 白名单必填：少了它，任意网站的 JS 都能借玩家浏览器直连后端' },
  { id: 'llm-key-optional', pattern: /LLM_API_KEY:\s*\$\{LLM_API_KEY:-\}/, why: 'LLM_API_KEY 留空必须能跑（离线纯确定性模式），所以是 :- 而不是 :?' },
  { id: 'log-limits', pattern: /max-size:\s*"5m"[\s\S]*max-file:\s*"2"/, why: '少了它：小机器上日志无限增长写满磁盘' },
  { id: 'restart-policy', pattern: /restart:\s*unless-stopped/, why: '崩溃/重启机器后服务必须自动回来' },
];

test('docker-compose.yaml：存在且逐项含 §7.2 安全基线', () => {
  assertAllPresent('docker-compose.yaml', COMPOSE_ITEMS);
});

test('docker-compose.yaml：坏样本自证 —— 每一行都是承重的', () => {
  // 每个坏样本 = 抠掉一行，检查器必须报出对应 id（否则闸门是装饰品）
  assertItemIsLoadBearing('docker-compose.yaml', COMPOSE_ITEMS, /read_only:\s*true/, 'read-only-rootfs');
  assertItemIsLoadBearing('docker-compose.yaml', COMPOSE_ITEMS, /cap_drop:\s*\[ALL\]/, 'cap-drop-all');
  assertItemIsLoadBearing('docker-compose.yaml', COMPOSE_ITEMS, /no-new-privileges/, 'no-new-privileges');
  assertItemIsLoadBearing('docker-compose.yaml', COMPOSE_ITEMS, /127\.0\.0\.1:8788:8788/, 'port-loopback-only');
  assertItemIsLoadBearing('docker-compose.yaml', COMPOSE_ITEMS, /GUOZHAN_TOKEN:/, 'token-required');
});

test('docker-compose.yaml：端口绑定不得有 0.0.0.0 泄漏写法', () => {
  const content = read('docker-compose.yaml');
  // guozhan 服务的 ports 行里出现裸 "8788:8788"（不带 127.0.0.1）即公网泄漏
  const badPort = /^\s*-\s*"8788:8788"/m.test(content);
  assert.ok(!badPort, '发现 "8788:8788" 裸端口映射 —— 这会把服务暴露到公网');
});

// ─────────────────────────────────────────────────────────────
// .env.example
// ─────────────────────────────────────────────────────────────

test('.env.example：全部环境变量齐备且带注释', () => {
  const content = read('.env.example');
  for (const v of ['GUOZHAN_TOKEN', 'GUOZHAN_ORIGINS', 'LLM_API_BASE', 'LLM_API_KEY', 'LLM_MODEL', 'PORT', 'GUOZHAN_DATA_DIR']) {
    assert.match(content, new RegExp(`^${v}=`, 'm'), `.env.example 缺少 ${v}`);
  }
  // 每个变量上方必须有注释行（面向业主：不读代码也能配）
  const lines = norm(content).split('\n');
  for (const v of ['GUOZHAN_TOKEN', 'LLM_API_KEY']) {
    const idx = lines.findIndex((l) => l.startsWith(`${v}=`));
    assert.ok(idx > 0, `${v} 缺失`);
    const above = lines.slice(Math.max(0, idx - 6), idx).join('\n');
    assert.ok(above.includes('#'), `${v} 上方必须有注释说明`);
  }
  // ★LLM_API_KEY 留空必须能跑：样例文件里默认就是空值，且注释写明离线模式
  assert.match(content, /^LLM_API_KEY=\s*$/m, 'LLM_API_KEY 默认必须为空（离线纯确定性模式）');
  assert.match(content, /离线纯确定性/, '必须向业主写明：留空 = 离线纯确定性模式，游戏仍可玩');
  // 样例文件里不得有真实密钥形态的值
  assert.ok(!/^GUOZHAN_TOKEN=.+/m.test(content), '.env.example 里 GUOZHAN_TOKEN 必须是空占位，不得带样例密钥');

  // ★跨文件一致性：.env.example 里出现的每个 GUOZHAN_* 键，服务端必须真的读它。
  //   这条闸门来自一次真实事故：.env.example 写 DATA_DIR、main.ts 读 GUOZHAN_DATA_DIR，
  //   结果"设了数据目录却被静默忽略"，而所有测试当时都是绿的。
  const serverSources = ['src/server/main.ts', 'src/server/adapters/auth.ts', 'src/ai/llm-client.ts']
    .map((f) => read(f))
    .join('\n');
  const keys = [...content.matchAll(/^(GUOZHAN_[A-Z0-9_]+)=/gm)].map((m) => m[1]!);
  assert.ok(keys.length >= 2, '样例里至少要列出 GUOZHAN_TOKEN / GUOZHAN_ORIGINS');
  for (const k of keys) {
    assert.ok(serverSources.includes(k), `.env.example 声明了 ${k}，但服务端源码里没有任何地方读它（设了等于没设）`);
  }
  // compose 注入的 GUOZHAN_* 同样必须被服务端读取
  const compose = read('docker-compose.yaml');
  for (const m of compose.matchAll(/^\s+(GUOZHAN_[A-Z0-9_]+):/gm)) {
    assert.ok(serverSources.includes(m[1]!), `compose 注入了 ${m[1]}，但服务端不读它`);
  }
  assert.match(compose, /GUOZHAN_DATA_DIR:/, 'compose 必须用规范名 GUOZHAN_DATA_DIR（与 .env.example 一致）');
});

// ─────────────────────────────────────────────────────────────
// scripts/*.sh
// ─────────────────────────────────────────────────────────────

test('scripts：start/stop/backup 三件套存在、LF 行尾、shebang 正确', () => {
  for (const f of ['scripts/start.sh', 'scripts/stop.sh', 'scripts/backup.sh']) {
    const raw = read(f);
    assert.ok(!raw.includes('\r'), `${f} 含 CRLF —— #!/usr/bin/env bash 会失效（Windows/git-bash 实测坑）`);
    assert.match(raw, /^#!\/usr\/bin\/env bash\n/, `${f} 首行必须是 bash shebang`);
    assert.match(raw, /set -euo pipefail/, `${f} 必须 set -euo pipefail（静默失败是备份脚本最大的坑）`);
  }
});

test('scripts/start.sh：前置检查三件（Node≥24 / config 存在 / data 可写）+ 构建链完整', () => {
  const content = read('scripts/start.sh');
  // ★≥24 不是口味问题：node:sqlite 在 22.5–23.3 仍要 --experimental-sqlite，
  //   <22.5 根本没有这个模块。放行 22 会让脚本"检查通过"然后启动即崩。
  assert.match(content, /NODE_MAJOR.*-lt 24/s, '必须检查 Node 版本 ≥24（node:sqlite 免标志）');
  assert.ok(!/NODE_MAJOR.*-lt 22/.test(content), '不许残留 ≥22 的旧判据');
  assert.match(content, /config\/map\/regions\.json/, '必须检查 config 目录存在（用真实文件探测，不是只看目录名）');
  assert.match(content, /\.write-test/, '必须实际写一个探针文件验证 data 可写，touch 失败要报错退出');
  assert.match(content, /npm ci/, '必须 npm ci（锁定依赖树）');
  assert.match(content, /GUOZHAN_SKIP_INSTALL/, '跳过安装必须是显式开关，不能默认静默跳过');
  assert.match(content, /export GUOZHAN_DATA_DIR=/, '必须把数据目录导出成服务端认识的规范名（否则设了 DATA_DIR 会被忽略）');
  assert.match(content, /npm run build/, '必须构建');
  assert.match(content, /node --enable-source-maps dist\/main\.js/, '启动命令必须与 Dockerfile CMD 一致');
});

test('scripts/backup.sh：原子备份（sqlite3 .backup 优先，三件套复制兜底）', () => {
  const content = read('scripts/backup.sh');
  assert.match(content, /\.backup/, '必须优先用 sqlite3 .backup（在线原子备份，WAL 一致性由 SQLite 保证）');
  assert.match(content, /-wal/, '降级路径必须带上 -wal');
  assert.match(content, /-shm/, '降级路径必须带上 -shm（三件套缺一，恢复时会丢最近事务或打不开库）');
  assert.match(content, /rooms\/\*\.db/, '必须遍历 data/rooms/*.db（每房间一库，漏一个就漏一个房间的存档）');
  assert.match(content, /index\.db/, '房间注册表 index.db 也必须备份');
});

test('scripts/stop.sh：优雅停机（先 SIGTERM 等待，超时才 SIGKILL）', () => {
  const content = read('scripts/stop.sh');
  assert.match(content, /SIGTERM/, '必须先 SIGTERM 给 SQLite 机会做 WAL checkpoint');
  assert.match(content, /kill -9/, '超时兜底 SIGKILL');
  assert.match(content, /pgrep -f/, '无 PID 文件时必须有 pgrep 兜底');
});

test('deploy/guozhan.service：systemd 常驻 + 加固（且开机不构建）', () => {
  const raw = read('deploy/guozhan.service');
  assert.ok(!raw.includes('\r'), 'unit 文件必须是 LF（systemd 对 CRLF 不友好）');
  const svc = norm(raw);
  assert.match(svc, /\[Service\]/, '缺 [Service] 段');
  assert.match(svc, /Type=simple/, 'Type 必须是 simple（前台进程 + 日志进 journald）');
  assert.match(svc, /^User=(?!root)\w+(?::\w+)?/m, '必须以非 root 运行');
  assert.match(svc, /ExecStart=.*node .*dist\/main\.js/m, 'ExecStart 必须直接跑构建产物');
  assert.match(svc, /EnvironmentFile=.*\.env/m, '环境变量只从 .env 读（令牌不写进 unit）');
  assert.match(svc, /Restart=on-failure/, '挂了要自动拉起');

  // ★开机时不构建：只看**指令行**（注释里可以解释升级流程，但不能真去执行）
  const execLines = svc
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /^(ExecStart|ExecStartPre|ExecReload)=/.test(l));
  assert.ok(execLines.length >= 1, '必须至少有一条 ExecStart');
  assert.ok(
    !execLines.some((l) => /npm\s+(ci|run\s+build)|start\.sh/.test(l)),
    'ExecStart* 里不许 npm ci / build / start.sh（升级应离线构建后再 restart）',
  );

  // 加固最低线
  for (const line of [
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'RestrictAddressFamilies=',
    'LockPersonality=yes',
  ]) {
    assert.ok(svc.includes(line), `缺加固项：${line}`);
  }
  assert.match(svc, /ReadWritePaths=.*data/, '唯一可写路径必须是 data/');
  assert.match(svc, /MemoryMax=/, '1-2 核机型上必须设内存上限（OOM 才有可见约束）');
  assert.match(svc, /\[Install\][\s\S]*WantedBy=multi-user\.target/, '必须可 enable');
});

// ─────────────────────────────────────────────────────────────
// 配套工件
// ─────────────────────────────────────────────────────────────

test('deploy/Caddyfile：3 行反代到 guozhan:8788', () => {
  const content = read('deploy/Caddyfile');
  assert.match(content, /reverse_proxy\s+guozhan:8788/, 'Caddyfile 必须反代到 compose 网络内的 guozhan:8788');
});

test('.gitignore：必须排除 .qoder-credits/（别的会话留下的无关产物）与 .env / data', () => {
  const content = read('.gitignore');
  assert.match(content, /^\.qoder-credits\/?$/m, '.gitignore 必须排除 .qoder-credits/');
  assert.match(content, /^\.env$/m, '.gitignore 必须排除 .env（密钥不进版本库）');
  assert.match(content, /^!\.env\.example$/m, '但 .env.example 必须保留');
  assert.match(content, /^data\/$/m, '.gitignore 必须排除 data/（SQLite 库不进版本库）');
  assert.match(content, /^node_modules\/$/m);
});

test('.dockerignore：存在且排除 node_modules/.git/.env/data（防密钥进镜像层）', () => {
  const content = read('.dockerignore');
  for (const p of ['node_modules', '.git', '.env', 'data']) {
    assert.ok(
      norm(content).split('\n').some((l) => l.trim() === p || l.trim() === `${p}/` || l.trim().startsWith(`${p}\n`)),
      `.dockerignore 必须排除 ${p}`,
    );
  }
});

test('README.md：业主总入口 —— 文档索引/两条启动路线/环境变量表/扩展安装/验收清单', () => {
  const content = read('README.md');
  assert.match(content, /docs\/02-架构设计文档/, '必须索引架构文档');
  assert.match(content, /docker compose up -d/, '必须给 Docker 一键启动');
  assert.match(content, /scripts\/start\.sh/, '必须给裸跑启动');
  assert.match(content, /GUOZHAN_TOKEN/, '必须有环境变量表');
  assert.match(content, /extensions\/sillytavern-guozhan/, '必须索引酒馆扩展安装说明');
  assert.match(content, /npm run verify/, '必须有验收命令清单');
  assert.match(content, /已知限制/, '必须如实写已知限制');
});

// ─────────────────────────────────────────────────────────────
// SillyTavern 扩展工件
// ─────────────────────────────────────────────────────────────

const EXT = 'extensions/sillytavern-guozhan';

test('扩展清单 manifest.json：ST 标准字段齐备且 auto_update 关闭', () => {
  const manifest = JSON.parse(read(`${EXT}/manifest.json`));
  for (const k of ['display_name', 'loading_order', 'js', 'author', 'version']) {
    assert.ok(manifest[k] !== undefined, `manifest.json 缺少 ${k}`);
  }
  assert.equal(manifest.auto_update, false, 'auto_update 必须显式关闭（不联网自更新）');
  assert.equal(typeof manifest.loading_order, 'number');
  // js/css 指向的文件必须真实存在（ST 加载失败时静默无提示，极难排查）
  assert.ok(existsSync(`${EXT}/${manifest.js}`), `manifest.js 指向的 ${manifest.js} 不存在`);
  assert.ok(existsSync(`${EXT}/${manifest.css}`), `manifest.css 指向的 ${manifest.css} 不存在`);
});

test('★协议副本与后端 src/protocol 同步（源码指纹必须一致，防两端 schema 漂移）', async () => {
  const { sourceSha256, PROTOCOL_FILES } = await import('../../tools/build-protocol-bundle.ts');
  const sources: Record<string, string> = {};
  for (const f of PROTOCOL_FILES) {
    sources[f] = read(`src/protocol/${f}`);
  }
  const expected = sourceSha256(sources);
  const bundle = read(`${EXT}/lib/protocol.browser.js`);
  assert.match(bundle, /PROTOCOL_SOURCE_SHA256/, '产物必须带源码指纹');
  assert.ok(
    bundle.includes(expected),
    `协议副本过期：产物指纹与 src/protocol 当前指纹 ${expected.slice(0, 12)}… 不一致 —— ` +
    '改了协议必须重跑 node --experimental-strip-types tools/build-protocol-bundle.ts',
  );
});

test('★协议副本可加载且导出面完整（full/fallback 两种模式共用同一契约）', async () => {
  const bundlePath = new URL(`../../${EXT}/lib/protocol.browser.js`, import.meta.url).href;
  const m: any = await import(bundlePath);
  assert.ok(['full', 'fallback'].includes(m.PROTOCOL_BUNDLE_MODE), '必须标明打包模式');
  // 与 rejections.ts 逐项对账（第三方读数：直接解析源码，不信产物自己报的数）
  const src = read('src/protocol/rejections.ts');
  const srcCodes = [...src.matchAll(/^\s*([A-Z_]+): '([A-Z_]+)',/gm)].map((x) => x[2] as string);
  assert.ok(srcCodes.length >= 25, '解析前提：拒绝码应不少于 25 个');
  assert.deepEqual([...m.ALL_REJECTION_CODES].sort(), [...srcCodes].sort(), '拒绝码集合与源码不一致');
  for (const code of srcCodes) {
    const statusLine = src.match(new RegExp(`${code}: (\\d+),`));
    assert.ok(statusLine, `源码里 ${code} 应有 HTTP 状态映射`);
    assert.equal(m.REJECTION_HTTP_STATUS[code], Number(statusLine?.[1]), `${code} 的 HTTP 状态与源码不一致`);
  }
  assert.ok(m.ALL_COMMAND_KINDS.length >= 10, '命令 kind 面不完整');
  assert.ok(m.EVENT_TYPES.length >= 15, '事件类型面不完整');
  // ★SystemCommand 的 kind 绝不能泄漏进客户端副本（resolve_turn 等是受信转移）
  for (const sys of ['resolve_turn', 'timeout_lock', 'force_eliminate']) {
    assert.ok(!m.ALL_COMMAND_KINDS.includes(sys), `受信系统命令 ${sys} 泄漏进了浏览器协议副本`);
  }
});

test('★index.js 的拒绝码中文文案表覆盖全部拒绝码（缺一即玩家看到裸码）', () => {
  const indexJs = read(`${EXT}/index.js`);
  const src = read('src/protocol/rejections.ts');
  const codes = [...src.matchAll(/^\s*([A-Z_]+): '([A-Z_]+)',/gm)].map((x) => x[2] as string);
  const missing = codes.filter((c) => !new RegExp(`^\\s*${c}:`, 'm').test(indexJs));
  assert.deepEqual(missing, [], `以下拒绝码没有中文文案：${missing.join(', ')}`);
});

test('index.js：安全纪律在代码里真实存在（不是只在 README 里说说）', () => {
  const content = read(`${EXT}/index.js`);
  // 令牌只存内存 + pagehide 即断
  assert.match(content, /pagehide/, '必须监听 pagehide 断开连接并抹令牌');
  // ★坏样本教训：注释里就会出现"不写 localStorage…令牌"字样，所以只查**代码行为**——
  //   任何把 token 塞进持久存储的 setItem 调用都不允许
  assert.ok(!/setItem\([^)]*token/i.test(content), '令牌不得经 localStorage.setItem 落盘');
  // 服务端数据按纯文本渲染（防 XSS/HTML 注入）
  assert.match(content, /textContent/, '服务端数据必须走 textContent 渲染');
  assert.ok(!/innerHTML\s*=/.test(content), '不得对内使用 innerHTML 赋值（服务端数据可能含 HTML）');
  // STALE_REVISION → 重新拉快照而非盲目重发
  assert.match(content, /STALE_REVISION/, '必须显式处理 STALE_REVISION');
  assert.match(content, /fetchSnapshot\(\)[\s\S]{0,200}重下命令|重新拉取快照/, '409 后必须重拉快照');
  // CAS + 幂等
  assert.match(content, /requestId/, '提交必须带 requestId 幂等键');
  assert.match(content, /stateId/, '提交必须带 stateId CAS');
  // 防提示注入包裹
  assert.match(content, /游戏数据开始/, '战报注入必须带"游戏数据非指令"包裹标记');
  // 断线补发
  assert.match(content, /from['"]?\s*[,:=]|set\('from'/, '重连必须带 from=offset 补发');
});
