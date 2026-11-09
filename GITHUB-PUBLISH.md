# 发布到 GitHub 指南

本仓库已配置好可发布的 git 结构。本文说明初始化、日常提交与发版流程。

## 1. 首次初始化（如尚未 init）

```bash
cd <仓库根目录>
git init
git config core.quotepath false   # 中文路径正常显示
git config core.longpaths true    # Windows 长路径
git branch -M main
git add -A                        # .gitignore 已屏蔽产物/密钥/大文件
git commit -m "chore: initial commit (guozhan 0.9.9 + civ-monarchs 0.4.0 android)"
git remote add origin <你的仓库 URL>
git push -u origin main
```

> 本仓库采用**白名单式**提交：`.gitignore` 已明确排除 `release/`、`apk/`、`node_modules/`、`dist/`、`data/`、
> `tools/bin/`（55MB+ 的 cloudflared 等二进制）、临时目录、以及三个巨型任务转储 `.md`。**请勿** `git add` 这些目录。

## 2. 绝不进版本库的内容

| 类别 | 路径 | 说明 |
|------|------|------|
| 构建产物 | `release/`、`apk/`、`dist/` | 走 GitHub Releases 附件，不进 git |
| 运行时数据 | `data/`、`*.db`、`*.log` | 房间库 / 备份 / 日志 |
| 密钥 | `.env`（仅 `.env.example` 可提交） | 真实密钥永不入库 |
| 工具二进制 | `tools/bin/` | cloudflared 等，单独分发 |
| 临时产物 | `.verify-stage/`、`.preview/`、`.ui-data*/`、`.qoder-credits/` | 会话残留 |
| 巨型转储 | 三个 `*.md`（24/27/16MB） | 非源码，本地另存 |

## 3. 本地校验（提交前建议跑）

```bash
npm ci
npm run verify          # arch-check + typecheck + validate-config + test
node civ-monarchs/android/verify.mjs   # 群星君主确定性引擎 + 座位盲化
```

## 4. 发版（产出 GitHub Release 附件）

```bash
PACK_STAMP=YYYYMMDD node scripts/pack-release.mjs   # 生成 zip/tar.gz/vendor + SHA256SUMS
node scripts/verify-release.mjs                      # 校验包内无密钥/数据/日志、无过期 bundle
```

把 `release/guozhan-<ver>-<stamp>.zip`、`*.tar.gz`、vendor 包与 `SHA256SUMS-<ver>.txt`
作为 GitHub Release 附件上传。

## 5. Android APK（群星君主离线单机版）

```bash
node civ-monarchs/android/build-bundle.mjs   # 生成 board-games/.../www/civ-core.bundle.js
node civ-monarchs/android/build-apk.mjs      # Gradle 打包 + apksigner 校验 + 写 SHA256SUMS
```

APK 签名需本机 Android SDK（`build-tools 34.0.0`）+ JDK 17。CI 只验证「bundle 可生成 + 核心引擎可跑」，
不跑完整 Gradle assemble（需 SDK 许可，过重）。

## 6. 密钥扫描

提交前自动/手动确认仓库内不含真实 API Key / Token / `.env` 真值。`.env.example` 与代码中的
`apiKey` 字段名（座位盲化逻辑）均为安全样例，可正常提交。
