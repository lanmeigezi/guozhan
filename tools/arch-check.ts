/**
 * 架构闸门 —— 机器强制 P4「确定性核心零 IO / 零时钟 / 零系统随机」。
 *
 * 借鉴 aonw 的 tool/test_engine_architecture.py：边界规则不写在文档里，写成会红的测试。
 * 文档约定会被"顺手改一下"绕过，闸门不会。
 *
 * 零依赖，裸 Node 可跑：
 *   node --experimental-strip-types tools/arch-check.ts            # 全量检查，违规 EXIT=1
 *   node --experimental-strip-types --test tests/deterministic/architecture.test.ts
 *
 * ★本闸门自带区分力证明：architecture.test.ts 会往临时目录注入违规样本，
 *   每个坏样本必须被抓到。抓不到就是闸门没用，不许签收。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

/** 核心绝不允许 import 的 Node 内置模块（含仅类型导入 —— 那说明设计已经越界） */
const FORBIDDEN_BUILTINS = new Set([
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:net',
  'node:http',
  'node:https',
  'node:crypto',
  'node:child_process',
  'node:os',
  'node:worker_threads',
  'node:process',
  'node:sqlite',
  'node:dns',
  'node:tls',
]);

/** 核心绝不允许依赖的第三方包 */
const FORBIDDEN_PACKAGES = new Set([
  'zod',
  'ws',
  'better-sqlite3',
  '@modelcontextprotocol/sdk',
  'express',
  'fastify',
  'hono',
]);

/** 核心不得依赖的外层目录（依赖方向必须单向向内） */
const FORBIDDEN_LAYERS = ['server', 'ai', 'adapters'];

/** 禁用全局：任何一个出现都意味着核心不再是纯函数 */
const FORBIDDEN_GLOBALS: ReadonlyArray<{ pattern: RegExp; rule: string; why: string }> = [
  { pattern: /\bMath\s*\.\s*random\b/g, rule: 'no-system-random', why: '破坏确定性；用 ctx.rng()' },
  { pattern: /\bDate\s*\.\s*now\s*\(/g, rule: 'no-clock', why: '破坏确定性；用 ctx.now' },
  { pattern: /\bnew\s+Date\s*\(/g, rule: 'no-clock', why: '破坏确定性；用 ctx.now' },
  { pattern: /\bperformance\s*\.\s*now\s*\(/g, rule: 'no-clock', why: '破坏确定性' },
  { pattern: /\bprocess\s*\.\s*env\b/g, rule: 'no-env', why: '配置必须经 world 参数显式传入' },
  { pattern: /(?<![\w.$])fetch\s*\(/g, rule: 'no-network', why: '核心不发网络请求' },
  { pattern: /\b(setTimeout|setInterval|setImmediate)\s*\(/g, rule: 'no-timer', why: '核心不调度；异步归房间层' },
  { pattern: /\brequire\s*\(/g, rule: 'no-require', why: 'ESM only，且动态 require 绕过静态检查' },
  { pattern: /\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/g, rule: 'no-console', why: '核心保持沉默；日志归外层' },
  { pattern: /\bcrypto\s*\.\s*(?:getRandomValues|random\w*)\s*\(/g, rule: 'no-system-random', why: '破坏确定性；用 ctx.rng()' },
  { pattern: /\brandomBytes\s*\(/g, rule: 'no-system-random', why: '破坏确定性；用 ctx.rng()' },
];

/**
 * 剥掉注释但**保留行结构**（换成等长空白），否则会误伤：
 * 本项目源码注释里就写着"不得调用 Date.now()"这类字样。
 * 同时正确处理字符串字面量里的 // 与 /*。
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';
  while (i < n) {
    const c = src[i] as string;
    const c2 = src[i + 1];
    switch (mode) {
      case 'code':
        if (c === '/' && c2 === '/') { mode = 'line'; out += '  '; i += 2; continue; }
        if (c === '/' && c2 === '*') { mode = 'block'; out += '  '; i += 2; continue; }
        if (c === "'") { mode = 'sq'; out += c; i++; continue; }
        if (c === '"') { mode = 'dq'; out += c; i++; continue; }
        if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
        out += c; i++; continue;
      case 'line':
        if (c === '\n') { mode = 'code'; out += '\n'; } else { out += ' '; }
        i++; continue;
      case 'block':
        if (c === '*' && c2 === '/') { mode = 'code'; out += '  '; i += 2; continue; }
        out += c === '\n' ? '\n' : ' ';
        i++; continue;
      case 'sq':
        out += c;
        if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
        if (c === "'") mode = 'code';
        i++; continue;
      case 'dq':
        out += c;
        if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
        if (c === '"') mode = 'code';
        i++; continue;
      case 'tpl':
        out += c;
        if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
        if (c === '`') mode = 'code';
        i++; continue;
    }
  }
  return out;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/** 提取所有 import / export-from 的模块说明符及其是否为 type-only */
export function extractImports(code: string): Array<{ spec: string; typeOnly: boolean; index: number }> {
  const found: Array<{ spec: string; typeOnly: boolean; index: number }> = [];
  // import [type] ... from 'x'   /   export [type] ... from 'x'
  const reFrom = /\b(?:import|export)\s+(type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(reFrom)) {
    found.push({
      spec: m[2] as string,
      typeOnly: Boolean(m[1]),
      index: m.index ?? 0,
    });
  }
  // 副作用导入 import 'x'
  const reSide = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(reSide)) {
    found.push({ spec: m[1] as string, typeOnly: false, index: m.index ?? 0 });
  }
  // 动态 import('x')
  const reDyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(reDyn)) {
    found.push({ spec: m[1] as string, typeOnly: false, index: m.index ?? 0 });
  }
  return found;
}

function checkImports(file: string, code: string, out: Violation[]): void {
  for (const imp of extractImports(code)) {
    const line = lineOf(code, imp.index);
    const spec = imp.spec;

    if (spec.startsWith('node:')) {
      if (FORBIDDEN_BUILTINS.has(spec)) {
        out.push({ file, line, rule: 'no-io-import', text: `import '${spec}' —— 核心不得触碰 IO` });
      }
      continue;
    }

    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string);
      if (FORBIDDEN_PACKAGES.has(pkg)) {
        out.push({
          file,
          line,
          rule: 'no-framework-import',
          text: `import '${spec}' —— 核心零框架依赖${imp.typeOnly ? '（即便是 type-only 也不行，说明类型该定义在 core 内）' : ''}`,
        });
      }
      continue;
    }

    // 相对导入：禁止向外层（server/ai/adapters）依赖
    const norm = spec.split('/');
    for (const layer of FORBIDDEN_LAYERS) {
      if (norm.includes(layer) || norm.includes(`..${sep}${layer}`)) {
        out.push({
          file,
          line,
          rule: 'no-outward-dependency',
          text: `import '${spec}' —— 依赖方向必须单向向内，core 不得依赖 ${layer}/`,
        });
      }
    }
    // protocol 只允许 type-only 导入（protocol 里有 zod，值导入会把 zod 拖进核心）
    if (norm.includes('protocol') && !imp.typeOnly) {
      out.push({
        file,
        line,
        rule: 'protocol-type-only',
        text: `import '${spec}' —— 从 protocol 只能用 'import type'（否则 zod 会成为核心的运行时依赖）`,
      });
    }
  }
}

function checkGlobals(file: string, code: string, out: Violation[]): void {
  for (const { pattern, rule, why } of FORBIDDEN_GLOBALS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of code.matchAll(re)) {
      out.push({
        file,
        line: lineOf(code, m.index ?? 0),
        rule,
        text: `${(m[0] ?? '').trim()} —— ${why}`,
      });
    }
  }
}

/**
 * 把字符串/模板字面量的**内容**也抹成空白（保留引号与长度、保留换行）。
 *
 * 为什么需要它：解析 import 要看得见 `'node:fs'` 这个说明符，但扫描禁用全局时
 * 又不能被文档字符串里的 "禁止 Math.random()" 触发假阳性。同一份源码需要两个视图：
 *   · stripComments 的产物 → 喂 checkImports（保留字符串内容）
 *   · blankStringLiterals 的产物 → 喂 checkGlobals（抹掉字符串内容）
 *
 * 模板字面量的 `${...}` 插值**保留可扫描** —— 那里面是真代码，
 * `` `x ${Math.random()} y` `` 必须被抓到。
 */
export function blankStringLiterals(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type Mode = 'code' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';
  /** >0 表示正处在模板插值 ${...} 内部，值为花括号深度 */
  let interpDepth = 0;

  while (i < n) {
    const c = src[i] as string;
    const c2 = src[i + 1];

    if (mode === 'code') {
      if (interpDepth > 0) {
        if (c === '{') interpDepth++;
        else if (c === '}') {
          interpDepth--;
          if (interpDepth === 0) { mode = 'tpl'; out += ' '; i++; continue; }
        }
      } else {
        if (c === "'") { mode = 'sq'; out += c; i++; continue; }
        if (c === '"') { mode = 'dq'; out += c; i++; continue; }
        if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
      }
      out += c;
      i++;
      continue;
    }

    if (mode === 'sq' || mode === 'dq') {
      const quote = mode === 'sq' ? "'" : '"';
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { mode = 'code'; out += c; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    // tpl
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { mode = 'code'; out += c; i++; continue; }
    if (c === '$' && c2 === '{') {
      mode = 'code';
      interpDepth = 1;
      out += '  ';
      i += 2;
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i++;
  }
  return out;
}

/** 检查单个源文件内容（不读盘，便于测试注入违规样本） */
export function checkSource(file: string, rawSource: string): Violation[] {
  const out: Violation[] = [];
  const noComments = stripComments(rawSource);
  const noLiterals = blankStringLiterals(noComments);
  checkImports(file, noComments, out);
  checkGlobals(file, noLiterals, out);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

/** 检查整个 core 目录 */
export function checkDirectory(coreDir: string): Violation[] {
  const out: Violation[] = [];
  for (const file of walk(coreDir)) {
    const rel = relative(process.cwd(), file).split(sep).join('/');
    out.push(...checkSource(rel, readFileSync(file, 'utf8')));
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

// ── CLI ──
const isMain = process.argv[1] !== undefined && process.argv[1].split(sep).join('/').endsWith('tools/arch-check.ts');
if (isMain) {
  const target = process.argv[2] ?? 'src/core';
  const violations = checkDirectory(target);
  if (violations.length === 0) {
    process.stdout.write(`arch-check: OK  ${target} 无违规（零 IO / 零时钟 / 零系统随机 / 依赖方向向内）\n`);
    process.exit(0);
  }
  process.stdout.write(`arch-check: FAIL  ${violations.length} 处违规\n\n`);
  for (const v of violations) {
    process.stdout.write(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.text}\n`);
  }
  process.stdout.write('\n核心必须是纯函数：不读文件、不读时钟、不用系统随机、不发网络请求、不依赖外层。\n');
  process.exit(1);
}
