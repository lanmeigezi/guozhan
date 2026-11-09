import { defineConfig } from 'tsup';

/**
 * 只打两个入口：服务与健康探针。
 *
 * 第三方依赖保持 external（镜像里 npm ci --omit=dev 装的是同一份版本），
 * 只有本项目源码被内联 —— 这样 dist 里不会出现两份 zod 实例。
 *
 * ★`removeNodeProtocol: false` 不能省。
 *   tsup 默认（removeNodeProtocol=true）会把 `node:` 前缀剥掉，于是 `node:sqlite`
 *   变成第三方包 `sqlite`，运行时直接 ERR_MODULE_NOT_FOUND。
 *   （实测：裸 esbuild 不会这么干，是 tsup 的默认值干的。）
 */
export default defineConfig({
  entry: {
    main: 'src/server/main.ts',
    healthcheck: 'src/healthcheck.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  removeNodeProtocol: false,
  outDir: 'dist',
  clean: true,
  bundle: true,
  splitting: false,
  sourcemap: true,
  external: ['ws', 'zod', '@modelcontextprotocol/sdk'],
  esbuildOptions(options) {
    // 源码里按 Node 原生 TS 支持的写法带 .ts 扩展名导入
    options.resolveExtensions = ['.ts', '.mjs', '.js', '.json'];
  },
});
