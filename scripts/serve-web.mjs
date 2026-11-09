#!/usr/bin/env node
/**
 * 网页参考客户端的静态服务器（开发/演示用，不要用于生产公网）。
 *
 * 只做三件事：给 web/ 与酒馆扩展的 lib/ 提供文件、拒绝路径穿越、设正确的 MIME。
 * 生产环境应当由 caddy/nginx 托管这两个目录（它们与后端同机）。
 *
 * 跑法：node scripts/serve-web.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve('.');
const PORT = Number(process.argv[2] ?? process.env.WEB_PORT ?? '8080');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 只放行这两个目录：页面与协议副本 */
const ALLOWED_PREFIXES = ['web/', 'extensions/sillytavern-guozhan/lib/'];

function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  // path.normalize 在 Windows 上会产出反斜杠，先统一回 URL 分隔符再判白名单
  const rel = normalize(clean).replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.split('/').includes('..')) return null;
  if (!ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) return null;
  const abs = resolve(join(ROOT, rel));
  if (!abs.startsWith(ROOT + sep)) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  let path = url.split('?')[0] ?? '/';
  if (path === '/' || path === '') path = '/web/';
  if (path.endsWith('/')) path += 'index.html';

  const abs = resolveSafe(path);
  if (abs === null) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[extname(abs)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`not found: ${path}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`web: http://127.0.0.1:${PORT}/web/  （仅 web/ 与扩展 lib/，供本地演示）\n`);
});
