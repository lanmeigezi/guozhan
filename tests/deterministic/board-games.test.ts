/**
 * 桌游合集工件闸门 —— 确认 APK 里的其他小游戏真的进了酒馆交付包，而不是只写在 README。
 *
 * 对账项：
 *   ① board-games 运行时齐全（服务端/核心/Web 资源/无 node_modules/无 APK）；
 *   ② 一键启动、Dockerfile、compose、.env.example 都真的带上它；
 *   ③ 酒馆扩展真的有“桌游合集地址 + 新标签页/内嵌 iframe”入口，且不传席位令牌。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BG = join(ROOT, 'board-games');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const readBg = (rel: string): string => readFileSync(join(BG, rel), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    out.push(abs);
    if (entry.isDirectory()) out.push(...walk(abs));
  }
  return out;
}

test('board-games 运行时完整且零依赖、不含 Android 构建物', () => {
  for (const rel of [
    'server/server.mjs',
    'server/room.mjs',
    'server/llm.mjs',
    'core/src/index.js',
    'core/src/agent.js',
    'core/src/llm-local.js',
    'core/src/host.js',
    'core/src/games.js',
    'core/src/guozhan/engine.bundle.js',
    'app/src/main/assets/www/index.html',
    'app/src/main/assets/www/app.js',
    'app/src/main/assets/www/style.css',
    'app/src/main/assets/www/uno-core.bundle.js',
    'package.json',
    'README.md',
  ]) {
    assert.ok(existsSync(join(BG, rel)), `board-games 缺少 ${rel}`);
  }
  const pkg = JSON.parse(readBg('package.json'));
  assert.equal(pkg.private, true);
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '桌游合集必须零运行时依赖');
  assert.ok(!existsSync(join(BG, 'node_modules')), '交付包不得包含 node_modules');
  assert.ok(!existsSync(join(BG, 'app/build')), '交付包不得包含 Android 构建目录');
  const forbidden = walk(BG).filter((p) => /\.(apk|aab|keystore)$/i.test(p) || /[\\/]node_modules[\\/]/.test(p));
  assert.deepEqual(forbidden, [], `交付包混入 Android/依赖产物：${forbidden.join(', ')}`);
  const appBundle = readBg('app/src/main/assets/www/uno-core.bundle.js');
  for (const game of ['uno', 'doudizhu', 'exploding', 'liarsbar', 'guozhan', 'monopoly', 'werewolf']) {
    assert.ok(appBundle.includes(game), `桌游合集 bundle 缺少游戏 ${game}`);
  }
});

test('启动/部署工件都带上了桌游合集', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['start:board'], /start-board-games\.mjs/);
  assert.ok(existsSync(join(ROOT, 'scripts/start-board-games.mjs')));
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^COPY board-games\/ \.\/board-games\/$/m);
  assert.match(dockerfile, /^EXPOSE 8766$/m);
  const compose = read('docker-compose.yaml');
  assert.match(compose, /^\s{2}board-games:$/m);
  assert.match(compose, /board-games\/server\/server\.mjs/);
  assert.match(compose, /127\.0\.0\.1:8766:8766/);
  const env = read('.env.example');
  for (const key of ['BOARD_GAMES_PORT', 'BOARD_GAMES_HOST', 'BOARD_GAMES_DEFAULT_GAME']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `.env.example 缺少 ${key}`);
  }
});

test('酒馆扩展有桌游合集入口，且不把席位令牌传给桌游页', () => {
  const index = read('extensions/sillytavern-guozhan/index.js');
  assert.match(index, /id="guozhan_board_url"/);
  assert.match(index, /function openBoardGames\(/);
  assert.match(index, /createElement\('iframe'\)/);
  assert.match(index, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
  assert.match(index, /boardGamesUrl/);
  // 令牌只属于国战传输层；桌游入口不读取 session.token
  const boardStart = index.indexOf('function openBoardGames(');
  const boardBlock = index.slice(boardStart, index.indexOf('\nfunction ', boardStart + 1));
  assert.ok(!/session\.token/.test(boardBlock), '桌游合集入口不得读取/传递国战席位令牌');
  const manifest = JSON.parse(read('extensions/sillytavern-guozhan/manifest.json'));
  assert.equal(manifest.auto_update, false);
  assert.match(manifest.display_name, /桌游合集/);
});
