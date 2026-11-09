# 案例调研 05：OpenArma 与 OpenRA-RL —— 异步 LLM 架构与工具调用范式

> 调研日期：2026-10（基于两仓库 main 分支浅克隆 + HF 官方博客原文核实）
> 仓库：
> - `chenhaha99/OpenArma`（27 star，Python/Next.js，pushed 2026-05-06）
> - `yxc20089/OpenRA-RL`（160 star，Python + C# submodule，pushed 2026-05-16）
> 定位：**仅作参考，提炼范式；本项目（1-2 核 / 2-4GB、无 Redis、SQLite WAL）绝不复用其重型架构。**

---

## 第一部分：OpenArma（AI 军事指挥官 @ Arma Reforger）

### 1.1 总体形态：不是 MCP，是「HTTP 心跳 + 命令池」的插件桥

OpenArma 本体是一个通用多智能体平台（README 自述"底层是一个通用的多智能体平台——军事指挥只是第一个应用场景"），后端基于 **fastapi_best_architecture（fba）模板**，技术栈极重：

README（`README.md` L166-181）原文：

```
│  PostgreSQL · Redis · RabbitMQ · Qdrant · MinIO           │
│  Grafana · Prometheus · Tempo · Loki                      │
...
| 后端 | FastAPI (fba) · SQLAlchemy 2 · Pydantic v2 · Celery · Alembic |
| AI 引擎 | LangGraph · LiteLLM · Qdrant |
```

**LLM 与游戏的中间层 = 三个 Arma Reforger Mod（Enfusion C 脚本）+ 一个 HTTP "Open API"**：

| Mod 仓库 | 作用 | 证据 |
|---|---|---|
| `OpenArma-Mod-Main` | 游戏内运行时：采集态势 → REST 心跳上报 → 领取并执行命令 | `Scripts/Game/OA/OA_DecisionBridge.c`、`OA_WorldObserver.c`、`OA_CommandExecutor.c` |
| `OpenArma-Mod-MapExporter` | Workbench 编辑器插件，离线批量导出地图数据（实体/高度/水体/道路/地标） | 其 README："导出的 JSON 数据可直接导入 OpenArma 后端，为 AI 指挥官提供地形感知能力" |
| `OpenArma-Mod-MapScanner` | 游戏内运行时扫描道路/地标 | 文件树：`OAMapScanner_Roads.c`、`OAMapScanner_Landmarks.c` |

桥接方式（`OA_DecisionBridge.c` 头注释，原文）：

```c
// OA_DecisionBridge.c — REST API bridge: sends situation reports to OpenArma backend,
// receives pending orders + config via single POST /open/command endpoint.
// Uses async POST to avoid blocking the game thread.
// API Key passed via query parameter (Enfusion has no custom header support).
```

即：**单一 HTTP 端点 `POST /api/v1/open/command`，请求 = 态势报告，响应 = 待执行命令 + 配置**（请求-响应合一，游戏侧无长连接）。Mod 侧用异步 POST 不阻塞游戏线程，且 `m_bRequestPending` 标志保证同一时刻只有一个在途请求（天然串行化）。`OA_Main.c` 注释："Config (running, factions, interval) comes from the backend response each heartbeat"——**决策间隔由后端每次心跳下发**，Web 面板可改。

> 注：Mod-Main 里还有一套 `Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_*.c`（GetState/CreateEntity/Terrain 等约 20 个文件），那是给 **Workbench 编辑器**用的 MCP 工具（地图搭建自动化），不是给战场指挥 LLM 用的，别混淆。

### 1.2 工具调用范式：两层工具，粒度都是「战术意图级」

#### A. 输出侧：LLM 不用 tool call 下命令，而是直接输出 JSON orders

命令下达**不走 function calling**，而是系统提示词强制 JSON 输出（`backend/app/task/tasks/open/tasks.py` L20-25，原文摘录）：

```
'2. Your final response MUST be valid JSON with this structure:\n'
'{"orders": [{"type": "move"|"force_move"|"defend"|"attack"|"patrol"|"hold"|"retreat"|"route",'
' "group_id": "<id>", "target": [x, y, z], ...}],'
' "briefing": "<short summary>",'
' "assessment": "<threat assessment>",'
' "priority_targets": ["<target description>"]}\n'
```

10 种命令类型（`backend/app/conversation/engine/builtin_tools/arma_tools.py` L117-123）：

```python
_VALID_ORDER_TYPES = frozenset({
    'move', 'attack', 'retreat', 'force_move', 'defend', 'patrol',
    'route', 'set_combat_mode', 'set_speed', 'hold',
})
_VALID_COMBAT_MODES = frozenset({'fire_at_will', 'hold_fire', 'defend_only', 'stealth'})
_VALID_SPEEDS = frozenset({'walk', 'jog', 'sprint'})
_VALID_FORMATIONS = frozenset({'Line', 'Column', 'StaggeredColumn', 'Wedge', 'Vee'})
```

粒度是**小队级战术意图**（"X 小队巡逻这些路点"），不是单兵原子操作；单兵层面的走位/交战完全交给 Arma 引擎自带 AI（`OA_CommandExecutor.c` 把 order 翻译成引擎的 `AIWaypoint_Move.et` 等 Waypoint 实体）。这就是"**LLM 出计划、底层执行器跑细节**"的分层。

#### B. 输入侧：态势感知工具用 function calling，"不喂全量、按需查询"

README（L69-77）核心设计原话：

> **不是把所有信息都告诉 AI，而是给它工具，让它自己决定需要什么。** ……就像真正的指挥官一样：你不会一开始就阅读所有情报，而是根据需要去调取。

内置工具注册于 `builtin_registry`（`backend/app/conversation/engine/builtin_tools/registry.py`），实打实的工具定义如下。

**战术计算类**（`arma_tools.py`，5 个）：`calculate_distance`、`assess_threats`、`validate_orders`、`get_squad_summary`、`generate_patrol_route`。真实定义摘录（L10-38）：

```python
@builtin_registry.register(
    'calculate_distance',
    display_name='距离计算',
    description=(
        'Calculate the distance between two 3D positions on the battlefield. '
        'Returns 3D distance, horizontal distance (ignoring height), and height difference in meters. ...'
    ),
    input_schema={
        'type': 'object',
        'properties': {
            'pos_a': {'type': 'array', 'items': {'type': 'number'},
                      'minItems': 3, 'maxItems': 3,
                      'description': 'First position [x, y, z]'},
            'pos_b': {...},
        },
        'required': ['pos_a', 'pos_b'],
    },
)
```

**地图情报类**（`backend/app/open/service/map_tools.py`，1200 行，16 个）：`query_landmarks`（查询地标）、`calculate_route`（路线计算）、`get_terrain_profile`（地形剖面）、`get_area_intel`（区域情报）、`get_mission_status`、`estimate_travel_time`（行军时间估算）、`send_message_to_human`（发消息给人类指挥官）、`assess_threat_level`、`view_map_image`、`request_recon`（请求侦察）、`convert_coordinates`（六位军用坐标转换）、`plan_route`（智能路径规划）、`get_terrain_summary`、`query_terrain_cells`（自然语言地形检索）、`get_hex_neighbors`。

`query_terrain_cells` 是最有意思的一个——支持自然语言查地形（L1080-1110 摘录）：

```python
description=(
    'Search terrain cells by location and/or natural language query. '
    'Uses H3 hexagonal grid pre-computed terrain features with semantic search. '
    'Examples: "good cover for ambush", "flat open ground for vehicles", '
    '"high ground with observation". ...'
),
```

背后是 `hex_terrain.semantic_search_cells`（描述文本已预先向量化入 pgvector）。

**工具数量控制**：两层合计约 21 个内置工具 + 可选 MCP 外接；工具调用循环有硬上限 `MAX_TOOL_ROUNDS = 10`（`backend/app/conversation/engine/graph.py` L17）。README L54 还记录了一条经验教训（原话）：

> AI 在遭遇敌人时，总是优先调用火炮进行打击——就像那位英国教授的论文里说的，21 场模拟战争中有 20 场 AI 都使用了核弹。AI 把这些武器视为效率极高的工具……所以我们可以通过规则限制 AI 的武器使用权。

即：**工具/能力越强，越要在提示词里加使用约束**，否则 LLM 会滥用"高效"手段。

### 1.3 异步架构：状态机 + Redis 队列 + Celery 任务，与游戏完全解耦

完整链路（全部有代码实证）：

```
Arma Mod ──POST /open/command（心跳，态势报告）──▶ FastAPI (backend/app/open/api/v1/command.py)
  ①存 BattleSnapshot（全量快照入库）
  ②fog_of_war.filter_for_faction：按阵营裁剪战争迷雾视图
  ③battle_state.evaluate：纯规则状态机 peaceful→engaged→critical，决定 priority
  ④message_queue：Redis 锁 + 队列（AI 忙则入队，critical 插队头）
  ⑤Celery: process_situation_task.delay(...)   ← 立即返回 HTTP 响应（含上一次的 pending_orders）
Mod ◀──响应体带 pending_orders（命令池 command_pool 中未送达的命令）──┘

Celery worker（异步，秒级）：
  出队合并(dequeue_all + merge_situations) → format_situation_report（压成文本）
  → LangGraph 单智能体图（工具循环 ≤10 轮）→ extract_orders_from_response
  → 过滤幻觉 group_id → 写入 command_pool → 等 Mod 下次心跳来取
```

关键设计与原文证据：

**(a) 战斗状态机不经过 LLM**（`backend/app/open/service/battle_state.py` L1-5 docstring 原文）：

```python
"""战场状态机：peaceful → engaged → critical.
基于后端规则判定（零延迟），不经过 LLM。
状态跃迁才是紧急，持续状态不是。
"""
```

首次接敌 / 小队全灭 → `priority='critical'`；连续 3 轮无接触（`DISENGAGE_ROUNDS = 3`）才降级回 peaceful。

**(b) 单飞 + 队列合并**（`message_queue.py` L1-4 docstring 原文）：

```python
"""Arma 消息池：Redis 队列 + 分布式锁。
态势报告和人类消息入队 → AI 处理时出队合并 → 确保不丢失堆积期间的变化。
"""
```

AI 处理期间新到的态势报告入队（critical 用 `lpush` 插队头），处理完在 `finally` 里 `dequeue_all` + `merge_situations`（**以最新态势为基底，累积所有 human_messages**），再派发一次合并任务（`tasks.py` L709-727）。**LLM 推理慢于游戏时，中间的过期态势被丢弃、只处理最新一份**——这与 OpenRA-RL 的 DropOldest 通道是同一思想的两种实现。

**(c) 提示词里显式告知延迟**（`tasks.py` SYSTEM_RULES 第 10-11 条，原文）：

```
'10. TIMING: Your orders will NOT execute immediately. There is a ~30-60 second delay '
'between your response and order execution in-game. Plan ahead: ...'
'11. DEFEND orders are TEMPORARY — they expire after ~120 seconds. ...You MUST follow up...'
```

**(d) 指挥链**：不是 commander→unit 的 LLM 层级，而是「LLM 只对 `control='llm'` 的 group 下小队级命令」（`_split_groups_by_control`），人类控制的部队只进日志不进 LLM 上下文；LLM 幻觉出的非己方 group 命令在入库前被过滤（`tasks.py` L646-660）。多智能体"参谋部"是平台层的 DAG 拓扑（`backend/app/topology/`，可视化编辑器，讨论/汇报/投票），属于战略咨询层，与游戏执行链解耦。

### 1.4 LLM 输出校验与兜底（对我们最有参考价值的部分）

三道防线，全在代码里：

**第一道：多策略 JSON 提取 + 降级**（`backend/app/open/service/arma_output_processor.py` L1-6、L15-48）：

```python
"""Arma Output Processor — 强制后处理管道。
确保 AI 输出包含可解析的 JSON orders，无论用户如何自定义 Agent。
有 JSON → 提取 orders → command_pool。
没有 JSON → 返回空 orders + 原文作为 briefing。
"""
# 策略：1) 直接 json.loads  2) ```json 围栏提取  3) 正则 \{.*\} 花括号匹配
# 4) 全部失败 → _empty_result(text[:500])：orders=[]，原文截 500 字当 briefing
```

**逐单校验**（`_normalize`）：丢弃非 dict、缺 `type`/`group_id` 的条目；waypoints 兼容裸数组自动转 `{"pos": [...]}`。

**第二道：group_id 白名单过滤**（`tasks.py` L646-654）——只保留态势报告里真实存在的 LLM 控制 group，幻觉单位ID的命令直接丢弃并记日志。另外提供 `validate_orders` 工具让 LLM 发送前自检（命令类型/编队/速度枚举校验，见 1.2）。

**第三道：行为规则补丁**（SYSTEM_RULES 19 条）针对已观察到的 LLM 故障模式逐条打补丁：卡死检测（同位置 3 轮 → 必须换命令，第 13 条）、打尸体（敌人多轮不动 → 判定已死，第 16 条）、巡逻被反复打断（"PATROL ACTIVE 的小队必须整条跳过"，第 15 条）、命令连续失败升级（3 轮失败 → 停止重发、改为原地防御或换部队侧翼，第 17 条）。**这份规则清单本身就是一部"LLM 幻觉/低能行为图鉴"**。

此外 Celery 任务级兜底：空响应重试 2 次（`for _attempt in range(2)`），异常 `self.retry(countdown=15)`，`max_retries=2` 后放弃本轮（游戏侧下次心跳再来，天然自愈）。

### 1.5 地图/态势压缩：把 Arma 级复杂地图压成 LLM 能吃的快照（深挖）

这是 OpenArma 对我们"战场快照"最有价值的部分，管线分四步：

**① 原始数据导出（Mod 层）**：MapExporter 在 Workbench 里导出"每棵树的坐标和大小、每栋建筑的朝向和尺寸、每条道路的宽度和路径"（README L83 原话）+ 高度图网格 + 水体网格 + 地标 POI，JSON 入库。

**② H3 六角格离线预计算**（`backend/app/map/service/hex_terrain.py`，719 行）：地图切成 H3 hex cell，每格从原始数据算出结构化战术属性：`terrain_type`（ridgeline/valley/forest/urban/water…）、`max_slope`、`tree_density`、`building_count`、`water_coverage`、`road_density`，再评级 `cover_rating` / `trafficability` / `observation`（`_rate_cover`、`_rate_trafficability`、`_rate_observation`）。

**③ 每格生成一句自然语言战术描述并向量化**（`_build_description`，L254-316，docstring 原文 "Generate a tactical terrain description for LLM consumption"）。生成样例逻辑：

```python
parts.append(f"{_TERRAIN_TACTICAL_DESC.get(tt,...)} ({h:.0f}m)")
if height_diff > 20: parts.append(f"dominates surroundings (+{height_diff:.0f}m above neighbors)")
if slope > 30:       parts.append(f"steep slopes ({slope:.0f}°)")
if td > 0.6:         parts.append("heavy forest cover")
parts.append(f"cover: {cell_data['cover_rating']}")
...
return ". ".join(parts) + "."
```

描述文本经 `_embed_concurrent` 批量 embedding 存 pgvector → 支撑 `query_terrain_cells` 的语义检索（"good cover for ambush" → 命中相关 hex）。

**④ 任务开始时生成三层精度 AO 简报注入系统提示词**（`backend/app/map/service/ao_briefing.py` L1-9 docstring 原文）：

```python
"""Area of Operations (AO) briefing generator.
Generates a natural-language terrain briefing for the LLM based on:
- Mission focus points and AO boundaries
- Three-layer precision rings (A: 0-1km detailed, B: 1-2km standard, C: 2km+ overview)
- Pre-computed hex cells, landmarks, roads, and zones within the AO
The briefing is cached in Redis and injected into the LLM system prompt."""
```

关键手法——**距离衰减的细节预算**：Zone A（0-1km）逐格给出完整描述；Zone B（1-2km）只给地形类型计数 + 关键地标 top10；Zone C（>2km）只给一行汇总 `Terrain: forest(12), urban(3)...`。再加 KEY LANDMARKS（按距离排序取前 20）、ROAD NETWORK（按类型计数）、URBAN ZONES（含 `tactical_notes`）。缓存 24h（`cache_briefing(ttl=86400)`）。

**⑤ 运行时态势快照压缩**（`tasks.py`）：
- `_truncate_situation_for_llm`：每组已知敌人上限 `MAX_ENEMIES_PER_GROUP = 5`（按"正在威胁 + 距离"排序取前 5），全局去重后上限 `MAX_GLOBAL_ENEMIES = 30`（按坐标 1m 网格去重）；
- 敌人按威胁排序展示，附 `seen {age}s ago`、`THREATENING`/`faction:xx` 标签；
- 与上一快照 diff，位移 <5m 的小队进 `== WARNING: N squad(s) have NOT moved ==` 段；
- 记忆压缩：最近 10 个快照的敌接触点聚成 200m 网格"热点区" top5（`Hot zone near [x,z]: N contact(s)`），而非逐条历史。

### 1.6 OpenArma 小结：可借鉴 vs 必须砍掉

| 可借鉴（逻辑层，与中间件无关） | 必须砍掉（重型基建） |
|---|---|
| 心跳式"态势上报 = 领取命令"单端点协议 | PostgreSQL + pgvector → SQLite（无向量检索，地形语义检索改为关键字/预计算标签） |
| 规则状态机定优先级，LLM 零参与 | Redis（队列/锁/缓存）→ SQLite 表 + 进程内 asyncio 锁 |
| 队列合并：忙时丢弃过期态势、只处理最新 | RabbitMQ + Celery → FastAPI BackgroundTasks / asyncio 任务 |
| JSON 多策略提取 + group 白名单 + 降级为 briefing | MinIO / Qdrant / Grafana / Prometheus / Tempo / Loki 全套 → 无 |
| 三层精度 AO 简报 + hex 格自然语言描述 | LangGraph → 手写轻量工具循环（其 graph.py 1361 行大量是平台功能） |
| SYSTEM_RULES 式的"故障模式补丁"提示词 | Next.js 管理后台/多租户/RBAC/插件系统 → SillyTavern 前端已覆盖 |
| 战争迷雾按阵营裁剪（fog_of_war.py，纯函数 138 行，可直抄思路） | Docker Compose 8 服务编排 → 单进程 |

---

## 第二部分：OpenRA-RL（Hugging Face 系，LLM/RL 打红警）

### 2.1 "三明治"架构的代码实证与 gRPC 选型原因

媒体说法核实结果：**基本属实，细节需修正**。真实分层（README L97-105 原文）：

```
| Component    | Language | Role                                              |
| OpenRA-RL    | Python   | Environment wrapper, agents, HTTP/WebSocket API    |
| OpenRA (submodule) | C# | Modified game engine with embedded gRPC server |
| OpenEnv (pip dep)  | Python | Standardized Gymnasium-style environment interface |

Data flow: Agent <-> FastAPI (port 8000) <-> gRPC bridge (port 9999) <-> OpenRA game engine
The game runs at ~25 ticks/sec independent of agent speed. Observations use a
DropOldest channel so the agent always sees the latest game state.
```

- 底层：`OpenRA/` 是 git submodule（fork 的魔改 C# 引擎，内嵌 gRPC server）；
- 中间：`proto/rl_bridge.proto` 定义 `RLBridge` 服务——双向流 `GameSession`、一元 `GetState`、**一元 `FastAdvance`**（注释原文："Bypasses streaming — works reliably on all platforms"）、多会话管理 `CreateSession/DestroySession`（注释："a single gRPC server hosts many concurrent game sessions, each identified by a session_id"）；
- 上层：`openra_env/server/openra_environment.py`（3232 行）的 `OpenRAEnvironment(MCPEnvironment)` 同时提供 Gymnasium 式 reset/step 和 51 个 `@configurable_tool` 注册的 MCP 工具；Python 侧还有 `grpc_worker.py`——单线程 gRPC worker（docstring 原文："sync gRPC + asyncio.to_thread deadlocks because multiple threads compete on one HTTP/2 connection... Per-session channels crash dotnet with 64 TCP connections. Solution: a single dedicated worker thread"）。

**为什么 gRPC 而不是进程内调用**（HF 博客原文归纳）：① 跨语言（C# 引擎 ↔ Python agent）；② "agent computation is fully decoupled from game execution. A scripted bot at 40 ms/step and an LLM at 2 s/step both interact with the same 25 Hz engine without disrupting game flow"；③ 引擎可整体打成 Docker 镜像分发（`ghcr.io/yxc20089/openra-rl`），agent 侧 `pip install openra-rl` 即可；④ 单 gRPC 服务按 `session_id` 路由 64 局并发。

**异步解耦的具体机制**（博客 "The async problem" 一节原文要点）：
- 观测通道：.NET `BoundedChannel<GameObservation>`，**capacity 1 + DropOldest**——"A fast agent (~40 ms) loses nothing; a slow agent (~2 s) skips ~50 intermediate ticks but still acts on fresh data"；
- 动作通道：`BoundedChannel<AgentAction>` capacity 16——"dropping a stale observation is harmless, but dropping an action means the agent's intent silently disappears"（观测可丢、动作不可丢的不对称设计）；
- 非阻塞保证：双通道 `TryWrite`，"If no action has arrived by tick time, the engine proceeds with a no-op"；
- `advance` 工具侧的服务端中断检测（`rl_bridge.proto` L219-224 + `openra_environment.py` L1440-1455）：`FastAdvanceRequest.check_events_every=25`（每 1 游戏秒检查一次），中断信号 `["game_over","enemy_spotted","unit_destroyed","under_attack","building_discovered",...]`，命中即提前返回 `interrupted=true, interrupt_reason=...`。**这是"快进中被事件唤醒"模式，等价于我们的"回合推进中被战报打断"**；
- `advance` 入参钳制：`ticks = max(1, min(ticks, 50))`，注释"keep each gRPC call <2s"。

**v2 优化数据核实**（博客表格原文）：Reset latency 5–15s → **256ms**（~40×）；RSS(64 sessions) ~40GB → **~6GB**（~7×）；手段是单 .NET 进程共享不可变 `ModData`（"That alone reclaims ~35 GB"），每 session 独立 `World/OrderManager/BotBridge`；另有一个坑（原文）："don't share the .NET ThreadPool between game ticks and gRPC handlers. We did this in an early v2 and saw 0/16 sessions complete"——后改为专用 `BlockingCollection<WorkItem>` worker 池 + 每 session `SemaphoreSlim(1,1)`，队列满时返回 gRPC `RESOURCE_EXHAUSTED` 做背压。

### 2.2 `advance` 占 ~57% 说明什么（核实 + 判断）

博客原文（两处）：

> "The dominance of `advance` (~57% of all calls) is **the agent compressing idle game time by skipping ticks** — exactly what the async architecture is designed for."
> "57% of tool calls are advance. Without DropOldest observations and a non-blocking action channel, a 2-second LLM cannot meaningfully play a 25 Hz game."

Game 5 前 10 回合逐字日志（博客原文）印证了节奏：

```
Turn  1 | get_faction_briefing()
Turn  2 | end_planning_phase(strategy="Deploy MCV, build Power Plant (300 ticks), ...")
Turn  4 | build_and_place(building_type="apwr")
Turn  5 | advance(ticks=100)   -> tick=55
Turn  8 | advance(ticks=60)    -> tick=108
Turn  9 | advance(ticks=130)   -> tick=159
Turn 10 | advance(ticks=80)    -> tick=210
```

**你的推断核实结果：方向正确，但表述要修正一处。** 正确部分：真正的决策调用（建造/移动/进攻）确实稀疏，大部分调用是"推进时间"；LLM 只在"有事发生"时被唤醒（服务端中断检测保证了这点）。需修正的部分：`advance` 高频**不是因为 LLM 每帧被驱动**，恰恰相反——它是 LLM **主动批量跳过无事发生的时段**（一次 advance(130) ≈ 5 游戏秒），配合服务端事件中断，实现"LLM 睡眠、事件唤醒"。另一个客观原因是 advance 兼任"刷新观测"（其返回值内嵌 `units_summary/enemy_summary/alerts`，注释原文 "Interrupt fields — eliminates get_game_state() in advance loop"），所以它同时是时钟和观测泵。

**对我们的启示（修正版）**：我们是回合制国战，天然没有"空转 tick"，所以连 advance 这个 57% 的大头都不需要——等价物是"回合结算由确定性代码跑，LLM 只在回合边界/玩家询问/触发事件时被调用一次"。OpenRA-RL 证明的正确姿势是：**时间推进由引擎负责，LLM 调用由事件驱动而非时钟驱动**。

### 2.3 工具清单与分类（核实：51 个注册 / README 说 48 / 博客说 50）

实测 `grep -c "@configurable_tool" openra_environment.py` = **51**；README L74/L456 写 "48 game tools"；博客写 "50 MCP tools"——媒体转述的 50 应为博客口径，且各版本间工具数有增减（如 `patrol_units`、`load_transport/unload_transport` 未列入 README 表格）。以代码为准，51 个按 `config.yaml` 的 13 个类别（原文注释）：

| 类别（config 键） | 工具 |
|---|---|
| read | `get_game_state` `get_economy` `get_units` `get_buildings` `get_enemies` `get_production` `get_map_info` `get_exploration_status` |
| knowledge | `lookup_unit` `lookup_building` `lookup_tech_tree` `lookup_faction` |
| bulk_knowledge | `get_faction_briefing` `get_map_analysis` `batch_lookup` |
| planning | `start_planning_phase` `end_planning_phase` `get_planning_status` `get_opponent_intel` |
| game_control | `advance` |
| movement | `move_units` `attack_move` `attack_target` `stop_units` `patrol_units` |
| production | `build_unit` `build_structure` `build_and_place` |
| building_actions | `place_building` `cancel_production` `deploy_unit` `sell_building` `repair_building` `set_rally_point` `guard_target` `set_stance` `harvest` `power_down` `set_primary` `load_transport` `unload_transport` |
| placement | `get_valid_placements` |
| unit_groups | `assign_group` `add_to_group` `get_groups` `command_group` |
| compound | `batch` `plan` |
| utility | `get_replay_path` `surrender` |
| terrain | `get_terrain_at` |

工具可按类别/单个开关（`tools.categories` / `tools.disabled`），并提供 `examples/config-minimal.yaml`（README 注明 "Reduced tool set for limited-context models"）——**说明他们自己也承认 50 个工具对小上下文模型是负担**。

**高层意图工具值得注意**：`batch`（多命令同一 tick 并发执行，支持 `unit_ids: "all_combat"/"all_idle"` 选择器）和 `plan`（顺序步骤 + 条件门控：`"enemies_visible"`、`"funds_above:2000"` 等，docstring 原文 "Use conditions to gate steps on game state"）——即**把"多步意图 + 触发条件"下沉给确定性执行器**，LLM 一次调用表达一个小型作战计划。这是我们"LLM 出计划、代码执行"最接近的现成范式。

**观测压缩手法**（三层）：
1. **ASCII 小地图**（`_render_minimap`，openra_environment.py L76-169）：把 9 通道 spatial tensor（float32 二进制，`proto` 里 `bytes spatial_map`）降采样到 ≤28 列字符画：`! 敌单位 X 敌建筑 @ 我单位 B 我建筑 $ 矿 ~ 水 . 已探明陆地 # 未探明`，按优先级覆盖（敌 > 我 > 地形），附图例；
2. **TURN BRIEFING 文本化**（`agent.py format_state_briefing` L282-415）：经济一行（`Funds: $X (cash+ore) | Power | Harvesters | Explored%`）、单位按类型聚合（`3xe1[12@(45,30)→(60,40),...]`，含 ID/位置/目标/空闲标记）、建筑带类别标签、敌人聚合 + 平均位置中心、生产队列区分 `READY TO PLACE`；
3. **告警系统**（12 种可开关 alert，`default_prompts.yaml` L102-145）：`UNDER ATTACK` / `LOW POWER` / `IDLE FUNDS` / `IDLE ARMY` / `NO SCOUTING` / `STANCE: N combat unit(s) on ReturnFire` 等，按优先级排序、可设上限 `max_alerts`——**用规则代码替 LLM 盯盘，只把"需要注意的事"推进上下文**。
另有历史压缩 `compress_history`（agent.py L567-699）：超过阈值时保留 system + 最近 40 条，旧消息压成一条状态感知摘要（最后 tick/资金/已建建筑/已产单位/击杀损失/最近 3 条错误/规划阶段提取的 `Strategy:` 行）。

### 2.4 "只种田不打仗"根因（博客有明确复盘）

实测结果核实（博客原文表格）：Qwen3 32B（Ollama 本地部署）vs 内置 Beginner AI，128×128 盟军地图，5 局（1-2 局 30 分钟限时，3-5 局 5 分钟限时）——"All five episodes ended in a draw at the time limit with **zero combat engagement**. The agent successfully bootstrapped an economy in every game but **never produced an offensive force**." 8 维奖励向量：economy 0.58–0.80、infrastructure 高、tempo 非零，**combat = 0、disruption = 0**。

仓库/博客的归因（原文）：

> "That's not a platform failure — it's evidence that even tutorial-tier Red Alert requires real strategic reasoning (build order, army composition, attack timing) that **prompt-driven LLMs do not yet capture**."
> "In-context reflection helps, but is not enough. Episode 2's reflection diagnoses a build-order mistake ('War Factory before Power Plant'); by Episode 4 the pre-game plan opens with a Power Plant. **Prompt-injection learning fixes build order — it does not close the combat gap.**"

即官方复盘结论是**LLM 能力问题为主**（长链条军事规划：建军编成 + 进攻时机），提示词/反思机制只能修正局部错误（建造顺序），无法催生进攻行为；他们给出的出路是 GRPO 权重更新（"What's next" 第一条）与按 8 维奖励做课程学习。补充两点仓库内证据：

- 系统提示词（`openra_env/prompts/default.txt`）其实明确要求进攻（"Your goal is to defeat the opponent by destroying their forces"）并给了 TEMPORAL REASONING 原则（"Build economy early, army later"）——**"先经济后军事"这句话很可能被 32B 模型执行成了"永远经济"**；提示词没有任何硬性进攻时限/里程碑约束。告警系统里有 `IDLE ARMY`、`NO SCOUTING` 试图纠偏，但本例中部队根本没被生产出来，告警无从触发（`idle_army` 只统计已有作战单位）。
- 对手是 Beginner AI（`opponent_intel.py` 原文 profile："Almost never attacks — first attack after 100+ minutes"），双方都不进攻 → 5 局全平零交锋是必然。

**对我们设计"LLM 战略顾问"的直接教训**：
1. 提示词里"先发展后进攻"这类软性阶段描述会被小模型无限延长第一阶段——**必须给硬约束**（"第 N 回合前必须有 X 支进攻力量"式的可校验里程碑）；
2. 用**规则代码检测行为偏差并生成告警注入上下文**（他们的 alerts 思路对，但告警条件要覆盖"该做而没做"，如"连续 3 回合未征兵"）；
3. 局后反思注入对"程序性错误"（顺序、时机）有效，对"战略倾向"（不打仗）无效——别指望复盘提示词改变模型性格；
4. 8 维分向量评估比单一胜负更能定位失败模式——我们的国战评估也应输出多维分数（经济/扩张/战斗/外交…），确定性代码计算。

### 2.5 赛前规划 + 赛后反思的代码实现

**赛前规划**（`agent.py` L776-922 + `openra_environment.py` planning 工具）：
- `start_planning_phase` 返回地图/基地/敌估计位置/阵营/`opponent_summary`（来自 `opponent_intel.py` 的静态画像），游戏时钟暂停；
- 注入 `planning_prompt`（`default_prompts.yaml` L17-31 原文模板）：

```yaml
planning_prompt: |
  ## PRE-GAME PLANNING PHASE
  You have {max_turns} turns to plan.
  ### Map Intel
  Map: {map_name} ({map_width}x{map_height})
  Your base: ({base_x}, {base_y})
  Enemy estimated: ({enemy_x}, {enemy_y})
  ### Opponent Intelligence
  {opponent_summary}
  {planning_nudge}
planning_nudge: "Call end_planning_phase(strategy='...') when ready to start."
```

- LLM 在 ≤10 回合 / 60 秒内自由调用知识工具（`get_faction_briefing`/`get_map_analysis`/`batch_lookup`/`get_opponent_intel`），最终必须调 `end_planning_phase(strategy="...")` 提交战略文本；超时则代码强制 `end_planning_phase(strategy="(planning timed out, no explicit strategy)")`（agent.py L896-917）；
- 规划上下文随后被**丢弃**（`messages = [messages[0]]`，只留 system），战略文本作为 `## Your Pre-Game Strategy\n{planning_strategy}` 拼进 game_start 消息——避免规划期的工具消息污染对局上下文，也绕开严格角色交替模型（Mistral）的限制。

**赛后反思 + 经验注入**（`openra_env/memory.py`，385 行，docstring 原文 "Implements the Experience-Reflection-Consolidation loop (inspired by ERL)"）：
- 局中 `EventTracker` 用状态 diff 记录带 tick 时间戳的事件（`first_barracks`、`first_kill`、`major_loss`、`low_cash`…，milestone 去重），`format_timeline()` 输出如 `t=5000 (~200s): First enemy kill (×2)`；
- 局后 `build_reflection_prompt`（memory.py L314-358）把结果/阵营/K-D 价值比/**赛前战略原文**/事件时间线喂给 LLM，要求固定格式输出：

```
Answer:
1. Using the timeline above, analyze key decision points and timing issues
   (e.g. "tanks didn't come until t=5000, too late")
2. List 1-3 specific actionable lessons with concrete timing targets
   (e.g. "must have tanks before t=3000")
Required format:
Analysis: <...>
Lesson1: <...>
```

- `parse_reflection_response` 按 `Analysis:`/`LessonN:` 前缀解析，解析失败兜底取全文前 300 字；
- `GameMemory` 持久化到 `~/.openra-rl/memory/memory.json`（纯 JSON 文件，无数据库！）；下一局开局 `get_context(max_entries=5)` 选择**最近 3 局 + 最快获胜的 2 局**，拼成 `## 历史对局经验`（含胜负记录、每局 Analysis/Lesson、最近败局的重复教训警告 "Warning — recurring issues from recent losses"）**追加到 system prompt**（agent.py L762-767：`system_prompt += f"\n\n## 历史对局经验\n{memory_context}"`）。
- 另有局中 checkpoint：每 3000 tick（`checkpoint_interval`）注入一条 `STRATEGY CHECKPOINT` 消息（K/D 比 + 军力价值 + 事件时间线 + "Evaluate the current situation and adjust strategy"），逼 LLM 定期重估战略。

博客实证其有效性与局限：第 2 局反思发现"战争工厂应排在发电厂后"，第 4 局开局计划确实改了；但 combat=0 纹丝不动。

### 2.6 OpenRA-RL 必须砍掉的重型部分 → 我们的轻量替代

| 重型部分 | 它们的用途 | 我们的替代方案 |
|---|---|---|
| .NET 魔改引擎 + gRPC（9999 端口）+ FastAPI（8000） | 跨语言、25Hz 实时、64 并发 | **无游戏引擎**。数值由确定性 Python 代码算，单进程 FastAPI + SQLite(WAL)，无需 gRPC/双端口 |
| 25Hz 实时 tick + DropOldest 通道 | 实时 RTS 与慢 LLM 解耦 | **回合制 tick**：回合结算纯代码毫秒级完成；LLM 调用只在回合边界/玩家请求/事件触发，天然无需通道缓冲；在途 LLM 请求用"单飞 + 过期丢弃"（学 OpenArma 的锁与合并） |
| 64 局单进程并发 + 专用线程池 | RL 训练吞吐 | 1 个房间几个玩家，`asyncio` 足够；LLM HTTP 调用用 httpx 异步 + 信号量限并发 |
| 9 通道 float32 spatial tensor + base64 | RL 观测空间 | 不需要——我们只服务 LLM，直接生成文本/JSON 快照 |
| Docker 镜像 + noVNC 回放 + .orarep | 分发与观战 | SQLite 存回合日志 + WebSocket 推给 SillyTavern/网页前端做回放 |
| OpenEnv/Gymnasium/TRL/GRPO 生态 | RL 训练 | 砍掉，我们不做权重训练 |
| 51 个工具全量暴露 | 通用平台 | **≤10 个工具**，学 OpenArma 的粒度：查询类（态势/地形/敌情）+ 计划类（提交结构化 JSON 战略建议）；条件化多步计划可参考 `plan` 工具的 condition 门控 |
| Ollama 本地 32B（GPU） | 演示 | 云端 OpenAI 兼容 API + 异步低频控 token（业主已定） |

**可直接搬的轻量件**：`memory.py` 全套（纯 JSON 文件反思记忆，385 行零依赖）；`opponent_intel.py` 静态对手画像思路；alerts 规则告警；`compress_history` 滑窗压缩；ASCII 快照思路（我们的"战场快照"可用类似的字符网格 + 分类型聚合行）。

---

## 第三部分：合并结论 —— 本项目「异步 LLM + 工具调用」落地建议

### 3.1 LLM 调用由什么触发

两个案例殊途同归：**LLM 永远不在数据通路上，只在决策点上**。推荐三类触发器（按优先级）：
1. **回合边界（主）**：确定性代码结算完一个回合 → 生成态势快照 → 触发一次 AI 战略顾问调用（对应 OpenArma 的心跳 + OpenRA-RL 的 interrupt 唤醒）；
2. **规则状态机跃迁（急）**：仿 `battle_state.py`——peaceful/engaged/critical 由代码判定，"状态跃迁才是紧急，持续状态不是"，跃迁时提升该次调用的优先级（插队）；
3. **玩家显式请求（交互）**：SillyTavern 里人类提问 → 走同一条队列。
配套机制：单飞锁（同一阵营同时只有一个 LLM 请求在途）+ 队列合并（在途期间的新触发合并为最新一份，人类消息全部累积不丢——直接照抄 `merge_situations` 策略，SQLite 表实现）+ 提示词中显式声明延迟（"你的建议将在下一回合生效，请预判"——对应 SYSTEM_RULES 第 10 条）。

### 3.2 工具粒度

- **命令输出不走 function calling**，走"强制 JSON + 后处理管道"（OpenArma 证明这对国产/中小模型更稳）：Pydantic 校验 → 枚举白名单（部队ID/指令类型）→ 多策略提取（直接解析/围栏/花括号正则）→ 全失败降级为"纯文本建议"（orders 置空，绝不让解析失败阻塞回合）；
- 工具数量 ≤10，全部是**战术意图级/查询级**：`get_battlefield_snapshot`、`query_terrain(area)`、`query_unit(id)`、`estimate_march(...)`、`validate_orders(json)`、`submit_plan(json)`；数值计算类工具（距离/行军时间/战力对比）由代码算，LLM 只消费结果——正好契合"禁止 LLM 参与数值计算"的硬约束；
- 可借鉴 `plan` 工具的条件门控：LLM 提交"若敌军出现在 X 则执行 Y"的分支计划，由代码在后续回合确定性执行（LLM 睡着时计划仍在跑）；
- 工具循环上限（学 `MAX_TOOL_ROUNDS=10`），并对"强力工具"写使用约束（火炮教训）。

### 3.3 态势快照压缩

分层预算，全部离线/结算时预计算：
1. **静态层（一次生成，长期缓存）**：地图按格（hex 或方格）预计算 terrain_type/通行/隐蔽/观察 评级 + 每格一句自然语言战术描述（照抄 `_build_description` 模板）；开局生成"三层精度 AO 简报"（核心区逐格、外围计数汇总）注入系统提示词；
2. **动态层（每回合）**：部队按建制聚合（`3x民兵[(12,5)→(14,6)]` 风格）、敌情只给"已侦察"且按威胁排序 top-N（每组 ≤5、全局 ≤30，坐标网格去重）、与上回合 diff 出"未移动/新接触/损失"WARNING 段、敌接触历史聚成热点区 top5；
3. **告警层**：12 种规则告警裁剪成适合国战的 6-8 种（遭攻击/粮草不足/部队闲置/边境空虚/**连续 N 回合未备战**——最后一条是针对"只种田"教训新增的"该做没做"型告警）；
4. **历史层**：滑动窗口（最近 N 回合原文）+ 状态感知摘要（compress_history 模式）；跨局经验用 memory.json 模式（最近 3 局 + 最佳 2 胜 + 反复教训警告）。

### 3.4 失败兜底清单

| 故障 | 兜底（均有原型代码） |
|---|---|
| LLM 输出非法 JSON | 三策略提取 → 降级纯文本 briefing，回合照常推进（arma_output_processor） |
| 幻觉单位/指令 | 白名单过滤 + `validate_orders` 自检工具 + 枚举钳制（OpenArma）；未知工具名返回 `suggested_tools`（difflib 相近匹配，agent.py L1168-1178） |
| 空响应 | 重试 2 次后放弃本轮，下回合自愈（tasks.py） |
| API 超时/429/5xx | 指数退避重试（max_retries=4, backoff×attempt），本地模型自动放大 timeout（agent.py L710-713） |
| LLM 长期挂掉 | 回合结算不依赖 LLM，游戏可无限继续（AI 建议缺位而已）——两案例共同点 |
| 行为退化（卡死/重发/种田） | SYSTEM_RULES 式故障模式补丁 + checkpoint 定期战略重估（每 N 回合强制"评估当前战略是否有效"） |
| 上下文爆炸 | 敌人截断 + 历史压缩 + 规划上下文用后即弃（`messages=[system]` 重置） |

### 3.5 一句话总结

OpenArma 教我们**工程兜底**（状态机定优先级、队列合并、三道校验、故障图鉴提示词、三层精度地图简报）；OpenRA-RL 教我们**节奏设计**（时间推进归引擎、LLM 由事件唤醒、观测可丢动作不可丢、多维奖励定位失败、反思记忆纯 JSON 即可）；两者共同的反面教材是**重型基建**（Redis/Celery/RabbitMQ/gRPC/.NET/Qdrant/Grafana 全家桶）——全部逻辑模式都能在「FastAPI + SQLite(WAL) + asyncio + WebSocket」单进程内等价复现。

---

## 附：证据文件索引

**OpenArma**（浅克隆于调研时 `_tmp/arma_repo`，已清理；路径均相对仓库根）：
- `README.md`（架构/技术栈/地图方案/参谋部/经验学习）
- `backend/app/task/tasks/open/tasks.py`（SYSTEM_RULES 19 条、format_situation_report、_truncate_situation_for_llm、Celery 主任务、队列排水）
- `backend/app/open/api/v1/command.py`（POST /open/command 单端点、快照入库、按阵营派发）
- `backend/app/open/service/battle_state.py` / `message_queue.py` / `command_service.py` / `fog_of_war.py` / `arma_output_processor.py`
- `backend/app/conversation/engine/builtin_tools/arma_tools.py`（5 工具定义）、`backend/app/open/service/map_tools.py`（16 地图工具）、`backend/app/conversation/engine/graph.py`（MAX_TOOL_ROUNDS=10、流式工具循环）
- `backend/app/map/service/hex_terrain.py`（H3 格属性/描述生成/向量化）、`ao_briefing.py`（三层精度简报）
- Mod：`OpenArma-Mod-Main/Scripts/Game/OA/OA_DecisionBridge.c`（REST 心跳桥）、`OA_Main.c`（Login→Heartbeat→Logout、DecisionInterval）、`OA_CommandExecutor.c`（order→引擎 Waypoint）；`OpenArma-Mod-MapExporter/README.md`；`OpenArma-Mod-MapScanner`（文件树：Roads/Landmarks/FileExport）

**OpenRA-RL**（`_tmp/openra_repo`）：
- `README.md`（三组件表、数据流、48 工具表、观测/动作空间、8 维奖励配置）
- `proto/rl_bridge.proto`（GameSession/FastAdvance/CreateSession、22 个 ActionType、中断检测字段）
- `openra_env/server/openra_environment.py`（51 个 @configurable_tool、_render_minimap、alerts 计算、advance 实现、batch/plan）
- `openra_env/server/grpc_worker.py`（单线程 gRPC worker 及原因）
- `openra_env/agent.py`（规划循环、TURN BRIEFING、compress_history、checkpoint、反思、幻觉工具名兜底）
- `openra_env/memory.py`（EventTracker/GameMemory/build_reflection_prompt/parse_reflection_response）
- `openra_env/prompts/default.txt`、`default_prompts.yaml`；`openra_env/opponent_intel.py`；`config.yaml`
- HF 博客（经 hf-mirror.com 获取全文）：`https://huggingface.co/blog/jadetan/openra-rl`（2026-04-27，六作者；57%/256ms/6GB/5 局数据、五局表格、Game5 前 10 回合日志、"In-context reflection helps, but is not enough" 复盘）

**未找到/未能核实**：
- 博客宣称 50 工具 vs README 48 vs 代码 51 的精确对账（版本演进导致，无 changelog 可查）；
- OpenRA-RL 仓库内没有针对"只种田"的独立复盘文档（结论全部来自 HF 博客"What this baseline actually demonstrates"一节与 `docs/` 仅有两张图片）；
- `OpenArma-Mod-MapScanner` 的 README 原文经 raw 直连拉取失败（仓库存在、main 分支，文件树已核实），其功能描述引自 MapExporter README 的交叉引用。
