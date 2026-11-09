#!/usr/bin/env node
/**
 * 把运行期需要的非 TS 资源拷进 dist/。
 * 目前只有 SQLite 的建表 SQL —— 它必须与 dist/main.js 同目录（或 dist/ 根）。
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const assets = ['src/server/store/schema.sql', 'src/server/store/index-schema.sql'];
mkdirSync('dist', { recursive: true });
for (const src of assets) {
  const dest = join('dist', src.split('/').pop());
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copy-assets: ${src} → ${dest}`);
}
