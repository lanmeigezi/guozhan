/** 启动入口：node src/server/main.js [--port 8790] */
import { createServer } from 'node:http';
import { loadConfig } from './loader.js';
import { createApp } from './app.js';

function arg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = loadConfig();
const port = Number(process.env.CIV_PORT || arg('--port', '8790'));
const host = process.env.CIV_HOST || arg('--host', '127.0.0.1');
const token = process.env.CIV_TOKEN || '';
const origins = (process.env.CIV_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const app = createApp(config, { token, origins });
const defaultRoom = app.makeRoom('room-1', config.world.seed, false, []); // 默认房间：全 AI 席位，随时可开

const server = createServer((req, res) => {
    app.handler(req, res).catch((err) => {
        console.error('[civ] 请求处理失败：', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'INTERNAL', message: String(err?.message ?? err) }));
        }
    });
});

server.listen(port, host, () => {
    console.log(`[civ] 群星君主服务已启动： http://${host}:${port}/`);
    console.log(`[civ] 规则集 ${config.rules.id}｜推演强度 ${config.rules.simulation.strength}｜DM 权重 ${config.rules.dm.weight}`);
    console.log(`[civ] 默认房间 room-1：12 席默认全人机托管，无需凑人即可开局；鉴权 ${token ? '已启用 Bearer' : '未启用（仅本机/可信内网使用）'}`);
    console.log(`[civ] 房间管理令牌（仅房主可见，勿转发给模型）：${defaultRoom.adminToken}`);
    console.log(`[civ] 席位盲化已开启：任何模型都无法得知各国由人类还是人机控制；/seats 与 /models 仅房主可见`);
    console.log(`[civ] MCP 桥接：另开一个终端执行 npm run mcp（连接 CIV_API_BASE=http://${host}:${port}）`);
});

server.on('error', (err) => {
    console.error('[civ] 监听失败：', err.message);
    process.exitCode = 1;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { app.close(); server.close(() => process.exit(0)); });
}
