/**
 * Dockerfile HEALTHCHECK 探针：打 /health，200 → 退出码 0，其余 → 退出码 1。
 *
 * 用法（Dockerfile）：HEALTHCHECK --interval=30s --timeout=3s CMD node dist/healthcheck.js
 * 裸跑：node --experimental-strip-types src/healthcheck.ts
 *
 * HOST=0.0.0.0 是 bind 地址不是可连地址，探针一律连 127.0.0.1。
 */
const port = process.env.PORT ?? '8788';
const url = `http://127.0.0.1:${port}/health`;

try {
  const resp = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!resp.ok) {
    process.stderr.write(`healthcheck: HTTP ${resp.status} from ${url}\n`);
    process.exit(1);
  }
  const body = (await resp.json().catch(() => null)) as { status?: unknown } | null;
  if (body === null || body.status !== 'ok') {
    process.stderr.write(`healthcheck: 响应形状异常：${JSON.stringify(body)}\n`);
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`healthcheck: 无法连接 ${url} —— ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
