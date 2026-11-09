/**
 * MCP stdio ⇄ 远端 /mcp 透明转发垫片。
 *
 * 用途：Claude Desktop / ChatGPT Secure MCP Tunnel 只会说 stdio MCP，
 * 本垫片让它们复用同一个远端服务端（Streamable HTTP，有状态 session）。
 *
 *   stdin(JSON-RPC 行) → POST {GUOZHAN_MCP_URL}（带 mcp-session-id / Authorization）
 *   响应 JSON 或 SSE data: 行 → stdout（逐行 JSON-RPC）
 *   initialize 完成后另开 GET SSE 长流，把服务端主动推送原样转发到 stdout
 *
 * 环境变量：
 *   GUOZHAN_MCP_URL    远端 /mcp 地址（默认 http://127.0.0.1:8788/mcp）
 *   GUOZHAN_MCP_TOKEN  席位令牌（必填 —— actor 身份只从令牌来）
 *
 * 运行：node --experimental-strip-types src/server/adapters/mcp-stdio-proxy.ts
 */
import { createInterface } from 'node:readline';

const URL_MCP = process.env.GUOZHAN_MCP_URL ?? 'http://127.0.0.1:8788/mcp';
const TOKEN = process.env.GUOZHAN_MCP_TOKEN ?? '';
if (TOKEN.length === 0) {
  process.stderr.write('mcp-stdio-proxy: 必须设置 GUOZHAN_MCP_TOKEN（席位令牌）\n');
  process.exit(1);
}

let sessionId: string | null = null;

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId !== null) h['mcp-session-id'] = sessionId;
  return h;
}

/** SSE/JSON 响应 → stdout 逐行 JSON-RPC */
async function emitResponse(resp: Response): Promise<void> {
  const sid = resp.headers.get('mcp-session-id');
  if (sid !== null) sessionId = sid;
  const ctype = resp.headers.get('content-type') ?? '';
  const text = await resp.text();
  if (text.length === 0) return;
  if (ctype.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data.length > 0) process.stdout.write(`${data}\n`);
      }
    }
  } else {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
}

/** initialize 完成后开 GET SSE 长流：服务端主动推送 → stdout（有状态 session 的意义所在） */
async function openNotificationStream(): Promise<void> {
  try {
    const resp = await fetch(URL_MCP, { method: 'GET', headers: headers() });
    if (!resp.ok || resp.body === null) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data.length > 0) process.stdout.write(`${data}\n`);
        }
      }
    }
  } catch {
    /* 远端断开：客户端会自行重连或退出 */
  }
}

let notifyStreamStarted = false;

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg: { method?: string } | null = null;
  try {
    msg = JSON.parse(trimmed) as { method?: string };
  } catch {
    writeLine({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    return;
  }
  void (async () => {
    try {
      const resp = await fetch(URL_MCP, { method: 'POST', headers: headers(), body: trimmed });
      await emitResponse(resp);
      if (msg?.method === 'notifications/initialized' && !notifyStreamStarted && sessionId !== null) {
        notifyStreamStarted = true;
        void openNotificationStream();
      }
    } catch (err) {
      writeLine({
        jsonrpc: '2.0',
        error: { code: -32000, message: `proxy transport error: ${err instanceof Error ? err.message : String(err)}` },
        id: (msg as { id?: unknown } | null)?.id ?? null,
      });
    }
  })();
});
rl.on('close', () => {
  if (sessionId !== null) {
    void fetch(URL_MCP, { method: 'DELETE', headers: headers() }).catch(() => undefined).finally(() => process.exit(0));
  } else {
    process.exit(0);
  }
});
