# 案例深挖 02：emergencescience/histrategy（三國志略 / HiStrategy）

> 调研日期：2026-10（基于 main 分支，pushed_at 2026-10-22）
> 仓库：https://github.com/emergencescience/histrategy
> 描述（GitHub API 原文）："LLM narrative strategy games, including Three Kingdoms, Rome and Nanming"
> 基本盘：Python，MIT，34 stars / 10 forks，创建于 2026-05-23，约 206 个 .py 文件（源码+测试约 2.5 MB），108 个 .md 文档
> 调研方式：GitHub API 取全量目录树（484 个路径），经 ghproxy.net 拉取约 70 个关键源文件与文档逐一阅读。所有引文均为原文摘录，标注文件路径。

**为什么它对我们最重要**：它的架构诉求和我们几乎一模一样——数值全部由确定性代码计算、LLM 只做非线性层、SQLite 存储、OpenAI 兼容 API（默认 DeepSeek）、并且它**真的先用纯 LLM 推演数值（V1）撞了墙，又亲手把它下线**，全过程留在文档里。这是我们「禁止 LLM 参与数值计算」这条铁律的最佳实证。

---

## 0. 总览：一张表看懂它的三代引擎

`README-zh.md`「引擎选择」一节原文（这就是业主要找的那张表）：

```markdown
## 引擎选择

| 引擎 | 说明 | LLM | 适用场景 |
|------|------|-----|----------|
| **V1**（已下线） | ~~每回合单次 LLM 调用推演全世界~~ | — | **2026-10-03 移除**（数值幻觉） |
| V2 | 纯确定性公式，零 LLM | 否 | 测试、离线、平衡调校 |
| V3 | 混合：确定性基线 + LLM 非线性层 | 是 | 高级模拟 |

**V3 是默认引擎，无需设置任何环境变量**。只有想强制走确定性引擎（离线/测试）时才设 `HISTRATEGY_ENGINE=v2`。
```

代码级确认，`histrategy/engine/engine_switch.py`（全文仅 49 行）：

```python
class EngineMode(Enum):
    V2 = "v2"  # 纯确定性引擎 — 零 LLM，公式驱动（V3 的基线层）
    V3 = "v3"  # 混合引擎 — V2 确定性基线 + Macro LLM 非线性层 + GuardrailValidator（默认）

def detect_engine_mode() -> EngineMode:
    engine = os.environ.get("HISTRATEGY_ENGINE", "").strip().lower()
    ...
    if engine == "v1":
        logger.warning(
            "HISTRATEGY_ENGINE=v1 已下线（2026-10-03），本次按 V3 运行。"
            " 请在环境变量 / Railway 变量里删掉这一项。"
        )
    return EngineMode.V3
```

该文件 docstring 是 V1 死因的官方定论：

> V1（纯 LLM 全量推演：一次调用让 LLM 产出全部势力的精确数值）已于 2026-10-03 下线 —— **它的失效模式是幻觉而非性能**，且与确定性基线互相冲突。
> 设计文档：emergence-meta/internal/design/2026-10-03-remove-v1-engine.md

（注：这份下线设计文档在他们**私有仓库** emergence-meta 里，公开仓库拿不到，「未找到」。）

仓库是 monorepo，四个包，依赖链 `histrategy-engine → histrategy-sdk / histrategy-agent → histrategy`（README-zh.md）：

```
histrategy/              # 完整游戏：FastAPI 服务器、Web UI、CLI、LLM 层、DB 层
histrategy-sdk/          # 玩家 SDK：Room、DirectEngine（文件存储）
histrategy-agent/        # Agent 集成：TurnProcessor、飞书 IM 适配器
histrategy-engine/       # 核心引擎：WorldState、TurnController、纯确定性公式（零 LLM 依赖）
scenarios/               # 剧本即目录：three-kingdoms / rome-triumvirate / nanming
```

`histrategy-engine` 刻意做成**不 import 任何 LLM 代码**的纯公式包——这个物理隔离值得我们照抄。

---

## 1. 架构分层的真实实现（问题 1）

### 1.1 V3 流水线全貌

`docs/design/v1-v3-engine-design.md` 中 V3 的官方数据流（原文）：

```
QuarterlyEngine (确定性基线)
    ↓  计算 tax/food/pop/morale 变化
BlackSwanInjector (历史事件触发)
    ↓  检查是否符合触发条件
MacroPolicyEngine (LLM 非线性层)
    ↓  综合所有指令 + 确定性基线 + 触发事件
    ↓  生成 narrative + morale_events + territory_capture
    ↓
输出: narrative + state_changes + knowledge_cards
```

设计哲学原文（同文档）：

> "确定性引擎做该做的事，LLM 做它擅长的事"。数值计算由 Python 保证公平性和可审计性，LLM 只做非线性调整（战役叙事、外交博弈、黑天鹅事件）。

`docs/architecture-philosophy.md` 把分工写成了问责表，非常值得直接搬进我们的设计文档：

> **Layer 1 不能错。Layer 2 可以模糊。Layer 3 可以夸张。**
>
> | 场景 | 谁负责 | 为什么 |
> |------|--------|--------|
> | 「进攻宛城」→ 战斗结算 | **引擎** | 必须公平。玩家 A 和玩家 B 打同一仗，结果应该一样 |
> | 战斗结果 → 叙事文本 | **LLM** | 「decisive_victory, casualties=651」→ 需要变成生动的故事 |
> | NPC 是否进攻你 | **引擎** | 曹操 aggression=0.8，你的边境兵力 < 他的 60% → 进攻 |
> | NPC 进攻的理由 | **LLM** | 「丞相料定刘表新得十城，根基未稳…」 |
> | 开发宛城需要多少金 | **引擎** | `150 × 10 × √(50000/1000)` = 公式计算 |
>
> **规则引擎**: 凡是涉及「多少」「是否」「能不能」的问题，引擎回答。
> **叙事引擎**: 凡是涉及「为什么」「感觉如何」「意味着什么」的问题，LLM 回答。
>
> **LLM 是乘法器，不是加法器。引擎是底数。**
> ```
> 好引擎 × 好 LLM = 神作 (100 × 10 = 1000)
> 差引擎 × 好 LLM = 灾难 (1 × 10 = 10)     ← 崇祯
> 无引擎 × 好 LLM = 聊天机器人 (0 × 10 = 0)
> ```

### 1.2 确定性基线：谁在算

**(a) `histrategy/engine/quarterly_engine.py`（684 行）— 季度经济/人口/民心基线。**
参数全部集中在一个 `EconomyParams` dataclass（防滚雪球设计写在 docstring 里）：

```python
@dataclass
class EconomyParams:
    """Tunable economic simulation parameters.
    Calibration target: a mid-sized faction (5 territories, ~125k pop)
    should be able to sustain ~50k troops with a small surplus at 30% tax.
    Design principle: prevent snowballing. ..."""
    base_population_growth: float = 0.003   # per quarter
    base_food_per_soldier: float = 0.005
    food_production_multiplier: float = 0.02
    season_food_multipliers: tuple = (1.0, 1.2, 1.5, 0.3)  # 春夏秋冬
    SEASONAL_PRESETS: ClassVar = {
        "east_asian": (1.0, 1.2, 1.5, 0.3),
        "mediterranean": (1.4, 0.8, 1.1, 0.9),   # 罗马剧本用地中海气候
    }
    base_tax_revenue_per_pop: float = 0.015
    max_tax_rate: float = 0.70
    military_maintenance_per_soldier: float = 0.015
    max_conscript_ratio: float = 0.04
```

核心公式（`execute_quarter()` 内，纯 Python，逐势力循环）：

```python
# 人口
growth = total_pop * p.base_population_growth
tax_mod = max(0.2, 1.0 - (tax_rate - 0.2) * 2)      # 高税抑制增长
morale_mod = 0.5 + morale / 200                       # 高民心加速增长
population_delta = growth * tax_mod * morale_mod

# 税收
revenue = total_pop * p.base_tax_revenue_per_pop * tax_rate

# 粮食（产-耗）
food_consumed = strength * food_per_soldier + total_pop * p.base_food_per_civilian
if season_idx == 3: food_consumed *= 1.3              # 冬季损耗
food_produced += tpop * (dev/100) * (fertility/10) * p.food_production_multiplier
food_produced *= seasonal_mult                        # 季节系数
# 法令效果（数据驱动的政策乘数）
if law in ("屯田制","军屯制","民屯制"): food_produced *= 1.3
elif law in ("盐铁专卖","盐铁官营"):   revenue *= 1.15
```

征兵有**三重上限**：连续征兵疲劳（`fatigue_mult = max(0.3, 1-(streak-1)*0.3)`）、按人口规模递减的动态比例（`dynamic_conscript_ratio`: <5 万人口可征 12%，>60 万只能征 4%）、国库支付能力。军费渐进（每超 10 万兵 +50% 维护率）、占领区治理费（核心 3 城以外每城 200 金/季）——都是「防滚雪球」的确定性设计。

签名即接口边界：

```python
def execute_quarter(self, world_state: WorldState, policy_commands: list,
                    year: int, quarter: int) -> QuarterResult
```

`QuarterResult` 是纯 dataclass：`tax_revenue / food_delta / population_delta / morale_delta: dict[str, float]`、`notable_events: list[str]`、`battles: list`、`resource_changes: dict`。**这个对象就是"确定性基线"交给 LLM 层的合同**（见 1.3）。

**(b) `histrategy-engine/src/histrategy_engine/`（七引擎）**：Map（A* 寻路）、Character（忠诚/自然死亡）、Domestic（粮/税/人口/气候）、Military（兰彻斯特方程战斗）、Decision（NPC 权重决策树）、History（引力事件）、Narrative（唯一 LLM 位）。`demo/show-hn-v2-final.md` 原表：

```
| Map | Terrain, supply lines, chokepoints | A* pathfinding |
| Domestic | Food, population, tax, climate | YAML formula + seeded RNG |
| Military | Recruitment, supply, combat | Lanchester equations |
| Decision | NPC behavior | Weighted decision trees (Cao Cao: aggression=0.8) |
| Narrative | Story generation | **LLM (read-only, cannot modify state)** |
```

**(c) 固定随机种子（可复现的关键）**，`histrategy-engine/src/histrategy_engine/domestic/__init__.py`：

```python
def _seeded_random(seed: str) -> random.Random:
    """Create a seeded RNG that cannot be injected by player input."""
    seed_hash = hashlib.sha256(seed.encode()).digest()
    seed_int = int.from_bytes(seed_hash[:8], "big")
    return random.Random(seed_int)

class ClimateSystem:
    def roll_climate(self, territory, season, year, turn) -> ClimateEvent:
        """Uses a hash of (territory_id, year, season, turn) as seed.
        Players cannot influence this — no LLM, no free text injection."""
        seed = f"climate:{territory.id}:{year}:{season.value}:{turn}"
        rng = _seeded_random(seed)
        # 按 (climate_zone, season) 查概率表做加权抽取
```

同一 (地块,年,季,回合) 永远得到同一气候事件——确定性、可重放、且玩家文本无法注入。知乎文（demo/zhihu-v2-final.md）的说法：「气候系统用 `sha256(territory:year:season:turn)` 做 seeded RNG……这些都是纯数学——写一个测试，它就永远是绿的。」

### 1.3 LLM 非线性层：负责什么、接口长什么样

**负责的事**（`histrategy/llm/prompts/world_simulator.md` 系统提示词原文）：

> 4. **你是非线性推演官，不是公式计算器。** 确定性引擎已经算出了 baseline（基础粮食产量、税收、基本战斗结果）。你的价值在于推演那些公式算不出来的东西：
>    - 攻城策略的心理博弈（守军会投降吗？还是死战？）
>    - 民心/士气的涌现效应（哗变、投敌、自发献粮）
>    - 宫廷政治（派系斗争、谏言、政变）
>    - NPC 的战略判断（刘备会守新野还是南撤？孙权会北伐还是坐观？）

以及明确的**数值禁区**（同文件「禁止事项」）：

> - ❌ 不要让已死亡的人物复活
> - ❌ 不要凭空创造新的武将或势力
> - ❌ 不要让兵力在无招募的情况下增加（但NPC可以自行招募）
> - ❌ 不要让粮草在无生产/贸易的情况下增加
> - ❌ 不要一回合内摧毁一个势力（除非该势力已经只剩一城且被围攻）
> - ❌ 不要直接输出最终叙事——只输出 structured JSON

**函数签名（接口边界）**，`histrategy/engine/macro_policy_engine.py`（330 行）：

```python
class MacroPolicyEngine:
    """LLM-driven quarterly historical simulation."""
    def simulate(
        self,
        world_state: WorldState,
        policy_commands: list,        # 所有势力（人类+NPC）的结构化命令
        player_decision: str,         # 玩家原始自然语言
        baseline: QuarterResult,      # ← 确定性基线，作为只读输入
        history_events: list[dict] | None = None,
        turn_memory: list[dict] | None = None,
        epoch_memory: list[dict] | None = None,
        room_id: str = "",
        quarter_number: int = 0,
    ) -> dict:                        # 结构化 delta；LLM 不可用时返回 {}
```

**输出 JSON schema**（写死在 `macro_policy_engine.py` 的 `OUTPUT_SCHEMA_HINT` 常量，拼进 system prompt）：

```
仅输出{battle_results,npc_faction_actions,morale_events,political_events}四个字段。
禁止输出knowledge_cards/black_swan/narrative_seeds/diplomatic_reactions等额外字段。

## npc_faction_actions
[{"faction":"cao","action_type":"develop|diplomacy|tax|declare_war|none","target":"shu",
  "reason":"...","params":{},"narrative":"曹操命..."}]
注意：NPC征兵由游戏引擎自动根据士气+人口计算，LLM无需生成conscript动作。

## battle_results
[{"location":"xinye","attacker":"cao","defender":"shu",
  "result":"attack_win|defend_win|stalemate|rout","territory_captured":true,"narrative":"..."}]

## morale_events
[{"faction":"shu","change":5,"reason":"...","territories_affected":["xinye"]}]

## political_events
[{"faction":"cao","type":"court_intrigue|reform_feedback|succession|factionalism",
  "description":"...","effects":{"character_loyalty":{"xunyu":-5}}}]
```

更早的战斗级版本 `histrategy/llm/world_simulator.py` 的 schema（world_simulator.md）字段为 `battle_overrides / morale_events / political_events / npc_faction_actions / narrative_seeds`，其中 battle_override 要求 LLM 带上 `baseline_result`、`reasoning`、`casualties`、`captured_characters/escaped_characters`——**LLM 的每次改判都必须给出理由并落盘审计**。

**关键设计：LLM 的上下文里，基线结果是"既成事实"**。`MacroPolicyEngine._build_context()` 把确定性引擎算好的数字直接印给 LLM：

```python
lines.append("## 确定性经济基线")
for fid in ws.factions:
    tax  = getattr(baseline, "tax_revenue", {}).get(fid, 0)
    food = getattr(baseline, "food_delta", {}).get(fid, 0)
    ...
    lines.append(f"- {fid} ({fname}): 税收+{tax:.0f}, 粮草{food:+.0f}, 民心{morale:+d}, 人口{pop:+.0f}")
```

还有针对 LLM「无视软规则」的工程补丁——财政危机警报（H36b-fix 注释原文）：

```python
# H36b-fix: The macro_simulator_zh.md already has a "金库为0的势力应当收缩防御"
# rule, but the LLM ignores it without per-faction explicit warnings.
if treasury <= 0:
    treasury_crisis_factions.append(
        f"🚨 **{f.name}({fid})**：金库=0！兵力={strength}。不可进攻、不可征兵。...")
```

教训：**光在 system prompt 里写规则不够，必须把违规后果按势力逐条塞进 user context**。

### 1.4 裁决层：LLM 说了不算

`histrategy/engine/state_applier.py`（804 行）是把 LLM delta 落到世界状态的唯一通道，docstring 一句话点题：

```python
def _settle_battle(br: dict, ws, fmap: dict, tmap: dict, summary: dict) -> None:
    """Settle one battle_results entry against scalar faction strength.

    Force-ratio grounded: the LLM narrates, but Python decides how many
    troops die and whether a city actually changes hands.
    """
```

三层硬裁决（全部真实代码）：

1. **伤亡混合钳制**——LLM 给的伤亡数只作为"提示"，与确定性值平均，且被钳在确定性值的 [0.5×, 1.5×]：

```python
def _blend_casualty(deterministic: int, llm_hint: int) -> int:
    """Average deterministic + LLM hint, clamped to [0.5×, 1.5×] deterministic."""
    if llm_hint <= 0: return deterministic
    lo, hi = int(deterministic*0.5), int(deterministic*1.5)
    return max(0, (deterministic + _clamp(llm_hint, lo, hi)) // 2)
```

2. **城池易手由确定性兵力比裁决，LLM 的 result 字符串根本不是门**（P4 注释原文）：

```python
# ── Territory capture: decided by DETERMINISTIC force ratio + morale ──
# The physics engine is the authority (P4 — fairness): territory changes
# hands when the attacker has local superiority OR the defender's morale
# collapses. The LLM's narrative "result" string is NOT a gate — it uses a
# different vocabulary (decisive_victory/crushing_defeat/...) that never
# matched the old hardcoded ("attack_win", "rout") check, which silently
# vetoed every capture and froze the map into a permanent stalemate.
force_permits   = a_pow > d_pow * _TERRITORY_CAPTURE_POWER_RATIO
morale_collapse = d_mor < _MORALE_COLLAPSE_THRESHOLD
capture_authorized = force_permits or morale_collapse
adjacency_ok = _attacker_borders_territory(atk, loc, ws)   # 邻接硬校验，含跨海港口规则
```

其中有效战力 = 兵力 × 士气系数（`α = 0.5 + morale/170`，兰彻斯特系数）× 守方地形加成。

3. **确定性真相回写审计记录**（P0-1 注释原文）——防止「战报说僵持、城池却易手」的记录/状态脱节：

```python
# ── P0-1: write the DETERMINISTIC outcome back into the record ──
# The LLM narrates (result: "stalemate" etc.) but Python decides capture.
# Without this write-back, quarter_turn.macro_delta persists the LLM's raw
# fiction while the world state moved — ... 战报与状态永久脱节.
br["territory_captured"] = captured
br["settled"] = {"captured": captured, "reason": reason,
                 "attacker_losses": atk_loss, "defender_losses": def_loss,
                 "power_ratio": round(ratio, 3)}
```

4. **全局极值钳制**，`histrategy/server/room_manager.py::_clamp_extreme_changes`：

```python
_MAX_TROOP_LOSS = 0.35   # Max 35% per-quarter troop loss
_MAX_TROOP_GAIN = 0.50   # Max 50% per-quarter troop gain (was 300%)
_MAX_FOOD_LOSS  = 0.40
_MAX_FOOD_GAIN  = 1.00
```

注释里还记录了一次真实事故复盘：旧的"按最大涨幅者全体缩放"算法导致「一个 1500 人的小势力涨了兵，最后是元老院和埃及被砍掉一半兵力」，2026-10-04 改为 per-faction 独立钳制。**谁超限就压谁，互不牵连**——这条对我们做多房间数值护栏很有参考价值。

### 1.5 输入侧：自然语言 → 结构化命令

- `histrategy/parser/intent.py`（970 行）`IntentParser`：一次轻量 LLM 调用把玩家自由文本解析成 `Command` 列表；**无 LLM 时有关键词兜底**（docstring: "Keyword-based fallback when no LLM is available"）。剧本级 prompt 覆盖：`scenarios/{id}/prompts/intent_parse.md` 追加到默认 prompt 之后；输出硬限制「总输出不得超过 2000 字符」「仅输出 JSON」。
- `histrategy/policy/policy_types.py`：命令类型是 **frozenset 白名单**（`tax_rate/law/appoint/diplomacy/declare_war/sue_peace/relocate_capital/intelligence/develop/trade/conscript/military_posture` 共 12 种），`PolicyCommand.__post_init__` 对未知类型直接 `raise ValueError`；`REQUIRED_PARAMS/OPTIONAL_PARAMS` 两张表驱动参数校验，未知参数也报错。
- `histrategy/parser/validator.py` `CommandValidator`：物理可行性校验（征兵 ≤ 城池人口 5%、税率 ∈ [0.05,0.6]、攻击目标必须可达且非己方、develop 必须己方领土且国库够钱），**"Invalid commands are silently dropped"**。
- `histrategy/policy/policy_validator.py` `PolicyValidator`：外交目标存在性、 faction id 归一化（"刘表(liubiao)"→"liubiao"），非法命令不丢弃而是打 `[VALIDATION: ...]` 标记回显。

知乎 v2 文（demo/zhihu-v2-final.md）对输入侧防注入的总结：

> 玩家说的「风调雨顺」四个字在系统里找不到任何匹配命令——直接丢弃，不影响游戏状态。这样既保留了自然语言输入的自由度，又防止了 LLM 幻觉注入。

---

## 2. V1 → V2/V3 演进与「数值幻觉」失败教训（问题 2）★核心

### 2.1 官方演进时间线（docs/ROADMAP.md §1.1 原文全录）

```
v0.1 (2026-05)  "LLM is the engine"
  └── LLM handles everything: narration + numbers + NPC + events
  └── Problem: LLM hallucination breaks fairness (粮食翻倍, 兵力凭空出现)
  └── Lesson: LLM as engine ≠ reliable engine

v0.2 (2026-05)  "LLM + Offline Fallback"
  └── Added offline_sim.py for rule-based simulation when LLM unavailable
  └── Plan/Command dual-mode architecture (strategic intent vs execution)
  └── Problem: Two code paths, inconsistent results
  └── Lesson: Fallback ≠ foundation

v0.3 (2026-06)  "Engine First, LLM as Narrator"
  └── Core insight: "LLM is the multiplier, not the base"
  └── Three-layer accountability model:
      Layer 1 (Hard Engine, Python) — MUST be correct (physics, combat, economy)
      Layer 2 (Soft Rules, YAML)   — CAN be fuzzy (morale, loyalty, events)
      Layer 3 (LLM Narrative)      — MAY be dramatic (story, dialogue, atmosphere)
  └── Lesson: Correct architecture, but execution gap (17 docs vs empty character data)

v2.0 (2026-06)  "Seven-Engine Architecture"
  └── Modular engines: Map, Character, Domestic, Military, Decision, History, Narrative
  └── Rules-as-Data: YAML configuration replaces hardcoded Python logic
  └── histrategy-engine (pure Python, zero LLM) + histrategy-knowledge (pure data)
  └── Current status: playable at emergence.science, 459 tests, 9 real users
```

注意 v0.2 的教训「**Fallback ≠ foundation**」（兜底不能当地基）：他们先做的是"LLM 为主 + 离线规则兜底"，发现两条代码路径结果不一致，才反转成"规则为主 + LLM 增强"。这正好回应我们"LLM 输出经规则引擎校验"的定位——校验器必须是主路径的一部分，不是备胎。

ROADMAP §1.2 核心设计原则表（原文）：

| Principle | Description |
|-----------|-------------|
| **Engine 不能错** | 粮食=种植面积×产量×气候。这是物理定律，不容 LLM 篡改。 |
| **Rules 可以调** | 忠诚度衰减速率、税率对民心的影响 — 这些用 YAML 配置，社区可贡献。 |
| **Narrative 可以夸张** | "诸葛亮妙计退兵" — LLM 可以渲染气氛，但不能凭空创造兵力。 |
| **History as Gravity** | 历史事件有"引力值"(gravity)。结构性矛盾事件（如荆州地缘冲突）引力极高，个人决策难以改变。 |
| **Rules are Data, not Code** | 加一个合法性系统：v1 改 4-6h Python；v2 写 2 个 YAML 文件 15 分钟。 |
| **正史优先，演义可选** | 数据源优先级：《三国志》裴注 > 《资治通鉴》 > 《后汉书》 > 《三国演义》。 |

### 2.2 竞品复盘：崇祯模拟器与光荣（ROADMAP §1.3 原文全录）

```
**From 《崇祯模拟器》 (2026-05)**:
- ✅ Validated the market: players will pay for LLM historical strategy games
- ✅ LLM narrative immersion is powerful — we should aim for this quality
- ❌ Pure LLM architecture → fairness issues (AI says "圣明" but tax is 90%)
- ❌ Locked API + Token monetization → 55% Steam approval, massive backlash
- **Takeaway**: 崇祯不是"错误的架构"——是"极端的架构"在"错误的商业模式"上执行

**From 光荣《三国志》11/14**:
- ✅ Complete economic cycle (金→兵→战→地→金) — we need this
- ✅ ROTK 11 survived 20 years because of MOD community — our YAML rules market can surpass this
- ❌ Hardcoded engine, limited modding → our Rules-as-Data beats this
- ❌ No natural language, no narrative depth → our LLM layer fills this gap
```

两条对我们的直接启示：(1) 经济闭环「金→兵→战→地→金」被他们列为必须项，我们的资源系统也应先画这个环；(2) 「锁 API + Token 计费」的商业模式本身就是翻车原因之一——我们 BYOK/自控 key 的路线避开了它。

### 2.3 数值幻觉的具体表现（三处独立证据）

**证据 A — demo/zhihu-v2-final.md（v2 发布文《我放弃了让大模型当游戏引擎，转而写了 239 个单元测试》）**，标题即结论。三大失效模式原文：

> 1. **幻觉注入**：玩家随口说「今年风调雨顺」，LLM 可能当真，凭空给粮食产量加 30%。你可以用话术骗过裁判。
> 2. **偏向玩家**：LLM 知道谁是「用户」，天然倾向让玩家的决策成功。我测试时发现，同样兵力对比下，玩家方的胜率比 NPC 方高出 20-30%。
> 3. **不可复现**：同样的输入产生不同的输出。无法写测试、无法做平衡、无法回答「这个机制到底对不对」——因为每次答案都不一样。
>
> 这就像让一个口才极好但不懂数学的人去当足球裁判。场面很好看，但比分不靠谱。
> 而且更致命的是——**一旦玩家发现可以「话术骗过裁判」，游戏的策略深度就归零了。**

**证据 B — docs/design/state-complexity-vs-llm-hallucination.md（2026-06-14 设计决策文档）**，记录了真实线上事故：

> 在 V1 纯 LLM 引擎的实际运行中（room d4a512fb），孙权势力 Q2 人口显示为"十八万三千"（183,000），而江东在 207 年的实际人口应约 200 万（含编户齐民）。……暴露了一个更深层的问题：**LLM 在处理多个精确数值变量时容易产生幻觉、累积误差和不一致。**

其核心矛盾表（原文）：

| 维度 | 理想状态 | LLM 现实 |
|------|---------|---------|
| 变量数量 | 越多越真实 | LLM 上下文越复杂，幻觉概率越高 |
| 数值精度 | 精确到个位数（兵力 145,382） | LLM 不擅长精确算术，四舍五入、符号错误频发 |
| 一致性 | 跨回合自洽 | LLM 缺乏全局状态追踪，跨回合漂移 |

> **这不是模型能力问题，而是架构匹配问题。** GPT-4 / DeepSeek-V4 是语言模型，不是数值模拟器。让 LLM 同时担任"数值引擎"和"叙事引擎"违反了关注点分离原则。

当前问题四类（原文表）：**变量过多**（LLM 需同时追踪 5+ 个独立数值变量）、**跨变量一致性**（"增兵 5000 但人口不变"——LLM 不理解变量间约束）、**跨回合漂移**（"Q5 的人口与 Q1 人口无因果关联"）、**精度幻觉**（"183,000 vs 350,000 vs 2,000,000"）。

该文档还调研了 CK3 / Total War / Civ VI 的状态抽象，提炼出三条规律（对我们设计状态 schema 极有价值）：

> 1. **越成功的策略游戏，数值变量的独立维度越少。** CK3 只有"发展度"一个宏观指标，其余全是派生。
> 2. **离散 > 连续。** "3 级城池"比"人口 183,421"更稳健。
> 3. **LLM 调参数，代码算结果。** LLM 决定"税率降低"，代码算出"税收 = 税率 × 人口基数"，互不污染。

并给出提案：给 LLM 看**分层标签**（人口 Tier 0-5「凋敝/稀少/中等/殷实/富庶/鼎盛」+ 等效兵力指数 0-1000），精确值只留在代码侧；LLM 输出**变化率/趋势**而非绝对数。风险表里那句立场声明值得记住：

> | 增加代码复杂度，V1 的"纯 LLM 哲学"被稀释 | **这是有意的哲学转变：LLM 是决策引擎，代码是计算引擎** |

**证据 C — room_manager.py 里的补丁化石**。V1 时代 LLM 连"记得更新数值"都做不到，`_apply_deterministic_economy` 的 docstring：

```python
"""Bug H35b: Apply deterministic tax revenue and military upkeep per quarter.
V1 simulation relies solely on LLM output for economy changes. The LLM
often ignores or forgets to update treasury and food, causing them to
stay nearly frozen across turns. ..."""
```

即：纯 LLM 推演下国库和粮草**跨回合几乎冻结不动**——LLM 输出 JSON 时经常漏字段。这是"数值幻觉"之外更隐蔽的"数值惰性"。

### 2.4 V1 的多房间服务端形态与延迟灾难（docs/design/v1-v3-engine-design.md + docs/design/v1-latency-strategic-analysis.md）

值得注意：他们其实做过一版**和我们目标形态几乎一样的东西**——V1/V3 共享同一 SQLite schema（`game_state/turn_delta/policy_state`），FastAPI 多房间，前端 `engine_mode` 切换 A/B。V1 规格：

> ### V1 简化原则
> 1. **不做战争迷雾** — 所有势力信息完全公开
> 2. **不做分步仿真** — 一次 LLM 调用完成所有势力状态更新
> 3. **状态是 JSON blob** — 不固定 schema，LLM 自由输出
> 4. **不做 Guardrail 验证** — 信任 LLM 输出（V1 就是用来测试 LLM 靠谱程度的）
> 5. **不做 Battle 子系统** — 战争结果由 LLM 直接叙述
> 6. **max_tokens=16384**

延迟分析文档（2026-06-18）实测：

> **User-facing latency: 60-100s** for a 3-faction scenario. With timeout+retry, worst case is 260s before fallback.
>
> | Problem | Impact |
> | **Zero visibility** | User stares at spinner for 100s |
> | **Single point of failure** | One bad JSON parse → entire turn wasted, fallback to heuristic |
> | **Retry = double pain** | Timeout at 130s → retry → 260s total |
> | **Overloaded prompt** | Too many responsibilities → LLM quality degrades on each |

诊断结论原文：

> **State computation** | Arithmetic/logic | Needs thinking? **No** | Can be parallel? Yes
> **Narrative generation** | Creative writing | Needs thinking? Yes | Can be parallel? No
> The fundamental insight: **you can play the game knowing only the state numbers. The narrative is flavor that can arrive later.**

修复方案就是两阶段：Phase 1 状态结算用 V3 确定性引擎（<1s），Phase 2 叙事异步流式补发（30-60s，SSE）。预期指标表：Time-to-playable 60-100s → **<2s**；成功率 ~80% → **>95%**。V1 vs V3 对比矩阵里 V1 的「公平性：低（LLM 可能偏袒某方）」「可审计性：低（黑盒）」「生产就绪度：低」。

**最终结局**：两阶段方案实际上等于宣判 V1 死刑——Phase 1 换成确定性引擎后，V1 只剩叙事功能，2026-10-03 整个 V1 被移除（engine_switch.py）。`v1_simulator.py`、`api_v1.py`、`prompts/v1_simulator.md` 已从 main 分支删除（当前目录树中不存在，仅在 state-complexity 文档中留下引用）。

### 2.5 对照：V1 时代的宣传文（publications/2026-05-25-introduction/）

`emergence_article.md`（2026-05-25，V1 时期）当时还在 자랑纯 LLM 架构，与四个月后下线形成完整闭环，摘录：

> 本文提出了一种全新的大语言模型（LLM）驱动的历史策略仿真引擎设计模式。该引擎将大模型直接作为世界的"物理仿真大脑"，摒弃了传统的硬编码剧情树……
> 《三國志略》的成功实践证明，将大模型作为规则生成器和仿真引擎，可以赋予传统历史策略游戏更广阔的生命力……

`zhihu_post.md`（同日）：

> 我们彻底移除底层的所有剧情模板，让大模型（特别是推理模型 DeepSeek）直接作为游戏的"物理引擎"与仿真引擎。
> 在《三國志略》中，大模型不再是只负责说两句漂亮话的"气氛组"，它是**世界本身**，负责推演万物运转的因果律。

其中成本测算（当时口径）：单回合 2,000-4,000 tokens，¥0.0004/回合，100 回合 < ¥0.05。**注意：成本从来不是 V1 的死因（便宜得很），死因是幻觉、偏向、不可复现、延迟。** 这对我们很重要——不要以为"token 便宜就能让 LLM 算数值"。

`game_master.py` 顶部 docstring 仍保留 V1 哲学化石：`"""The LLM IS the game engine. No templates. No hardcoded content."""`（该文件现仅用于单机 CLI 的 Plan/Command 模式，服务端数值路径已不走它。）

### 2.6 演进小结（给我们的教训清单）

1. 纯 LLM 推演数值的四种病：**幻觉**（人口 18 万 vs 200 万）、**注入**（话术改天气）、**偏向**（玩家胜率 +20-30%）、**惰性**（漏更新字段→数值冻结）；外加**不可复现**导致无法测试/调平衡。
2. 兜底（offline fallback）救不了架构——两条路径结果不一致，"Fallback ≠ foundation"。
3. 正确顺序：先建确定性引擎并通过全量单测（459 个），再把 LLM 作为**增强层**叠上去，且 LLM 输出必须过 Guardrail + StateApplier 双重裁决，硬约束违反→整体丢弃回退基线（docs/design-v3-llm-simulation.md §6："确定性引擎永远是 fallback。v3 是 v2 + LLM 增强层，不是 v2 的替代"）。
4. LLM 上下文里不要放太多独立精确数值；放**基线结果 + 分层标签**，收**趋势/delta**，绝对值由代码算。
5. 反偏向要靠结构性手段（NPC 与玩家命令同构、prompt 显式纠偏、baseline 锚定、审计日志），不能靠模型自觉。design-v3-llm-simulation.md §5 原话：「NPC 命令和玩家命令格式完全相同——都是 `Command(type, params, notes)`。LLM 在模拟时不对玩家和 NPC 做区分处理。」

---

## 3. 配置驱动 / 数据解耦（问题 3）

### 3.1 目录约定：一个剧本 = 一个自包含目录

`histrategy/engine/scenario_loader.py` docstring（原文）：

```
scenarios/{scenario_id}/
    scenario.toml          — engine & faction config
    knowledge/
        territories.json   — map territories
        factions.json      — faction definitions (array or dict)
        characters.json    — character roster
        events.json        — scripted/historical events
        initial_state.json — full initial WorldState snapshot
    prompts/
        system.md          — system prompt template
        ...
    rules/
        *.yaml             — rule configuration files
```

实际三个剧本（three-kingdoms / rome-triumvirate / nanming）都遵循此结构，外加 `roster.json / timeline.json / arc_goals.json / regions.json`、分语言 prompts（`macro_simulator_zh.md / _en.md`、`narrative_zh/_en`、`npc_decision_zh/_en`）、以及**预烘焙 NPC 决策** `npc_decisions_q0/q1/q2.json`。

### 3.2 scenario.toml（scenarios/three-kingdoms/scenario.toml 全文要点）

```toml
[meta]
id = "three-kingdoms"
legacy_id = "207"          # 向后兼容
start_year = 208
[engine]
default_version = "v3"     # v1=纯LLM, v2=rule-based, v3=混合
quarter_per_year = 4
turn_timeout_human = 300   # 人类玩家决策超时（秒）
turn_timeout_ai = 120
max_quarters = 60          # 终局条件
[factions]
available = ["cao", "shu", "wu"]
major_npc = ["cao", "shu", "wu"]       # 独立 LLM 决策
minor_npc = ["liu_biao", "yuan_shao", "yuan_shu", "dongzhuo", "other"]  # 启发式
default_player_faction = "shu"
[knowledge]
factions_file = "factions.json"
characters_file = "characters.json"
... (9 个数据文件全部可配置)
[llm]  # 可选覆盖 model/max_tokens/temperature
```

### 3.3 knowledge JSON 的 schema

有正式 JSON Schema（draft 2020-12）：`histrategy/knowledge/data/schema.json`（202 行）定义 `Character / Faction / Region / HistoricalEvent` 四个 definitions；`schema.md` 是逐字段人读版（含约束与示例）；`histrategy/knowledge/scripts/validate_data.py` 做 CI 校验。举例 Faction 必填字段：

```
required: ["id","name","ruler_id","color","description","capital",
           "starting_territories","strength","economy","morale",
           "intel_level","aggression","diplomacy_tendency"]
diplomacy_tendency: enum ["hostile","neutral","calculating","friendly","pragmatic","arrogant","defensive"]
```

ROADMAP 里的知识库贡献格式（带史源标注，呼应「正史优先」）：

```yaml
# characters/guan_yu.yaml
id: guan_yu
name: 关羽
source: "三国志·关羽传"
stats: {leadership: 92, might: 95, intelligence: 65, politics: 40, charisma: 88}
personality:
  weakness: "刚而自矜，以短取败"  # 陈寿原评
```

### 3.4 规则即数据（Rules-as-Data）

数值公式参数在 YAML：`scenarios/three-kingdoms/rules/economy.yaml`（实收）示例：

```yaml
food:
  base_per_territory: 500
  pop_contribution_rate: 0.02
  season_mult: {spring: 0.4, summer: 1.0, autumn: 1.3, winter: 0.3}
tax:
  min_rate: 0.10
  max_rate: 0.50
  morale_thresholds:
    - {rate: 0.10, morale_delta: 2}
    - {rate: 0.50, morale_delta: -3}
  corruption_base: 0.05
population:
  growth_rate: 0.005
  starvation_rate: 0.03
```

由 `histrategy-engine/src/histrategy_engine/rules/interpreter.py` 解释执行；`historical_events.yaml / military.yaml` 同理。ROADMAP 的量化卖点：「加一个合法性系统：v1 改 4-6h Python；v2 写 2 个 YAML 文件 15 分钟」；社区贡献四级模型中 Level 2/3（历史数据、规则修改）零代码。

### 3.5 「加新剧本不改代码」——**打折的真实情况**（重要！）

加载链路确实是通用的：`ScenarioLoader` 用 `tomllib` 读 scenario.toml → 按 `[knowledge]` 配置逐个加载 JSON → 映射到 `histrategy_engine.world` 的 dataclass（FactionState/Territory/Character/Army/WorldState）；prompt 按 `scenarios/{id}/prompts/*.md` 优先、缺省回退内置默认（`macro_policy_engine.py::_load_macro_prompt` 的 candidates 列表）；气候按 `EconomyParams.SCENARIO_CLIMATE` 映射预设。**但是**：

```python
# scenario_loader.py
def _validate_scenario_id(scenario_id: str) -> str:
    if scenario_id not in ("three-kingdoms", "rome-triumvirate", "nanming"):
        raise ValueError(f"Unknown scenario {scenario_id!r}. ...")
```

剧本 ID 白名单**硬编码**在代码里（loader.py 里还有一份 `_CANONICAL_SCENARIO_IDS` frozenset），气候映射 `SCENARIO_CLIMATE` 也是硬编码 dict。所以"加新剧本"实际 = 建目录 + 写 9 个 JSON + toml + prompts + 改 2-3 处白名单。这提醒我们：**如果承诺配置驱动，剧本发现应该做成扫描目录而不是白名单**——他们自己也没做干净。

---

## 4. 回合流程 / 状态机（问题 4）

### 4.1 一个回合（一季）的完整管线

服务端主入口 `histrategy/server/room_manager.py`（3378 行）`_resolve_and_advance()` → `_resolve_v2_or_v3()` → `histrategy/engine/quarterly_resolver.py`（1378 行）`QuarterlyResolver.resolve()`。resolve() 的步骤编号是代码里原文注释，抄录如下：

```
Step 1   解析所有势力决策（AI 已预解析；人类 → intent 缓存命中 or 同步 LLM intent_parse）
Step 1.5 从 DB 加载已有政策到 faction.policies
Step 2   确定性基线（TurnController/QuarterlyEngine → QuarterResult）
Step 2.5 NPC 结构化征兵/裁军结算（带 3%/2% 人口上限、15% 裁军上限等钳制）
Step 2.6 国库枯竭惩罚（0 金 → 士气流失/逃兵/崩溃，H35z3）
Step 3   黑天鹅/历史事件（HistoryEngine.check_events + apply_event_effects）
Pre-sync 兵力对账：strength_actual = max(deployed, reserve)（修双重计数 bug H37d）
Step 4   LLM 宏观模拟（MacroPolicyEngine.simulate，V3 only）
Step 5   GuardrailValidator.validate → sanitized_delta → StateApplier.apply_macro_delta
Step 5.3 从 delta 提取政策持久化到 policy_state 表
Step 5.6 意图校验警告回显进叙事（"⚠️ 军师来报：…"，H38c）
Step 5.5 再次兵力对账
Step 5.7 _clamp_extreme_changes 全局钳制（H39b：必须在叙事生成之前，否则叙事报旧数）
Step 6   分势力叙事生成（可 skip → SSE 流式补发，~22s 的 LLM 调用移出关键路径）
Step 7   状态收集 _extract_state_changes
Step 7.5 季节推进安全网（防双重推进/漏推进）
Step 7.6 max_quarters 终局检查 → game_over 结论
Step 8   回合摘要 _build_turn_summary
```

回合外围（room_manager）：resolve 返回后**后台守护线程**做两件事——(a) 流式模式下后台生成真实叙事并写回 DB（`_bg_generate_narrative`）；(b) **预生成下一季所有 NPC 决策**（`_bg_pregen_next_npc`，注释原文："This is ~30-40s of LLM latency that used to block the /command response. Moving it off the critical path lets it overlap with the human's think-time"）。竞态处理写得很细：worker 自己负责 `_try_save`，若 pod 重启则 `_get_room` 安全网同步重触发，"Worst case == old behavior; best case saves ~30s"。

多人对称：`docs/design/symmetric-multiplayer-engine.md`（未逐行读）+ 代码中 NPC 与人类走同一 `DecisionResult{decision_text, commands}` 通道，全员提交（或超时，人类 300s / AI 120s，scenario.toml）才 resolve。

### 4.2 状态存储

**SQLite（WAL）或 Postgres**，`histrategy/db/connection.py`：

```python
# sqlite:///path/to/db  → SQLite3 (Python stdlib, zero install)
def _get_sqlite_connection():
    """Create SQLite3 connection with WAL mode and foreign keys."""
```

schema（`histrategy/db/schema.sql`，138 行，SQLite/PG 双兼容，全 TEXT UUID）六张表：

- `game_room`：房间头 + **world_state 全量 JSON blob** + slots JSON + phase（lobby/…）+ quarter_number + engine_version + turn_summaries。存档=这一行。
- `quarter_turn`：每季度完整记录——`faction_decisions / baseline_result / macro_delta / narratives / state_changes / token_usage` 全部 JSON 列。**baseline（确定性）与 macro_delta（LLM）分开存**，天然可审计。
- `game_state`：每季度×每势力状态快照（population/troops/food/treasury/morale/territories/policies），`UNIQUE(room_id, quarter_number, faction_id)`。
- `turn_delta`：**逐项增量+原因+来源**——`delta_type / old_value / new_value / delta / reason("屯田制+5%","战争伤亡-2000") / source('deterministic'|'llm'|'black_swan')`。这就是可审计性的落点，强烈建议照抄。
- `policy_state`：政策生效/撤销记录（UNIQUE 防重复生效）。
- `llm_call_log`：每次 LLM 调用的 provider/model/五类 token 数/latency_ms/error/response（system prompt 只存类型不存全文，控体积）。

另有文件层：SDK `Room`/`DirectEngine` 用纯文件存储（README-zh："游戏状态存于磁盘。Agent 上下文重置不丢进度。`Room.load(名称)` 即可恢复"）；`TurnMemory`（state_applier.py 内）用 JSONL 存最近回合叙事记忆 + persistent effects，`get_recent_turns(room_id, n=5)` 注入 LLM 上下文；`log_exporter.py` 支持导出。

### 4.3 存档 / 重放 / 种子

- **存档**：world_state JSON blob 每回合落库，`_try_save` + 快照原子性有专门测试（scripts/test_p02_snapshot_atomic.py）；房间完整性审计脚本 scripts/room_integrity_audit.py。
- **重放/审计**：quarter_turn 逐季全量记录（决策、基线、LLM delta、叙事、token），turn_delta 逐字段带 reason+source——事后可完整重建"这个数为什么变成这样"。
- **固定种子**：气候等随机全部走 `_seeded_random(sha256(...))`（见 1.2c），战斗/经济公式无随机。未见全局 `--seed` CLI 参数（未找到），但因为随机源都是内容寻址的 hash，等价于天然可复现。

---

## 5. LLM 调用层（问题 5）

### 5.1 SDK/协议：httpx 直连 OpenAI 兼容端点，多 Provider 自动探测

`histrategy/llm/adapter.py`（1122 行）`LLMAdapter`——**不用 openai SDK**，`httpx.Client(base_url=..., headers={"Authorization": f"Bearer {key}"}, timeout=180)` 直接 POST `/chat/completions`。Provider 优先级表 `PROVIDER_CONFIGS`：doubao(火山方舟，`thinking:{"type":"disabled"}` 关推理加速) > deepseek > gemini > openai > tongyi > openrouter；三路探测（专用 key → 通用 `LLM_API_BASE+LLM_API_KEY+LLM_MODEL` → 无 key 离线模式）。对我们（DeepSeek OpenAI 兼容）而言，这个 adapter 的形态就是标准答案。

### 5.2 结构化输出与校验兜底（重点抄）

调用侧三件套：

1. **JSON mode**：`chat_structured(messages, response_format={"type":"json_object"}, temperature, max_tokens)`；provider 不支持 json mode 时降级为文本解析。**没有用 function calling / json_schema 严格模式**（response_format 只有 json_object 一档）。
2. **解析兜底链**（world_simulator.py / macro_policy_engine.py 同款 `_extract_json`）：`json.loads` → 正则抠 ```` ```json ```` 围栏 → 正则抠最外层 `{...}` → 全失败返回 `{}`（= 空 delta，等价于纯确定性回合）。structured 调用失败再整体降级 plain chat 重试一次。
3. **结构白名单**：`_validate_output` 只保留 schema 内字段、强制 list 类型，多余字段（knowledge_cards/black_swan 等）直接丢弃——`OUTPUT_SCHEMA_HINT` 里那句"禁止输出额外字段"是有代码执行的。

请求级重试：tenacity `retry_if_exception_type((httpx.TimeoutException, httpx.HTTPStatusError))`, `wait_exponential(min=2,max=30)`, `stop_after_attempt(3)`。NPC 决策另有自己的重试配置（npc_decision_engine.py：3 次、1.5s 起步指数退避、按错误字符串白名单判定可重试：timeout/429/502/503/504/connection reset…）。

语义级校验四道闸（自外向内）：

```
IntentParser(LLM) → PolicyValidator(参数表校验+id归一化) → CommandValidator(物理可行性,静默丢弃)
MacroPolicyEngine(LLM) → _validate_output(字段白名单) → GuardrailValidator(硬/软约束) → StateApplier(确定性裁决+钳制) → _clamp_extreme_changes(全局极值)
```

`GuardrailValidator.validate()` 返回 `{"accepted", "violations", "warnings", "sanitized_delta"}`——**硬约束违反→该条目剔除（不是整包丢弃），软约束→钳制+warning**：伤亡偏离 baseline 超 [0.1×, 2.0×] 拒收；民心单回合 |Δ|>15 警告；NPC 征兵 > 人口 8% 强制 clamp 到上限；攻方已拥有目标→整条 battle 丢弃（修「济南/洛阳反复易主」bug）；非邻接夺取→warning（"StateApplier will block"，硬门在裁决层）；死者复活/凭空造人→prompt 禁止 + characters 存在性校验。design-v3-llm-simulation.md 的 GUARDRAILS 伪码把 hard/soft/deviation 三类写得最全（hard 含 `no_killing_historical_characters`——不能提前杀历史人物）。

**LLM 彻底不可用时**：`simulate()` 直接返回 `{}` → resolve() 跳过 Step 5 → 整回合按纯确定性基线结算（= V2 行为），游戏不中断。这是"确定性引擎永远是 fallback"的落地。

### 5.3 Token / 成本控制（实打实的清单）

- **每次调用落库计费**：`llm_call_log` 表 + adapter 内累计计数器（total_prompt/completion/all_tokens, total_calls），流式调用用 `stream_options={"include_usage":true}` 拿真实 usage（provider 拒绝则去掉重发），拿不到就 `chars//4` 估算；**客户端断流也要记账**（GeneratorExit 分支注释："the LLM call was STILL BILLED, so record what we consumed…Without this the call silently disappears from llm_call_log — an accounting gap"）。
- **max_tokens 分级**：macro_sim 3500、world_sim 4096、NPC 决策 2048、V1 时代 16384（反面教材）；prompt 侧硬限「总输出不得超过 2000 字符，超过则视为失败」。
- **调用次数压缩**：
  - 次要势力（刘表/刘璋等）走**启发式规则不调 LLM**（npc_decision_engine.py docstring: "Reason: reduce token cost and prevent behavior from deviating from history"）；被动势力直接跳过（macro_policy_engine `PASSIVE_NPC_FACTIONS`）。
  - **Q0/Q1 NPC 决策预烘焙**进仓库（`scenarios/*/npc_decisions_q{0,1,2}.json` + `scripts/prebake_npc_decisions.py`；room_manager `_load_repo_npc_decisions`，注释："Quarter 0 decisions are cached to disk to avoid redundant LLM calls on room creation (same initial state for each scenario)"；Q2+ 因状态发散不再可靠）。
  - **意图缓存**：`histrategy/server/intent_cache.py`——军师献策流式结束后前端立即为"上中下策"3 条建议异步预跑 intent_parse，玩家点选时 0 延迟命中（key=suggestion_id，TTL 300s，房间×季度×势力哈希失效，feature flag `HISTRATEGY_PRECOMPUTE_INTENT`）。
  - prompt 模板进程内缓存（`_MACRO_PROMPT_CACHE`、`_NPC_PROMPT_CACHE`）。
  - 叙事 LLM 调用移出关键路径（skip_narrative + SSE/后台线程），失败则模板叙事兜底，"Phase 2 failure doesn't block the next turn"。
- **成本口径**（文档自报）：v2 ~$0.02/turn → v3 ~$0.06/turn（design-v3 §7）；V1 时代 2000-4000 tokens/turn ≈ ¥0.0004；design-iterations.md 更早测算："File-based ~2,600 tokens/turn → $0.002/turn；Reasoning LLM ceiling ~$0.05/turn (player tolerance threshold)"；NPC 全 LLM agent 方案被否的原因："Full LLM agent loops for NPCs are too expensive (~$0.10/NPC/turn) and inconsistent. Stateful profiles + LLM interpretation gives 80% of the drama at 5% of the cost."
- **模型分级**：风险表提到"用小模型 (deepseek-v4-flash) 做 simulation，大模型仅做 narrative"；doubao 关 thinking 提速。

### 5.4 同步还是异步

**同步 httpx + 线程池化**：LLM 调用本身是阻塞的（httpx.Client，timeout 180s），但通过 FastAPI 后台 daemon 线程把「NPC 预生成」「叙事生成」挪出请求路径；面向客户端用轮询（`GET /api/rooms/{id}/status`）+ SSE 流式（narrative-live-stream）。**没有 asyncio LLM 并发**（未见 httpx.AsyncClient / asyncio.gather）。在 1-2 核机器上这够他们用（9 个真实用户量级），但并发房间多时线程模型会先崩——见第 8 节。

---

## 6. 技术栈（问题 6）

- **Python ≥ 3.10**（pyproject.toml `requires-python = ">=3.10"`），核心依赖极简：`rich>=13` (CLI TUI)、`httpx>=0.27`、`pydantic>=2`；web extra：`fastapi + uvicorn + PyJWT`；db extra：`psycopg2-binary`（可选 PG，默认 SQLite stdlib）；另有 `tenacity`（adapter 重试用）。构建 hatchling，lint ruff（line-length 120），版本 0.2.1。
- **形态**：CLI（`pip install -e . && histrategy`，Rich 终端"古书卷"UI）+ FastAPI 服务端 + 静态 Web UI（histrategy/web/js/api.js|game.js|ui.js，轮询+SSE，无 WebSocket）+ Python SDK（`Room.create/Room.load/room.play`）+ IM Agent（飞书适配器、OpenClaw/Hermes skill 包）。Docker/docker-compose 单容器部署（README-zh："一个容器、SQLite、不需要 Postgres"）。
- **代码量级**：206 个 .py 共约 2.5 MB；主包最大文件 room_manager.py 3378 行、api.py 1519 行、quarterly_resolver.py 1378 行、turn_processor.py 1348 行、adapter.py 1122 行；histrategy-engine 纯公式包独立成库。
- **测试**：57 个测试文件（tests/ 18 + histrategy/tests 14 + histrategy-engine/tests 15 + sdk/agent tests），约 676 KB。ROADMAP/HN 宣称 **459 tests**（2026-06 口径）。pytest 自定义 marker 很有思想（pyproject.toml 原文）：

```toml
markers = [
  # 真调第三方大模型的 e2e：输出本身不确定，"红"可能是真坏也可能是模型这次发挥不好。
  # 这类用例**不计入确定性基线**（回归脚本单独跑、单独报），否则整条回归变成靠运气，
  # 于是开始有人无视红色 —— 那才是真正的损失。
  "llm_e2e: 真调第三方大模型，输出不确定，不计入确定性基线",
]
```

即：**确定性测试与 LLM e2e 测试分池**——LLM 相关测试永不进 CI 红绿灯。这是我们该抄的测试策略。另有 e2e/playtest/benchmark 脚本 20+（scripts/auto_playtest.py、benchmark_llm.py、playtest_*_headless.py、e2e_multiplayer.py 等），`.coverage` 文件直接提交在仓库根（说明跑过 coverage）。
- 学术抱负：ROADMAP §6 计划投 AIIDE/FDG/CHI，论文题 "SimPly: A Layered Architecture for Deterministic Simulation with LLM Narrative in Strategy Games"，核心贡献即三层问责模型 + Rules-as-Data + 崇祯纯 LLM 失效案例研究。references/ 目录存了 Nottingham 2024、Gallotta 2024 综述等文献笔记。

---

## 7. 可直接复用的模块清单（问题 7）

| 类别 | 它有什么 | 成熟度 | 我们怎么用 |
|------|---------|--------|-----------|
| **规则引擎** | `histrategy-engine`（七引擎纯公式包：A* 寻路、兰彻斯特战斗、气候 seeded RNG、经济/人口/民心公式）+ `quarterly_engine.py`（EconomyParams 全参数化、防滚雪球：动态征兵率/渐进军费/占领费/征兵疲劳）+ `rules/*.yaml` + interpreter | ★★★★ 生产在用，459 测试背书 | **抄设计不抄代码**（Python→Go/Node 重写）。EconomyParams 的参数清单、防滚雪球三件套、seeded-RNG 模式可直接平移；「金→兵→战→地→金」闭环按此建模 |
| **LLM 适配层** | `llm/adapter.py`：多 provider 探测、httpx 直连 OpenAI 兼容、tenacity 重试、chat/chat_stream/chat_structured、token 计数落库、断流记账、语言注入（lang=en 时 system 自动加英文强制令） | ★★★★ 打磨痕迹明显（H31b 等修复注释） | **接口形态直接照搬**（我们用 Go/Node 等价实现）：三方法（plain/stream/structured）+ per-call DB 计费 + usage 兜底估算。多 provider 探测可简化为 DeepSeek 单 provider + 通用 base_url |
| **输出校验/兜底** | 四道闸：`_validate_output` 字段白名单 → `GuardrailValidator` 硬/软约束+sanitized_delta → `StateApplier` 确定性裁决（伤亡 0.5-1.5× 混合钳制、兵力比+邻接决定夺城、真相回写）→ `_clamp_extreme_changes` 全局极值；LLM 挂了→空 delta→纯基线回合 | ★★★★★ 全仓库最有价值的部分，每条规则背后都是真实事故编号（H35k/H36c/H37d/H38/H39b/P0-1/P4） | **逐条抄**。「LLM narrates, Python decides」「delta 白名单+逐条剔除而非整包拒绝」「钳制发生在叙事生成之前（H39b：否则叙事报旧数）」「确定性结果回写审计记录（P0-1）」四条列为我们规则引擎的验收标准 |
| **配置系统** | scenario.toml（引擎/超时/终局/势力分级）+ knowledge/*.json（JSON Schema draft 2020-12 + validate_data.py）+ rules/*.yaml + prompts/*.md 分语言分剧本覆盖回退链 | ★★★☆ 结构好，但剧本 ID 白名单硬编码、部分历史约束文本写死在 macro_policy_engine.py（Q1/Q2 硬编码"曹操刚定河北…"） | 目录约定与 toml 字段照搬；**改进点**：剧本发现改目录扫描；LLM 上下文里的历史软约束移入剧本数据文件（timeline.json 已有雏形） |
| **状态存储** | SQLite(WAL)/PG 双兼容 schema.sql：game_room(JSON blob 快照)+quarter_turn(基线/LLM delta 分列)+game_state(逐季快照)+turn_delta(逐字段增量+reason+source)+policy_state+llm_call_log | ★★★★ 审计能力极强 | **表结构近乎可以 1:1 平移**到我们"每房间独立 SQLite"方案（他们是一库多房间，我们改成每房间一文件，schema 不变）。turn_delta 的 `source('deterministic'|'llm'|'black_swan')` 列必抄 |
| **意图解析** | IntentParser（LLM→Command，关键词兜底，剧本 prompt 叠加，输出≤2000字符）+ intent_cache（建议预计算，点击零延迟）+ PolicyCommand 白名单/参数表校验 | ★★★★ | 照搬「建议预计算缓存」——SillyTavern 前端出"上中下策"时后台预解析，玩家点选即结算 |
| **NPC 决策** | 主势力独立 LLM 决策（与人类同构 DecisionResult）+ 次势力启发式 + Q0/Q1 预烘焙 JSON + 后台预生成（与人类思考时间重叠） | ★★★★ | 预烘焙开局决策 + 次要势力走规则的**分级 LLM 策略**直接适用，是 1-2 核小机控成本的关键 |
| **记忆系统** | TurnMemory JSONL（近 5 回合摘要）+ EpochMemory persistent effects（"邺城仁政三季"政策积累质变）+ narrative_seeds | ★★★ 设计文档(design-v3 §4)比实现精致 | 概念照搬（我们存 SQLite 而非 JSONL）：LLM 输出 `persistent_note` 累积、达阈值才质变，是低成本制造"蝴蝶效应"的好机制 |
| **测试策略** | llm_e2e marker 分池、headless playtest 脚本、benchmark_llm.py、快照原子性/经济均衡专门测试（test_p02/p03） | ★★★★ | 「LLM 测试不进 CI 红绿灯」+ 「经济均衡回归测试」（scripts/test_p03_economy_equilibrium.py 思路）照搬 |

---

## 8. 它不适合我们的地方（问题 8）

1. **语言与运行时**：Python + FastAPI + 同步 httpx + daemon 线程。我们要 Go/Node：他们的线程模型（每房间后台 2-3 个 daemon 线程做 NPC 预生成/叙事）在 1-2 核上跑十几个房间就会线程爆炸；我们应以事件循环/协程 + 任务队列重做异步层，**但"NPC 预生成与人类思考时间重叠"的调度思想保留**。
2. **单库多房间 vs 每房间独立 SQLite**：他们一个 DATABASE_URL 全局库，room_manager 里模块级锁（`_NPC_DECISION_LOCK`）+ 模块级缓存（intent_cache `_CACHE`、prompt cache）都是**单进程假设**。我们每房间独立 SQLite 文件后，这些全局态必须按房间分片；他们踩过的 "database is locked"（pytest 下被迫关异步的注释）也警示 WAL 下仍要控制写者数量。
3. **God object**：room_manager.py 3378 行揉了房间生命周期、resolve 编排、DB 写回、clamp、领土对账、后台线程；quarterly_resolver.resolve() 一个函数 480 行、步骤编号靠注释维持。功能是对的，**结构不能照搬**——我们应按 1.4 的四道闸拆成独立可测组件。
4. **通信**：HTTP 轮询 + SSE，无 WebSocket。我们既定 WS 方案更优（他们轮询是为兼容 Agent/IM 客户端）；但注意他们的经验：**状态先定、叙事后到**（skip_narrative + narrative-live-stream 补发），WS 上也应把"结算完成"与"叙事流"拆成两类消息。
5. **CLI/单机基因残留**：SDK DirectEngine 文件存储、`histrategy` CLI、Agent skill 包（飞书/OpenClaw）对我们无用；game_master.py/offline_sim.py/world_simulator.py 与 macro_policy_engine.py 存在**新旧两套 LLM 模拟层并存**（v0.x CLI 一套、v3 服务端一套），目录树里 V1 残留（如 `_apply_deterministic_economy` 的 V1 补丁）没清干净——参考时认准 `quarterly_resolver → quarterly_engine → macro_policy_engine → guardrail → state_applier` 这条主线，其余是历史地层。
6. **结构化输出强度不够**：只用 `response_format={"type":"json_object"}` + 正则兜底，没用 function calling / json_schema 严格模式，也没有 schema 级（pydantic）反序列化校验——`_validate_output` 只查顶层 key 和 list 类型，**嵌套字段（如 casualties 数字类型）靠 StateApplier 里的防御式 `_sum_casualties`/`_safe_int` 硬扛**。我们用 Go/Node 时应在边界上做完整 schema 反序列化（等价 pydantic/zod），把他们散落在下游的防御收敛到一处。
7. **多租户/配额缺失**：ROADMAP §4 的 Demo/Free/BYOK/Pro 分级只是规划，代码里没有 per-room token 预算熔断（只有事后记账 llm_call_log）。我们的「严控 token」需要自己加**预算闸**（房间级 token 上限→超限降级纯 V2 回合），这恰是他们没做而架构上很容易做（因为 V2 模式本来就完整存在）。
8. **剧本扩展的最后一公里**：白名单硬编码（3.5）、历史约束文案写死在引擎代码（macro_policy_engine Q1/Q2 段落）、`PASSIVE_NPC_FACTIONS = {"liuzhang","liubiao"}` 这类三国特化常量散在代码里。我们若承诺"加剧本不改代码"，需要把这些全部数据化。
9. **无战争迷雾/视野裁剪**：V3 明确暂缓（"V1 暂时不做战争迷雾，V3 也暂缓"），全部世界状态进 LLM 上下文。我们的国战规模更大，**给 LLM 的上下文必须做视野裁剪+分层标签化**（他们 state-complexity 文档的提案正好是没实施的作业，我们可以直接做）。

---

## 附：本次调研实际读取的文件清单（证据索引）

- 文档：README-zh.md、docs/ROADMAP.md、docs/architecture-philosophy.md、docs/design-iterations.md、docs/design/state-complexity-vs-llm-hallucination.md、docs/design/v1-v3-engine-design.md、docs/design/v1-latency-strategic-analysis.md、docs/design-v3-llm-simulation.md、demo/zhihu-v2-final.md、demo/show-hn-v2-final.md、publications/2026-05-25-introduction/{emergence_article,zhihu_post}.md
- 代码：engine/{engine_switch,quarterly_engine,quarterly_resolver,macro_policy_engine,guardrail,state_applier,scenario_loader,loader,combat}.py、llm/{adapter,world_simulator,llm_sim_engine,game_master,npc_decision_engine,advisor}.py、llm/prompts/world_simulator.md、parser/{intent,validator}.py、policy/{policy_types,policy_validator}.py、server/{room_manager,intent_cache}.py、db/{schema.sql,connection.py}、histrategy-engine domestic/turn/map/world __init__.py
- 数据：knowledge/data/{schema.json,schema.md}、scenarios/three-kingdoms/{scenario.toml,rules/economy.yaml,prompts/intent_parse.md}、pyproject.toml、GitHub API 目录树（484 路径）
- 未找到/不可得：emergence-meta 私有仓库中的 V1 下线设计文档（2026-10-03-remove-v1-engine.md）；已删除的 v1_simulator.py / api_v1.py / prompts/v1_simulator.md 源码（仅存于历史 commit，本次未检出）。
