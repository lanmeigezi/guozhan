# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# guozhan —— AI 辅助国战模拟后端（照架构文档 §7.1，极简形态）
#
# 构建前提：先在宿主机执行 `npm ci && npm run build` 产出 dist/
# （镜像内不装 devDependencies、不编译 TS，也不编译任何原生扩展 ——
#   存储用 Node 内置 node:sqlite，无 better-sqlite3 那种 node-gyp 依赖。
#   注意基础镜像必须是 Node 24+：node:sqlite 在 22.5–23.3 还要实验标志。
#
# ★两个构建参数是为了国内服务器能构建（默认值不变，海外/直连无需理会）：
#   podman/docker build \
#     --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
# ─────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
WORKDIR /app

ARG NPM_REGISTRY=
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} \
 && npm cache clean --force

COPY dist/ ./dist/
COPY config/ ./config/
# 桌游合集（零依赖，独立进程；compose 的 board-games 服务复用本镜像）
COPY board-games/ ./board-games/

# ★数据目录必须**先建好并归 node 所有**：
#   实测（podman 4.9 / node:24-alpine）不建的话，USER node 启动时 mkdir /app/data/rooms 直接 EACCES 退出。
#   VOLUME 让 docker 首次创建命名卷时继承这个目录的属主；bind mount 时仍以宿主机目录属主为准。
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788

# ★非 root 运行：容器被攻破时攻击者拿到的只是 node 用户
USER node

EXPOSE 8788
EXPOSE 8766
HEALTHCHECK --interval=30s --timeout=3s CMD node dist/healthcheck.js

CMD ["node", "--enable-source-maps", "dist/main.js"]
