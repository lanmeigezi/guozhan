# 案例调研 03：ernestwisniewski/age-of-new-worlds

> 调研日期：2026-10（本机直连 GitHub API，下载 main 分支完整 tarball 实际读码，非仅看 README）
> 仓库：https://github.com/ernestwisniewski/age-of-new-worlds （MIT）
> 基本盘：默认分支 main，最后 push 2026-10-01，仓库体积 372MB，6 star，主语言 Dart（客户端），核心规则为 Rust
> 官方描述："A 4X hex strategy game built with Rust, Godot, Flutter and Flame."

---

## 0. 一句话定性

这是一个**教科书级的"单一权威核心 + 薄适配器"实现**：全部游戏规则、状态、命令、事件、AI、存档、回放都在一个确定性 Rust workspace（`engine/`）里；Flutter、Godot、Serverpod（联机服务器）都只是**不含任何规则的薄适配器**。它的多人联机架构（无状态服务器主机 + 数据库事务 + 按接收者投影）几乎就是我们要做的"多房间权威服务端"的 Rust/Dart 版本，**是所有已调研案例中与我们目标架构最贴近的一个**。

## 1. 关键澄清：`aonw_core` 是历史名字，现核心叫 `engine/`

业主提到的 `aonw_core` **在当前仓库中已不存在**。证据链：

- 旧仓库 `ernestwisniewski/aonw`（同一个游戏的早期纯 Dart 版本，5196 个文件）中存在 `packages/aonw_core/lib/`，内含 Dart 写的规则与 AI（如 `packages/aonw_core/lib/ai/mcts/`、`packages/aonw_core/lib/game/domain/unit/unit_fortification_rules.dart`）。
- 新仓库 `age-of-new-worlds` 把核心**从 Dart 整体重写为 Rust**，旧包名只在两份过期文档里残留引用：
  - `docs/parity/fortified-recovery.md:4`：`packages/aonw_core/lib/game/domain/unit/unit_fortification_rules.dart`
  - `docs/parity/lobby-presence.md:20`：`packages/aonw_core/lib/protocol/lobby_roster_policy.dart`
- 当前 `packages/` 下只有 `aonw_engine_client`（Dart→Rust 本地运行时绑定）、`aonw_server_native`（Serverpod→Rust 原生边界）、`aonw_server_client`（生成的 Serverpod 客户端）。

**"单一权威核心"的原文出处**（仓库自己的措辞是 "the only authoritative gameplay implementation" / "single gameplay implementation"）：

> `docs/adr/0008-engine-ownership.md`：
> "The Rust workspace under `engine/` is the only authoritative gameplay implementation."

> `docs/engine-quality.md`：
> "The Rust workspace under `engine/` is the single gameplay implementation for Flutter, Godot, AI, replay, and Serverpod."

ADR 0008 列出的核心不变量（原文要点）：

1. **所有状态变更只经 core**："Canonical maps, state, commands, queries, turn processors, AI, outcome, save, and replay semantics are owned by engine crates."
2. **core 无 IO/时钟/随机**："Every transition is deterministic from explicit state, command, content, and trusted context. Pure crates do not read clocks, system randomness, I/O, or presentation state."（`docs/engine-quality.md` 补充："Rejections leave canonical state unchanged."——被拒绝的命令不改变状态）
3. **适配器不许裁决规则**："Flutter widgets, Flame components, GDScript, native adapters, and Serverpod endpoints may validate transport shape but may not decide gameplay legality, cost, pathfinding, combat, fog, or outcome."
4. **身份不匹配即 fail closed**："One running session has one build, contract, and content identity. An identity mismatch fails closed."
5. **隐藏信息只按接收者投影**："Recipient projection is rules-sensitive engine policy. Clients never receive canonical hidden state and never reconstruct it from visible data."
6. **确定性重放**：存档/回放携带 behavior fingerprint 与 state digest，见第 4 节。

### 当前 Rust crate 划分（`engine/crates/`，共 17 个 crate，844 个 .rs 文件，约 15.6 万行）

| crate | 职责（源自 `docs/engine-quality.md` "Ownership" 一节 + 实际目录） |
| --- | --- |
| `aonw_domain` | 规范状态（GameState、hex 网格、城市/战斗/外交/经济/迷雾聚合） |
| `aonw_engine`（329 文件，最大） | 规则、确定性转移、命令应用、事件、执行证据、状态摘要 |
| `aonw_content` | 严格的地图/规则集内容文档（content hash） |
| `aonw_contracts` | 对外消费的一切 DTO：client / server / persistence 三套严格编解码 |
| `aonw_contract_mapping` | 引擎类型 ⇄ wire DTO 的映射 |
| `aonw_projection` | 按接收者的安全视图（RecipientDisclosure、diff_view） |
| `aonw_local_runtime` | 本地会话生命周期、revision、存档、回放、JSON 客户端协议分发 |
| `aonw_server_runtime` / `aonw_server_native` | 无状态服务器主机 + C ABI 边界 |
| `aonw_ai` | 确定性 MCTS/策略规划器（无 LLM） |
| `aonw_flutter` / `aonw_godot` | C ABI / GdExtension 原生适配器 |
| `aonw_testkit` | 规范 fixture 装载器、diff、canonical runner |

## 2. 适配器清单与接口形态

架构总图来自 `docs/README.md`（原文 mermaid）：Flutter/Godot 走本地原生绑定，联机走 Serverpod → `aonw_server_native` → Rust，**三条路径最终进同一个引擎**。

### 2.1 Flutter 适配器 = 稳定 C ABI（`engine/crates/aonw_flutter/`）

Cargo.toml 自述："C ABI adapter for the AoNW Flutter local client"，`crate-type = ["cdylib", "staticlib", "rlib"]`。`src/lib.rs` 开头：

```rust
//! Stable C ABI for the Flutter Native Assets adapter.
#![deny(unsafe_op_in_unsafe_fn)]

static BUILD_IDENTITY: &[u8] = concat!("aonw_flutter/", env!("CARGO_PKG_VERSION")).as_bytes();

struct FlutterSession {
    runtime: LocalRuntime,
    ai_driver: StrategicPlanner,
}

#[unsafe(no_mangle)]
pub extern "C" fn aonw_flutter_client_api_version() -> u16 { CLIENT_API_VERSION }

#[unsafe(no_mangle)]
pub extern "C" fn aonw_flutter_session_new() -> *mut core::ffi::c_void {
    Box::into_raw(Box::new(FlutterSession {
        runtime: LocalRuntime::default(),
        ai_driver: StrategicPlanner,
    })).cast()
}
```

要点：会话是不透明句柄；跨边界的一切数据是**一个严格 JSON 客户端协议**（见 2.4）；带 panic 捕获（`catch_unwind`）与 build identity 校验。

### 2.2 Godot 适配器 = GdExtension（`engine/crates/aonw_godot/src/lib.rs`）

```rust
//! Godot adapter for the shared deterministic local client protocol.
mod local_session;
#[cfg(feature = "editor-tools")]
mod map_workbench;
mod extension_entrypoint {
    struct AonwGodotExtension;
    #[gdextension]
    unsafe impl ExtensionLibrary for AonwGodotExtension {}
}
```

两个完全不同的 GUI 框架（Flutter/Flame 与 Godot）共享**同一个** `ClientProtocol`，这是"表现层可替换"的最强证据。

### 2.3 服务器适配器 = 无状态 Rust 主机（`aonw_server_runtime/src/host.rs`）

Serverpod（Dart）负责认证、锁、事务、offset、投递；每次权威转移调用一次 Rust 主机。主机入口是纯函数，**全部输入显式传入，不保留进程内会话状态**：

```rust
/// Complete trusted input for one authenticated player command.
pub struct PlayerCommandRequest<'command> {
    /// Canonical state locked by the server transaction.
    pub state: GameState,
    /// Immutable map and rules prepared outside the match transaction.
    pub world: PreparedServerWorld,
    /// Player identity derived from the authenticated server session.
    pub authenticated_actor: PlayerId,
    /// Strict command decoded by the trusted server boundary.
    pub command: PlayerCommand<'command>,
    /// Durable offset immediately before this command.
    pub initial_event_offset: u64,
}

pub fn apply_player_command(
    request: PlayerCommandRequest<'_>,
) -> Result<ServerCommandOutcome, ServerHostError> { ... }
```

ADR 0013（`docs/adr/0013-in-process-engine-host-for-multiplayer.md`）原文：

- "The host is stateless and reentrant. Each call receives a strict bounded canonical state, immutable content, trusted context, and one command or system transition; it returns an all-or-nothing outcome."
- "Serverpod derives the actor from the authenticated session. Player payloads carry no trusted actor identity."（客户端载荷里的身份一律不信，以会话为准——`host.rs` 里的 `bind_authenticated_actor` 会覆盖命令内嵌身份）
- "A sidecar or alternate gameplay backend is not maintained in parallel."（禁止第二套规则实现）

### 2.4 共享客户端协议：一个严格 JSON 分发器

`aonw_local_runtime/src/client_protocol/mod.rs`：

```rust
/// Framework-neutral dispatcher for the shared Godot and Flutter client protocol.
pub struct ClientProtocol;

impl ClientProtocol {
    /// Decodes, dispatches, and encodes one strict client JSON document.
    pub fn dispatch_json(runtime: &mut LocalRuntime, input: &str) -> String { ... }

    /// Decodes and executes one request with a production AI driver available.
    pub fn dispatch_json_with_ai(
        runtime: &mut LocalRuntime,
        input: &str,
        ai_driver: &mut dyn AiTurnDriver,
    ) -> String { ... }
}
```

解码失败即返回 `invalid_client_request` / `unsupported_client_api_version`（fail closed）。协议版本号（当前 client API 47、native host API 11）双向拒绝不匹配版本（`docs/multiplayer-protocol.md`）。

### 2.5 测试适配器

`aonw_testkit`（canonical fixture 装载 + JSON diff + canonical runner）、`engine/fixtures/`（111 个文件，含 `persistence/manifest.json`、`restore-matrix.json` 机器可读测试矩阵）、`engine/fuzz/`（fuzz 目标）、`tool/test_engine_architecture.py` 与 `tool/test_client_boundaries.sh`（**架构测试**：机器强制"GameIntent 不得出现在 transport/event-log/server 边界"，见 ADR 0003 Verification）。

## 3. 命令与表现的严格分离

### 3.1 四类输入输出（ADR 0003 `docs/adr/0003-command-boundaries.md`，原文表格）

| 类型 | 职责 |
| --- | --- |
| `GameIntent` | 表现层输入与本地交互状态。**永不持久化、永不作为权威命令发送** |
| `DomainCommand` | 不可变的、请求改变权威状态的玩家命令。**引擎接受的唯一客户端来源输入** |
| `SystemCommand` | 受信确定性转移（超时、强制结算）。永不暴露给玩家命令端点 |
| `DomainEvent` | 已接受的事实事件。"Not a command, UI effect, or log instruction." |

数据流（原文 mermaid 化简）：`Tap → GameIntent → 表现控制器 → DomainCommand → 确定性引擎 → DomainEvent → 持久化/传输/UI 投影`；AI planner 和受信调度器分别从同一入口注入 DomainCommand / SystemCommand。

ADR 0003 的关键句：**"AI emits normal `DomainCommand` values through the public engine contract."**——AI 与人类走完全相同的命令通道，没有后门。

### 3.2 实现形态：Rust 枚举（不是 JSON-first）

命令是带生命周期借用参数的 Rust 枚举 `PlayerCommand`（约 40 个变体，`aonw_engine/src/application/command.rs`）：

```rust
/// Authoritative command family available to player-facing adapters.
pub enum PlayerCommand<'command> {
    DeclareWar(DeclareWarCommand<'command>),
    SendDiplomaticProposal(SendDiplomaticProposalCommand<'command>),
    StartBuilding(StartBuildingCommand<'command>),
    AttackHex(AttackHexCommand<'command>),
    MoveUnit(MoveUnitCommand<'command>),
    EndTurn(TurnCommand<'command>),
    SubmitTurn(TurnCommand<'command>),
    // ...共约40种
}
```

JSON 只存在于边界：client DTO（`aonw_contracts/src/client/`）→ 严格解码 → 枚举。拒绝原因也是稳定枚举 `CommandRejectionCode`（`application/transition.rs`，100+ 个变体：`StaleRevision`、`MatchFinished`、`MoveTargetOccupied`、`AttackTargetNotVisible`…），wire 上是字符串码，UI 只负责把码翻译成人话——**表现层永远不自己判断"为什么不行"**。

### 3.3 事件与"执行证据"

`DomainEvent`（`application/transition/outcome.rs`，约 45 个变体：`CityFounded`、`CombatResolved`、`DiplomaticPromiseBroken`、`TurnEnded`、`MatchEnded`…）。特别值得抄的是 `ExecutionEvidence`：

```rust
/// Exact evidence used by clients for deterministic presentation.
pub enum ExecutionEvidence {
    UnitMovement(UnitMovementExecution),
    Logistics(LogisticsExecution),
    TurnKernel(TurnKernelExecution),
    /// Exact seed, rolls, modifiers, damage and retreat result for one attack.
    Combat(CombatExecution),
    WorkerAutomation(WorkerAutomationExecution),
}
```

即：**战斗动画所需的具体掷骰序列由引擎产出并随事件下发**，客户端只播放、绝不自己 roll。表现层消费方式是"事件 + 证据 → 投影"（`aonw_projection`），UI 效果被定义为"projections of accepted events plus local interaction state"（ADR 0003）。

### 3.4 事件日志 / 事件溯源

是**事件日志 + 检查点**而非纯 event sourcing：

- 本地：`SaveGameDto`（完整规范状态 + 内容身份 + actor + **event offset** + **state digest**）与 `ReplayLogDto`（"a bounded chain of canonical checkpoints, journal checkpoints and exact command context and results"，`docs/engine-persistence.md`）。
- 线上：PostgreSQL 存 canonical state、recipient 快照、**事件与命令结果、单调 offset**（`docs/multiplayer-protocol.md`）。
- 事件 DTO：`aonw_contracts/src/persistence/event.rs` 的 `ReplayEventDto`，`serde(tag="type", rename_all="camelCase", deny_unknown_fields)`——未知字段直接拒收。

## 4. 状态存储、确定性与随机种子

### 4.1 本地存档：原子写协议（`docs/engine-persistence.md` 原文五步）

`PersistenceFileStore` 是 `aonw_local_runtime` 里**唯一的 IO 边界**（"pure domain and engine crates remain filesystem-free"）：序列化并严格解码 → 写临时文件并 sync → 把旧主文件轮转为 last-known-good 备份 → 原子 rename 安装 → 失败回滚。恢复时主档校验失败则提升备份并修复主档；两者都失败则**会话保持原样**。测试证据：十类战略命令 × 八种中途状态的 restore matrix、含截断/超长/重复字段/未知字段/内容哈希/检查点链/精确回放漂移的 corruption corpus。

### 4.2 确定性重放：behavior fingerprint 双向 fail closed

存档头携带**引擎行为指纹**（behavior fingerprint，当前值 5）与状态摘要；不匹配的存档在 header 校验阶段直接拒绝。线上每次从持久化状态恢复也带 `GameMatch.replayBehaviorFingerprint`，"Rust rejects null, empty or incompatible values with `behavior_fingerprint_mismatch` before restoring state or executing rules"。回放 = 检查点 + 精确命令上下文重演，且回放期间客户端挂载**生产同款** MapScreen/HUD 只读回放（共享回放呈现，见 engine-persistence.md "Shared replay presentation"）。

### 4.3 随机种子：从状态推导，不用系统随机

`aonw_engine/src/combat/rng.rs`（全文即证据）：

```rust
/// Exact xorshift32 combat RNG used by the engine contract.
pub struct CombatRng { seed: u32, state: u32 }

impl CombatRng {
    /// Derives the deterministic seed from turn and UTF-16 identifiers.
    pub fn from_turn(turn: u32, attacker_id: &str, defender_id: &str) -> Self {
        let hash = mix_int(0x811C_9DC5, turn);          // FNV offset basis
        let hash = mix_string(hash, attacker_id);
        Self::new(mix_string(hash, defender_id))
    }
}
```

种子 = f(回合数, 攻方 id, 守方 id)，跨平台精确（UTF-16 逐码元混合），初始种子随 `CombatExecution` 进入回放证据，单测钉死参考值（`from_turn(7,"attacker","defender").seed() == 2_280_806_018`）。AI 另有独立 `AiRng`（含 `AiRngTrace` 可审计抽取记录）。**结论：整套系统没有一处调用系统随机源，"同输入序列 → 同结果"由构造保证并由 fixture 测试钉死。**

## 5. AI / LLM 接入

- **全仓库（.rs/.dart/.md/.toml）grep "llm / openai / gpt / chatgpt"：0 个真实命中**（只有 `_pillMinWidth` 之类误匹配）。这个项目**完全没有 LLM**。
- `aonw_ai` 是传统确定性游戏 AI："Deterministic planners using only recipient-safe views and public runtime commands. This crate never mutates canonical state directly and does not contain a simulation reducer. Every plan is revision-bound and execution delegates to the same `LocalRuntime` boundary used by clients."（`aonw_ai/src/lib.rs` 头注释）含 `StrategicPlanner`（效用评估）、`MctsPlanner`（MCTS 战术搜索）、`BaselinePlanner`、`RandomPlanner`、难度/persona/权重 profile。
- **AI 的接入方式仍然值得抄**：AI 是"提交普通命令的玩家"，不是特殊通道——`dispatch_json_with_ai` 注入 `dyn AiTurnDriver`；`advanceAiTurn` 请求必须带 `runtimeProfile`（standard/batterySaver）与命令预算 `MAX_AI_TURN_COMMAND_BUDGET`（`client_protocol/ai_turn.rs` 中超预算直接 `invalid_ai_command_budget` 拒绝）；AI 只看得见 recipient-safe 视图（和人类玩家同样的信息边界，防作弊/防全知）；AI 的命令与结果原样进存档和回放。

## 6. 技术栈、规模、测试

- **栈**：Rust workspace（引擎）+ Dart/Flutter/Flame（主客户端）+ Godot 4 GdExtension（次客户端 + 地图工作台）+ Serverpod（Dart 服务器框架）+ PostgreSQL + C ABI FFI；Make 驱动全部质量门。
- **规模**：引擎 Rust ≈ 155,600 行 / 844 文件；Dart（server/lib + clients/aonw_flutter/lib + packages）≈ 177,200 行；文档 200+ 页（14 份 ADR、40+ 份 parity 审计文档、game-design 契约 21 份）。
- **测试**：339 个 .rs 文件含 `#[test]`/`#[cfg(test)]`；`engine/fixtures/` 111 个规范 fixture；fuzz 目标（`engine/fuzz/`）；架构测试（Python/shell 强制边界规则）；性能门（"All 210 performance workloads remain within unchanged work, allocation and payload ceilings"，engine-quality.md）；服务器集成测试用隔离 PostgreSQL 比对持久化行；发布资格 `make release-check`。质量哲学见 `docs/adr/README.md`："Create an ADR when a change affects authoritative state ownership, determinism, command semantics, persisted or network compatibility, or a native trust boundary."

## 7. 可复用模块清单（对我们的项目）

| 分类 | 能拿到什么 | 出处 |
| --- | --- | --- |
| 核心规则引擎 | "纯核心"纪律：不读时钟/系统随机/IO/表现状态；一切权威输入显式传参；拒绝不改状态；行为指纹 fail closed | ADR 0008、engine-quality.md |
| 适配器接口 | 无状态服务器主机函数签名（state+world+authenticated_actor+command+offset → all-or-nothing outcome）；C ABI/JSON 单协议多前端 | `aonw_server_runtime/src/host.rs`、`client_protocol/mod.rs` |
| 命令协议 | GameIntent/DomainCommand/SystemCommand/DomainEvent 四分法；稳定拒绝码枚举；**AI 走同一命令通道**；命令信封带 revision（乐观并发） | ADR 0003、`application/command.rs`、`transition.rs` |
| 状态存储 | 原子写+备份轮转+恢复矩阵；存档=规范状态+内容身份+event offset+state digest；SQLite 单文件场景可整套照搬该纪律 | engine-persistence.md、`aonw_local_runtime/src/persistence*` |
| 事件流 | DomainEvent + ExecutionEvidence（掷骰证据随事件下发，客户端只播放）；deny_unknown_fields 的严格事件 DTO；单调 offset 投递 | `application/transition/outcome.rs`、`aonw_contracts/src/persistence/event.rs` |
| 随机 | 种子=f(回合,参与者id) 的确定性 xorshift，种子入回放证据 | `aonw_engine/src/combat/rng.rs` |
| 信息隐藏 | RecipientDisclosure：事件/证据按接收者可见性裁剪后再下发，客户端永不拿规范隐藏状态 | `aonw_projection/src/disclosure.rs`、ADR 0008 |
| AI 预算 | AI 回合带命令预算与算力 profile，超限拒绝；AI 只看 recipient-safe 视图 | `client_protocol/ai_turn.rs`、aonw_ai |

## 8. 不适合我们的地方

1. **重武器**：Serverpod + PostgreSQL + Dart FFI + 双 GUI 客户端，是 30 万行级的商业发布工程；我们 1-2 核 / 2-4GB + SQLite 的体量应只借它的**分层纪律**，不借实现。
2. **Rust/C ABI 边界**对我们是过度设计：我们单体 TypeScript/Python 进程内直接调核心即可，等价物是"核心模块不 import 任何框架/IO 模块 + 架构测试强制"。
3. **无 LLM 先例**：它证明不了"LLM 输出如何校验"，这块要看案例 04（WarAgent 的 Secretary 校验回路 + CICERO 的规划器/对话分离）。
4. **无 spectator 模式**：仓库全文 grep "spectator" 为 0。最接近的是只读回放（挂生产 HUD）与 recipient 投影；真正"人类+AI+观战共享一个核心"的形态要在案例 04 的 diplomacy_cicero（webdip 人类对局接入）里找。
5. **Postgres 中心**：它的 offset/事务/投递都压在 Postgres 上；我们用 SQLite(WAL) 时每房间一个库文件反而是更简单的对应物（其本地 `PersistenceFileStore` 的原子写纪律可直接平移）。

## 附：本报告引用的仓库内文件

- `README.md`、`docs/README.md`、`docs/engine-quality.md`、`docs/engine-persistence.md`、`docs/multiplayer-protocol.md`
- `docs/adr/0003-command-boundaries.md`、`docs/adr/0008-engine-ownership.md`、`docs/adr/0013-in-process-engine-host-for-multiplayer.md`、`docs/adr/README.md`
- `engine/crates/aonw_engine/src/application/command.rs`、`application/transition.rs`、`application/transition/outcome.rs`、`combat/rng.rs`
- `engine/crates/aonw_ai/src/lib.rs`、`engine/crates/aonw_flutter/src/lib.rs`、`engine/crates/aonw_godot/src/lib.rs`
- `engine/crates/aonw_server_runtime/src/host.rs`、`engine/crates/aonw_local_runtime/src/client_protocol/{mod.rs,ai_turn.rs}`
- `engine/crates/aonw_contracts/src/persistence/event.rs`、`engine/crates/aonw_projection/src/disclosure.rs`
- `docs/parity/fortified-recovery.md`、`docs/parity/lobby-presence.md`（aonw_core 旧路径残留证据）
