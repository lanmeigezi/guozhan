/**
 * 协议浏览器打包器 —— 生成 extensions/sillytavern-guozhan/lib/protocol.browser.js
 *
 * ★为什么必须有它：架构文档 §1.1 要求酒馆扩展"与后端同一份 zod schema 生成"。
 *   手抄一份协议到浏览器端 = 两份真源 = 日久必然漂移（拒绝码改名、事件加字段，
 *   扩展端静默失效）。本工具从 src/protocol/ 单一真源生成，deploy.test.ts 有同步闸门。
 *
 * 两种模式：
 *   · full     —— esbuild 打包（zod schema 真身进浏览器，扩展端可做运行时校验）。
 *                 esbuild 随 tsup 在 devDependencies 里，`npm ci` 过即可用。
 *   · fallback —— esbuild/zod 不可用时（如本机 npm EPERM 装不上依赖），
 *                 用正则从源码抽取字面量表（拒绝码/HTTP 状态/命令 kind/事件类型/可见性），
 *                 生成纯数据 ES module。扩展依赖的导出面在两种模式下完全一致，
 *                 只是 fallback 模式没有 zod 运行时校验能力（PROTOCOL_BUNDLE_MODE 标明）。
 *
 * 跑法：node --experimental-strip-types tools/build-protocol-bundle.ts
 * 输出确定性：不带时间戳，带源码 sha256 —— 源码不变则产物逐字节不变。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
const PROTOCOL_DIR = join(ROOT, 'src', 'protocol');
const OUT_FILE = join(ROOT, 'extensions', 'sillytavern-guozhan', 'lib', 'protocol.browser.js');

const PROTOCOL_FILES = ['commands.ts', 'events.ts', 'rejections.ts', 'snapshot.ts', 'advice.ts'] as const;

/** 导出给 deploy.test.ts 的同步闸门复用（哈希算法单一真源，避免测试里再抄一份漂移） */
export { PROTOCOL_FILES, sourceSha256, OUT_FILE };

function readProtocolSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of PROTOCOL_FILES) {
    const p = join(PROTOCOL_DIR, f);
    if (!existsSync(p)) throw new Error(`协议源文件缺失：${p}`);
    out[f] = readFileSync(p, 'utf8');
  }
  return out;
}

function sourceSha256(sources: Record<string, string>): string {
  const h = createHash('sha256');
  for (const f of PROTOCOL_FILES) h.update(f).update('\n').update(sources[f] ?? '').update('\n');
  return h.digest('hex');
}

// ─────────────────────────────────────────────────────────────
// full 模式：esbuild
// ─────────────────────────────────────────────────────────────

/**
 * 打包入口（走 esbuild stdin，不在仓库里留额外源文件）。
 * ★导出面 = 扩展 index.js 依赖的契约，两种模式必须一致：
 *   RejectionCode / ALL_REJECTION_CODES / REJECTION_HTTP_STATUS /
 *   EVENT_VISIBILITY / ALL_COMMAND_KINDS / EVENT_TYPES /
 *   PROTOCOL_BUNDLE_MODE / PROTOCOL_SOURCE_SHA256
 * full 模式额外带全部 zod schema（SnapshotSchema 等），扩展端可选做运行时校验。
 */
const ENTRY_SOURCE = `
export * from '../src/protocol/commands.ts';
export * from '../src/protocol/events.ts';
export * from '../src/protocol/rejections.ts';
export * from '../src/protocol/snapshot.ts';
export * from '../src/protocol/advice.ts';
import { DomainEventSchema } from '../src/protocol/events.ts';
export const EVENT_TYPES = Object.freeze(
  DomainEventSchema.options.map((o) => o.shape.type.value),
);
export const PROTOCOL_BUNDLE_MODE = 'full';
`;

async function buildWithEsbuild(sha: string): Promise<string | null> {
  // 测试钩子：GUOZHAN_FORCE_FALLBACK=1 强制走降级路径（deploy.test.ts 用它证明 fallback 可用）
  if (process.env['GUOZHAN_FORCE_FALLBACK'] === '1') {
    process.stdout.write('[protocol-bundle] GUOZHAN_FORCE_FALLBACK=1，跳过 esbuild\n');
    return null;
  }
  try {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      stdin: {
        contents: ENTRY_SOURCE,
        resolveDir: join(ROOT, 'tools'),
        sourcefile: 'protocol-browser-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      write: false,
      minify: false,
      legalComments: 'none',
    });
    const first = result.outputFiles?.[0];
    if (!first) return null;
    return `${header(sha, 'full')}\n${first.text}\nexport const PROTOCOL_SOURCE_SHA256 = ${JSON.stringify(sha)};\n`;
  } catch (err) {
    process.stdout.write(`[protocol-bundle] esbuild 不可用（${String(err)}），降级 fallback 模式\n`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// fallback 模式：正则抽字面量表（零依赖）
// ─────────────────────────────────────────────────────────────

function extractSection(src: string, startMarker: string, endMarker: string, label: string): string {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`fallback 抽取失败：找不到 ${label} 的起点 '${startMarker}'`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`fallback 抽取失败：找不到 ${label} 的终点 '${endMarker}'`);
  return src.slice(start, end);
}

function extractStringPairs(section: string, label: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const m of section.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']+)'\s*,/gm)) {
    pairs.push([m[1] ?? '', m[2] ?? '']);
  }
  if (pairs.length === 0) throw new Error(`fallback 抽取失败：${label} 一条都没抽到`);
  return pairs;
}

function extractNumberPairs(section: string, label: string): Array<[string, number]> {
  const pairs: Array<[string, number]> = [];
  for (const m of section.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\d+)\s*,/gm)) {
    pairs.push([m[1] ?? '', Number(m[2])]);
  }
  if (pairs.length === 0) throw new Error(`fallback 抽取失败：${label} 一条都没抽到`);
  return pairs;
}

function extractLiterals(section: string, field: 'kind' | 'type', label: string): string[] {
  const re = field === 'kind' ? /kind:\s*z\.literal\('([a-z_]+)'\)/g : /type:\s*z\.literal\('([a-z_]+)'\)/g;
  const out: string[] = [];
  for (const m of section.matchAll(re)) {
    const v = m[1] ?? '';
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length === 0) throw new Error(`fallback 抽取失败：${label} 一条都没抽到`);
  return out;
}

const jsObj = (pairs: Array<[string, string | number]>): string =>
  `{\n${pairs.map(([k, v]) => `  ${JSON.stringify(k)}: ${typeof v === 'number' ? v : JSON.stringify(v)},`).join('\n')}\n}`;

function buildFallback(sources: Record<string, string>, sha: string): string {
  const rejections = sources['rejections.ts'] ?? '';
  const commands = sources['commands.ts'] ?? '';
  const events = sources['events.ts'] ?? '';

  const codeSection = extractSection(rejections, 'export const RejectionCode = {', '} as const;', 'RejectionCode');
  const codes = extractStringPairs(codeSection, 'RejectionCode');

  const statusSection = extractSection(rejections, 'export const REJECTION_HTTP_STATUS', '});', 'REJECTION_HTTP_STATUS');
  const statuses = extractNumberPairs(statusSection, 'REJECTION_HTTP_STATUS');
  if (statuses.length !== codes.length) {
    throw new Error(`fallback 自检失败：拒绝码 ${codes.length} 个但 HTTP 状态映射 ${statuses.length} 个 —— 源码里有码没配状态`);
  }

  const visSection = extractSection(events, 'export const EVENT_VISIBILITY', '});', 'EVENT_VISIBILITY');
  const visibility = extractStringPairs(visSection, 'EVENT_VISIBILITY');

  // DomainCommand 的 kind：只取 MoveUnitsCommandSchema..DomainCommandSchema 区段，
  // 否则会把 SystemCommand 的 kind（resolve_turn 等，永不暴露给客户端）也抽进来
  const cmdSection = extractSection(commands, 'export const MoveUnitsCommandSchema', 'export const DomainCommandSchema', 'DomainCommand 区段');
  const commandKinds = extractLiterals(cmdSection, 'kind', 'ALL_COMMAND_KINDS');

  const evSection = extractSection(events, 'export const DomainEventSchema', ']);', 'DomainEventSchema');
  const eventTypes = extractLiterals(evSection, 'type', 'EVENT_TYPES');

  return `${header(sha, 'fallback')}
export const PROTOCOL_BUNDLE_MODE = 'fallback';
export const PROTOCOL_SOURCE_SHA256 = ${JSON.stringify(sha)};

export const RejectionCode = Object.freeze(${jsObj(codes)});
export const ALL_REJECTION_CODES = Object.freeze(Object.values(RejectionCode));
export const REJECTION_HTTP_STATUS = Object.freeze(${jsObj(statuses)});
export const EVENT_VISIBILITY = Object.freeze(${jsObj(visibility)});
export const ALL_COMMAND_KINDS = Object.freeze(${JSON.stringify(commandKinds)});
export const EVENT_TYPES = Object.freeze(${JSON.stringify(eventTypes)});
`;
}

function header(sha: string, mode: string): string {
  return [
    '/**',
    ' * protocol.browser.js —— ★生成文件，勿手改。',
    ' * 单一真源：src/protocol/*.ts；生成器：tools/build-protocol-bundle.ts',
    ` * 模式：${mode}（full=zod schema 真身可运行时校验；fallback=纯数据表，无校验能力）`,
    ` * 源码指纹：sha256:${sha}`,
    ' * 同步闸门：tests/deterministic/deploy.test.ts 会核对产物与源码一致。',
    ' */',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sources = readProtocolSources();
  const sha = sourceSha256(sources);
  let bundle = await buildWithEsbuild(sha);
  let mode = 'full';
  if (bundle === null) {
    bundle = buildFallback(sources, sha);
    mode = 'fallback';
  }
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, bundle, 'utf8');
  process.stdout.write(
    `[protocol-bundle] OK mode=${mode} sha256=${sha.slice(0, 12)}… ${bundle.length} bytes → ${OUT_FILE}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined && process.argv[1].split(/[\\/]/).join('/').endsWith('tools/build-protocol-bundle.ts');
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[protocol-bundle] FAIL ${String(err)}\n`);
    process.exit(1);
  });
}
