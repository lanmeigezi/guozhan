/**
 * 架构闸门测试 —— 证明 arch-check 真的有区分力。
 *
 * 两部分：
 *   A. 正向：真实 src/core/ 必须零违规
 *   B. 负向：**每一条规则**注入违规样本后必须被抓到（抓不到 = 闸门没用，不许签收）
 *   C. 假阳性防护：注释与字符串里提到禁用词不得触发
 *
 * 零依赖：node --experimental-strip-types --test tests/deterministic/architecture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDirectory, checkSource, stripComments } from '../../tools/arch-check.ts';

// ─────────────────────────────────────────────────────────────
// A. 正向：真实核心必须干净
// ─────────────────────────────────────────────────────────────

test('src/core/ 全量扫描：零违规', () => {
  const violations = checkDirectory('src/core');
  assert.deepEqual(
    violations,
    [],
    `核心出现 ${violations.length} 处架构违规：\n` +
      violations.map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n'),
  );
});

// ─────────────────────────────────────────────────────────────
// B. 负向：每条规则都必须能抓到坏样本
// ─────────────────────────────────────────────────────────────

/** 坏样本清单：rule 是期望被抓到的规则名，src 是注入的违规代码 */
const BAD_SAMPLES: ReadonlyArray<{ name: string; rule: string; src: string }> = [
  { name: 'node:fs 导入', rule: 'no-io-import', src: `import { readFileSync } from 'node:fs';\nexport const x = 1;\n` },
  { name: 'node:crypto 导入', rule: 'no-io-import', src: `import { randomBytes } from 'node:crypto';\nexport const x = randomBytes(4);\n` },
  { name: 'node:http 导入', rule: 'no-io-import', src: `import http from 'node:http';\nexport const x = http;\n` },
  { name: 'zod 值导入', rule: 'no-framework-import', src: `import { z } from 'zod';\nexport const s = z.string();\n` },
  { name: 'better-sqlite3 导入', rule: 'no-framework-import', src: `import Database from 'better-sqlite3';\nexport const db = new Database(':memory:');\n` },
  { name: 'ws 导入', rule: 'no-framework-import', src: `import { WebSocketServer } from 'ws';\nexport const w = WebSocketServer;\n` },
  { name: '依赖 server 层', rule: 'no-outward-dependency', src: `import { RoomManager } from '../server/room/manager.ts';\nexport const x = RoomManager;\n` },
  { name: '依赖 ai 层', rule: 'no-outward-dependency', src: `import { AiAdvisor } from '../ai/advisor.ts';\nexport const x = AiAdvisor;\n` },
  { name: 'protocol 值导入（会把 zod 拖进核心）', rule: 'protocol-type-only', src: `import { DomainCommandSchema } from '../protocol/commands.ts';\nexport const x = DomainCommandSchema;\n` },
  { name: 'Math.random', rule: 'no-system-random', src: `export function f(): number {\n  return Math.random();\n}\n` },
  { name: 'crypto.getRandomValues', rule: 'no-system-random', src: `export function f(): void {\n  globalThis.crypto.getRandomValues(new Uint8Array(4));\n}\n` },
  { name: 'randomBytes()', rule: 'no-system-random', src: `export function f(): unknown {\n  return randomBytes(8);\n}\n` },
  {
    name: '模板插值里的 Math.random（插值是真代码，必须抓到）',
    rule: 'no-system-random',
    src: 'export const s = `roll=${Math.random()}`;\n',
  },
  {
    name: '模板插值里的 Date.now',
    rule: 'no-clock',
    src: 'export const s = `t=${Date.now()}`;\n',
  },
  { name: 'Date.now()', rule: 'no-clock', src: `export function f(): number {\n  return Date.now();\n}\n` },
  { name: 'new Date()', rule: 'no-clock', src: `export function f(): string {\n  return new Date().toISOString();\n}\n` },
  { name: 'performance.now()', rule: 'no-clock', src: `export function f(): number {\n  return performance.now();\n}\n` },
  { name: 'process.env', rule: 'no-env', src: `export const key = process.env.LLM_API_KEY;\n` },
  { name: 'fetch()', rule: 'no-network', src: `export async function f(): Promise<void> {\n  await fetch('http://x/y');\n}\n` },
  { name: 'setTimeout', rule: 'no-timer', src: `export function f(): void {\n  setTimeout(() => {}, 100);\n}\n` },
  { name: 'setInterval', rule: 'no-timer', src: `export function f(): void {\n  setInterval(() => {}, 100);\n}\n` },
  { name: 'require()', rule: 'no-require', src: `export const m = require('node:fs');\n` },
  { name: 'console.log', rule: 'no-console', src: `export function f(): void {\n  console.log('debug');\n}\n` },
  { name: 'console.error', rule: 'no-console', src: `export function f(): void {\n  console.error('boom');\n}\n` },
  { name: '副作用导入 node:fs', rule: 'no-io-import', src: `import 'node:fs';\nexport const x = 1;\n` },
  { name: '动态 import', rule: 'no-io-import', src: `export async function f(): Promise<unknown> {\n  return await import('node:fs');\n}\n` },
];

for (const sample of BAD_SAMPLES) {
  test(`坏样本必须被抓到：${sample.name}`, () => {
    const violations = checkSource('src/core/fake.ts', sample.src);
    const hit = violations.find((v) => v.rule === sample.rule);
    assert.ok(
      hit !== undefined,
      `闸门漏掉了「${sample.name}」——期望规则 ${sample.rule}，` +
        `实得 [${violations.map((v) => v.rule).join(', ') || '无'}]。` +
        `这条变异无区分力，不许签收。`,
    );
    // 行号必须准确（否则报错信息没法定位）
    assert.ok((hit?.line ?? 0) >= 1, '行号必须 ≥1');
  });
}

// ─────────────────────────────────────────────────────────────
// C. 假阳性防护：注释与字符串不得触发
// ─────────────────────────────────────────────────────────────

test('注释里提到禁用词不得触发（本项目源码注释就有这类字样）', () => {
  const src = [
    '/**',
    ' * ★铁律：本文件不得调用 Math.random() / Date.now() / 任何系统随机源。',
    ' * 也不要 import node:crypto 或 node:fs。',
    ' */',
    '// 单行注释里的 process.env.FOO 和 fetch( 也不算',
    '/* 块注释里的 console.log("x") 也不算 */',
    'export function f(seed: number): number {',
    '  return seed ^ 0x5f3759df;',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(checkSource('src/core/commented.ts', src), []);
});

test('字符串字面量里的禁用词不得触发', () => {
  const src = [
    "export const DOC = '禁止 Math.random() 与 Date.now()，也不要 new Date()';",
    'export const URL = "https://example.com/fetch(";',
    'export const TPL = `process.env.SECRET 不该出现在这里`;',
    "export const SLASH = 'a // b 不是注释';",
    "export const STAR = 'a /* b 不是块注释';",
    '',
  ].join('\n');
  assert.deepEqual(checkSource('src/core/strings.ts', src), []);
});

test('合法的核心写法必须放行', () => {
  const src = [
    "import type { GameState, WorldConfig } from './state.ts';",
    "import type { DomainCommand } from '../protocol/commands.ts';",
    "import { DeterministicRng } from './rng.ts';",
    "import type { RuleModule } from './module.ts';",
    '',
    'export function f(state: GameState, world: WorldConfig, rng: DeterministicRng): number {',
    '  void state; void world;',
    '  return rng.nextInt(1, 6);',
    '}',
    'export type Cmd = DomainCommand;',
    'export type Mod = RuleModule;',
    '',
  ].join('\n');
  assert.deepEqual(checkSource('src/core/legal.ts', src), []);
});

// ─────────────────────────────────────────────────────────────
// D. stripComments 自身必须正确（它是整个闸门的地基）
// ─────────────────────────────────────────────────────────────

test('stripComments：保留行结构、剥净注释、不动字符串', () => {
  const src = "const a = 1; // 注释\n/* 块\n注释 */\nconst b = 'x // y';\n";
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length, '行数必须保持，否则报错行号全错');
  assert.ok(!out.includes('注释'), '注释内容必须被剥掉');
  assert.ok(out.includes("'x // y'"), '字符串内容必须保留');
  assert.ok(out.includes('const a = 1;'), '代码必须保留');
});

test('stripComments：转义引号不得提前结束字符串', () => {
  const src = "const s = 'a\\'// b'; // 真注释\nconst t = 2;\n";
  const out = stripComments(src);
  assert.ok(out.includes("'a\\'// b'"), '转义引号内的 // 必须当作字符串内容');
  assert.ok(!out.includes('真注释'), '真注释必须被剥掉');
  assert.ok(out.includes('const t = 2;'), '后续代码必须保留（说明字符串状态正确退出了）');
});
