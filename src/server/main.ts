/**
 * 服务入口 —— 组装：读 env → 装载剧本 → 建 RoomManager → 挂 HTTP/WS/MCP → 优雅退出。
 *
 * ★RoomManager 的具体实现（src/server/room/manager.ts）由存储/房间线并行开发，
 *   本文件只依赖 room/types.ts 的接口契约，按约定的导出名做运行时解析：
 *     createRoomManager(opts) | RoomManagerImpl 类 | default 导出
 *   三者都没有 → fail-closed，启动即报错（不静默降级）。
 *
 * 优雅退出（SIGINT/SIGTERM）：
 *   停止接受新连接 → 关 WS/MCP 会话 → roomManager.shutdown()（flush WAL）→ 退出。
 *   10 秒内没走完 → 强制退出码 1（宁可让 orchestrator 重启，不吊死）。
 */
import { createServer } from 'node:http';
import { discoverScenarios, loadScenario, type ScenarioMeta } from './config-loader.ts';
import type { RoomManager } from './room/types.ts';
import { authConfigFromEnv, createAuth, MIN_TOKEN_LENGTH } from './adapters/auth.ts';
import { createHttpHandler } from './adapters/http.ts';
import { attachWebSocket } from './adapters/ws.ts';
import { createMcpAdapter } from './adapters/mcp.ts';
import { UserService } from './users/service.ts';

const env = process.env as Readonly<Record<string, string | undefined>>;
const HOST = env.HOST ?? '127.0.0.1';
const PORT = Number(env.PORT ?? '8788');
const CONFIG_ROOT = env.GUOZHAN_CONFIG_ROOT ?? 'config';
// DATA_DIR 是历史别名（compose / start.sh 一直用它），两个都认，避免"设了却被忽略"
const DATA_DIR = env.GUOZHAN_DATA_DIR ?? env.DATA_DIR ?? 'data';

function fail(message: string): never {
  process.stderr.write(`guozhan: 启动失败 —— ${message}\n`);
  process.exit(1);
}

// ── 剧本装载（目录扫描发现，非白名单；装载失败 fail-closed）──
const scenarioIds = discoverScenarios(CONFIG_ROOT);
if (scenarioIds.length === 0) {
  fail(`${CONFIG_ROOT}/scenarios/ 下没有发现任何剧本目录`);
}
const scenarioMetas: ScenarioMeta[] = [];
for (const id of scenarioIds) {
  try {
    scenarioMetas.push(loadScenario(id, undefined, CONFIG_ROOT).meta);
  } catch (err) {
    fail(`剧本 ${id} 装载失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── RoomManager（接口契约见 room/types.ts；实现导出名运行时解析）──
interface RoomManagerOptions {
  readonly dataDir: string;
  readonly configRoot: string;
  readonly scenarioIds: readonly string[];
}

async function buildRoomManager(opts: RoomManagerOptions): Promise<RoomManager> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('./room/manager.ts')) as Record<string, unknown>;
  } catch (err) {
    fail(`无法加载 src/server/room/manager.ts（房间线交付物）：${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof mod.createRoomManager === 'function') {
    return (await (mod.createRoomManager as (o: RoomManagerOptions) => RoomManager | Promise<RoomManager>)(opts));
  }
  if (typeof mod.RoomManagerImpl === 'function') {
    return new (mod.RoomManagerImpl as new (o: RoomManagerOptions) => RoomManager)(opts);
  }
  if (typeof mod.default === 'function') {
    const D = mod.default as unknown;
    return (D as { prototype?: unknown }).prototype instanceof Object
      ? new (D as new (o: RoomManagerOptions) => RoomManager)(opts)
      : (await (D as (o: RoomManagerOptions) => RoomManager | Promise<RoomManager>)(opts));
  }
  fail('src/server/room/manager.ts 必须导出 createRoomManager(opts) / RoomManagerImpl 类 / default 之一');
}

const roomManager = await buildRoomManager({ dataDir: DATA_DIR, configRoot: CONFIG_ROOT, scenarioIds });
const userService = new UserService({ dataDir: DATA_DIR });

// ── 鉴权 ──
const authConfig = authConfigFromEnv(env);
const auth = createAuth(authConfig, roomManager);
if (auth.tokenGenerated) {
  // 未配置 GUOZHAN_TOKEN：生成一次性令牌打到 stderr（只此一次，不落盘）
  process.stderr.write(
    `guozhan: 未配置 GUOZHAN_TOKEN，已生成本次启动专用的管理令牌（≥${MIN_TOKEN_LENGTH} 字符要求由生成器保证）：\n` +
      `  GUOZHAN_TOKEN=${auth.adminToken}\n` +
      `  （进程退出即失效；正式部署请在 env/compose 中显式配置）\n`,
  );
}
if (auth.origins.length === 0) {
  process.stderr.write('guozhan: 警告 —— GUOZHAN_ORIGINS 为空，一切带 Origin 头的浏览器请求将被 403 拒绝（fail-closed）\n');
}

// ── 适配器装配 ──
const mcp = createMcpAdapter({ auth, roomManager });
const handler = createHttpHandler({ auth, roomManager, userService, listScenarios: () => scenarioMetas, mcp });
const server = createServer(handler);
const ws = attachWebSocket(server, { auth, roomManager });

server.listen(PORT, HOST, () => {
  process.stderr.write(`guozhan: 监听 http://${HOST}:${PORT}（剧本：${scenarioIds.join(', ')}）\n`);
});

// ── 优雅退出 ──
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`guozhan: 收到 ${signal}，开始优雅退出…\n`);
  const forceTimer = setTimeout(() => {
    process.stderr.write('guozhan: 优雅退出超时（10s），强制退出\n');
    process.exit(1);
  }, 10_000);
  try {
    await new Promise<void>((resolve) => server.close(() => resolve())); // 停止新连接
    await ws.close(); // 关 WS 客户端
    await mcp.closeAll(); // 关 MCP 会话与推送流
    userService.close();
    await roomManager.shutdown(); // flush WAL、关房间库
    clearTimeout(forceTimer);
    process.stderr.write('guozhan: 已退出（WAL 已 flush）\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`guozhan: 退出过程出错 —— ${err instanceof Error ? err.message : String(err)}\n`);
    clearTimeout(forceTimer);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
