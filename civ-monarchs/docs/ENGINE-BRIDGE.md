# 接入官方 civ-atlas 引擎的桥接说明

> 状态：**接口级设计文档，不是已实现的适配器**。本包自带轻量引擎可独立完整运行；只有当你需要官方引擎的球面地图、王朝世系、编年史与旗舰渲染时，才需要按本文替换。
> 本包不包含 civ-atlas 任何源码；官方项目为 **AGPL-3.0**，接入并分发时请遵守其许可证。

## 1. 两边的分层是同构的

| 概念 | 官方 civ-atlas | 本包 |
|---|---|---|
| 引擎层（只管按年往下算） | `src/gen/civ/engine/sim.ts`、`timeline.ts`、`rand.ts` | `src/core/engine.js`（`advanceTurn`） |
| 规则层（可调、可换） | `src/gen/civ/ruleSet.ts`、`ruleSetEdit.ts`、`engine/knobs.ts`（`KnobPatch`） | `config/rules.json` |
| 地图与世界数据 | `src/gen/world.ts`、`worldFile.ts`（种子 + 参数 + 修改） | `src/core/world.js` + `config/world.json` |
| 干预（DM 下命令） | `src/gen/civ/interventions.ts`、干预列表 + `resumeCiv(world, civ, 干预列表)` | `POST /api/rooms/{id}/dm` → `state.dmEdits` |
| 编年史 | `src/gen/civ/story/chronicle.ts`（`Annal` / `AnnalKind`） | `state.chronicle` / `GET /chronicle` |
| 子系统具名接口 | `CivSim.api`（`src/gen/civ/api.ts` 的 `declare/makePeace/onFall/levy/power/...`） | 本包无此层（体量小，直接函数调用） |
| AI 接入 | 内置 `src/ai/agent/loop.ts` + `assistant.ts`（工具循环） | `src/ai/adapter.js` + `src/mcp/server.js`（外部 Harness） |
| 席位控制（人类 / 人机） | 无（单人世界观创作工具） | `config/seats.json` + `src/core/seats.js`，**房间层**，不进权威 state；结算前自动补位保证十二国行为一致 |

官方 1.4.0 起规则与引擎剥离、1.5.0 起可自定义规则并排试推，这正是「降低推演强度」能落地的原因。

## 2. 干预类型映射（命名直接对齐，便于平移）

以下类型名取自官方 `interventions.ts` 文件头注释，是本包 `rules.dm.allowed` 的命名来源：

| 官方 Intervention | 本包 DM edit | 迁移备注 |
|---|---|---|
| `protect` 不许灭 | `protect` | 本包实现为 `civ.shield = 1`，本回合免于灭亡；官方是跳过国都所在州 |
| `ally` 结盟 / `declare` 宣战 | `ally` / `declare` | 本包改 `relations` 分数；官方会立刻议和/强制开战 |
| `unity` 禁止分裂 / `keep` 保住王室 | `unity` / `keep` | 本包折算为民心与护国状态 |
| `cede` 划州 / `found` 立国 | `cede` / `found` | 本包改州归属 / 划一州给目标国 |
| `halt` 不许扩张 | `halt` | 本包 `expansionLock = 1` |
| `policy` 定方针 | `policy` | 本包从 4 种方针里确定性抽取 |
| `treaty` 立约 / `neutral` 划中立地 | `treaty` | 中立地本包未实现，退化为关系修正 |
| `disaster` 天灾 | `disaster` | 本包按州扣人口与民心 |
| `boost` 推一把发展 | `boost` | 本包直接加科技/发展度；官方是乘发展度增速 |
| `destroy` 灭国 | `destroy` | 本包仅 magnitude=3 且无护国时生效 |
| `unrest` 民变（本包自定义） | `unrest` | 官方对应民变/动荡机制，非独立干预类型 |
| `crown` / `temper` / `appoint` / `move` / `death` / `look` | 未映射 | 需要王朝/人物层时才加；本包无人物系统 |

**带权重语义**：官方干预是「带着干预列表从第 0 年整段重推，干预年份之前逐位一致」。本包的 `dm.weight` 是幅度系数而非历史重写；若要完全复刻官方语义，需要把 `advanceTurn` 换成「存档快照 + 干预列表 → 重推到指定年份」。

## 3. 替换步骤

1. **替换世界数据**：把 `src/core/world.js` 的 `generateWorld()` 改为从官方 `worldFile` 读入州/城/邻接，产出本包 `regions[{id,x,y,name,terrain,yields,owner,...}]` 形状。只要保持 `state.regions` / `state.adjacency` 结构，上层 API、扩展、MCP 全部不用改。
2. **替换推演**：把 `src/core/engine.js` 的 `simulate()` 换成官方 `resumeCiv(world, civ, interventions)` 的逐年结果，再把结果投影回 `civs` 与 `regions`。`applyDecisions` / `applyDmEdits` / `updateEpochs` / `checkVictory` 保留（它们属于规则层）。
3. **旋钮落地**：把 `simulation.strength` 编成官方 `KnobPatch`（表 id → 项名 → 值），例如开战赔率、冷却年数、发展度增速等表项按 `strength` 缩放；`dm.weight` 仍由本包干预层控制幅度。官方 `KnobSet.get(表)` 的用法见 `engine/knobs.ts`。
4. **编年史对接**：把官方 `Annal` 转成 `{turn, year, kind, text}` 写入 `state.chronicle`；`GET /chronicle` 与酒馆注入逻辑不用改。
5. **MCP / Harness 保持不变**：`src/mcp/server.js` 只依赖本包 REST 契约，替换引擎后工具列表无需变化。若官方日后提供创意工坊插件与 HTTP API，也可把 `callTool()` 里的 `api()` 直接指向官方端点。
6. **许可**：接入官方代码后整体需按 AGPL-3.0 提供相应源码/网络使用条款；仅通过 HTTP 调用且不含其代码时不受影响。

## 4. 为什么本包不直接内置官方引擎

- 官方是浏览器端 Vite/React/WebGL2 项目，含 2,360 个文件与大量肖像/字体素材，默认 3.6 万地块，和「发给合作酒馆服务器、解压即跑」的分发目标冲突。
- 官方没有后端服务与原生 MCP，正是视频简介要求改造的部分；本包把这部分补齐，且把规则层做成可替换的。
- 本包的价值是**零依赖、可离线、可复现、可测试**的最小权威核心，可作为官方引擎的 Harness 外壳，而不是替代品。
