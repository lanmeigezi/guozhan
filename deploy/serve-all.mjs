#!/usr/bin/env node
/**
 * 远程对局的同源入口：一个端口同时提供
 *   · web/ 静态页（国战沙盘客户端）
 *   · extensions/sillytavern-guozhan/lib/（客户端 import 的传输层）
 *   · /api/* 反向代理到国战服务
 *   · /ws WebSocket 升级转发到国战服务
 *
 * 这样朋友只需要打开一个 https 地址：页面、API、事件流同源，不触发 CORS，
 * 也不需要他们手动改「服务器地址」。
 *
 * 用法：node deploy/serve-all.mjs
 *   PROXY_PORT  默认 8789（对外）
 *   API_PORT    默认 8788（本机国战服务）
 *   API_HOST    默认 127.0.0.1
 */
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = resolve('.');
const PORT = Number(process.env.PROXY_PORT ?? '8789');
const HOST = process.env.PROXY_HOST ?? '0.0.0.0';
const API_HOST = process.env.API_HOST ?? '127.0.0.1';
const API_PORT = Number(process.env.API_PORT ?? '8788');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 只放行这两个目录，避免把仓库里的 data/、config/、源码暴露出去
const STATIC_PREFIXES = ['web/', 'extensions/sillytavern-guozhan/lib/'];

function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const rel = normalize(clean).replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.split('/').includes('..')) return null;
  if (!STATIC_PREFIXES.some((p) => rel.startsWith(p))) return null;
  const abs = resolve(join(ROOT, rel));
  if (!abs.startsWith(ROOT + sep)) return null;
  return abs;
}

function proxyHttp(req, res) {
  const upstream = request(
    { host: API_HOST, port: API_PORT, method: req.method, path: req.url, headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('国战服务未启动');
  });
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  if (path === '/api' || path.startsWith('/api/')) return proxyHttp(req, res);

  // 页面里的资源是相对路径（./app.js），必须让浏览器地址栏停在 /web/ 下，
  // 否则 / 会把它解析成 /app.js → 404，整页脚本都不执行。
  if (path === '/' || path === '/web') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }

  let filePath = path === '/' ? '/web/' : path;
  if (filePath.endsWith('/')) filePath += 'index.html';
  const abs = resolveSafe(filePath);
  if (abs === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(abs);
    const type = MIME[extname(abs)] ?? 'application/octet-stream';
    // 文本资源压缩后再发（远程链路常只有几百 KB/s）
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const compressible = /^(text\/|application\/(json|javascript))/.test(type);
    const payload = acceptsGzip && compressible ? gzipSync(body) : body;
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': payload.length,
    };
    if (payload !== body) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : payload);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/ws') {
    socket.destroy();
    return;
  }
  const up = connect(API_PORT, API_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += '\r\n';
    up.write(raw);
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`serve-all: http://${HOST}:${PORT}/  → 静态 web/ + /api + /ws → ${API_HOST}:${API_PORT}\n`);
});
