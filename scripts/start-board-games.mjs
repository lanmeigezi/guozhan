#!/usr/bin/env node
/**
 * 启动桌游合集房间服务（UNO/斗地主/炸弹猫/骗子酒馆/抢21/国战 Web 版）。
 *
 * 与 guozhan 主服务互不影响：guozhan 默认 8788，本服务默认 8766。
 * 零依赖，直接从 board-games/ 运行；不需要 Android 工程或 npm install。
 *
 * 环境变量：
 *   BOARD_GAMES_PORT          默认 8766
 *   BOARD_GAMES_HOST          默认 0.0.0.0（局域网可访问；公网请走反代）
 *   BOARD_GAMES_DEFAULT_GAME  uno | doudizhu | exploding | liarsbar | grab21 | guozhan
 *   LLM_API_KEY / LLM_BASE_URL(或 LLM_API_BASE) / LLM_MODEL  可选服务端 LLM 玩家位
 */
import { createRoom } from '../board-games/server/room.mjs';

// 与 scripts/start.sh 一致：存在 .env 时加载（Node 24 内置；旧 Node 忽略）
try { process.loadEnvFile?.('.env'); } catch { /* 无 .env 或旧版 Node */ }

const port = Number(process.env.BOARD_GAMES_PORT || '8766');
const host = process.env.BOARD_GAMES_HOST || '0.0.0.0';
const game = process.env.BOARD_GAMES_DEFAULT_GAME || 'uno';

const room = await createRoom({ game, port, host });
console.log(`Board games room '${game}' ready.`);
console.log(`  Web   : ${room.url}/`);
console.log(`  WS    : ${room.wsUrl}`);
console.log(room.llm ? `  LLM   : ${room.llm.model} (server-side seat available)` : '  LLM   : disabled');
console.log('  Ctrl+C to stop.');
