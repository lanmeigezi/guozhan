# 案例调研 04："Agent Wars" / "CITAR" 猎捕记录 + 替代案例（WarAgent、Diplomacy/CICERO）

> 调研日期：2026-10（GitHub API 直连 + 下载 tarball 实际读码 + WebSearch 中英文检索）
> 结论先行：**"Agent Wars" 与 "CITAR" 作为「单一权威核心服务人类/AI/观战 + LLM-as-a-player」的参考项目，未能找到，判定为上游对话中记错或模型虚构的名字。** 按预案改为深挖两个公认权威实现：`agiresearch/WarAgent`（LLM 多智能体世界大战模拟，与"国战模拟"主题最贴近）和 `facebookresearch/diplomacy_cicero`（CICERO，"LLM 只做外交文本、数值交给独立规划器"的教科书案例，与我们的硬约束完全一致）。两者均已下载源码实读。

---

## 1. 搜寻过程记录（共 8 条路径，全部留证）

| # | 路径 | 方法 | 结果 |
| --- | --- | --- | --- |
| 1 | ernestwisniewski 全部公开仓库 | `GET /users/ernestwisniewski/repos?per_page=100`（59 个，非 fork 16 个） | 只有 age-of-new-worlds、aonw、aonw-assets、aonw-map-autofill、aonw-map-editor、kbin 系、symfony-of-ages 等。**无任何沾边名字** |
| 2 | smokycamera 全部公开仓库 | `GET /users/smokycamera/repos?per_page=100` | 仅 2 个：`sillytavern-general-battle-system`、`tavern-battle-mcp`。**无沾边名字** |
| 3 | age-of-new-worlds 全文 grep | 下载 main 完整 tarball（420MB），`grep -rin "citar\|agent.wars"` 全仓库（.md/.rs/.dart/.json） | **0 命中** |
| 4 | emergencescience/histrategy（"LLM narrative strategy games, including Three Kingdoms, Rome and Nanming"，即任务提到的 histrategy） | 下载 main tarball（5MB，407 文件），grep 文件名与全文 | 路径与内容均 **0 命中**。其 docs/design/ 下也无引用这两个名字 |
| 5 | tavern-battle-mcp + sillytavern-general-battle-system | 下载 tarball grep | **0 命中** |
| 6 | GitHub repo search | `q=CITAR game OR LLM`（303 命中）：全是 emacs-citar（Emacs 文献引用）、citar 词性标注器等；`q="agent wars"`（62 命中）：全是 GDG DevFest 黑客松玩具（gkavinrajanCodes/devfest-agentwars、jim-agent/agent-wars、zongting89/agentwars 等），无描述、无 star、与"权威核心/观战/LLM 玩家"无关 | **无匹配** |
| 7 | WebSearch 中文 | `"CITAR" LLM game agent spectator 单一权威核心` | 无此项目；命中的是狼人杀 Agent 博客、LLM game agent 综述等泛结果 |
| 8 | WebSearch 英文 + arXiv 向 | `"Agent Wars" LLM game authoritative core spectator`；`"CITAR" arxiv LLM strategy game framework` | 无匹配；arXiv 方向也没有叫 CITAR 的游戏框架 |

**判定**：两个名字在 GitHub、arXiv、中英文网络均无对应实体，且不在业主指定的三个相关生态仓库的任何文档里。最可能是前一轮对话中 LLM 把某些概念（如 "agent wars" 泛指、CICERO/CITAR 形近）记串了。**此为如实报告的"未找到"，以下替代调研保证案例 04 不空转。**

附带发现：任务书里写的 `facebookresearch/diplomacy` 现已 **404**（API 与 tarball 均 404）。CICERO 代码的现存官方仓库是改名后的 **`facebookresearch/diplomacy_cicero`**（1433 star，main 分支，最后 push 2025-04-17），本报告以它为准。

---

## 2. 替代案例 A：agiresearch/WarAgent —— LLM 多智能体"国战模拟"

> 仓库：https://github.com/agiresearch/WarAgent （Apache-2.0，作者 Wenyue Hua, Lizhou Fan 等，Rutgers）
> 论文：*WarAgent: Large Language Model-based Multi-Agents Simulation of Diverse Historical International Conflicts*（arXiv:2311.17227）
> 规模：src/ 约 5200 行 Python（agent.py 412 行、secretary.py 419 行、board.py 331 行、action_definition.py 368 行）；已下载 tarball 实读
> README 原文："We propose **WarAgent**, an LLM-powered multi-agent AI system, to simulate the participating countries, their decisions, and the consequences, in historical international conflicts, including the World War I, the World War II, and the Warring States Period in Ancient China."

### 2.1 角色划分（谁权威、谁只是嘴）

- **Agent（每国一个 LLM 玩家）**：`src/building_blocks/agent.py` 的 `Agent` 类，持 profile（国家人设 prompt）、action_list（动作空间）、`board`（自己视角的世界状态）、`stick`（记忆）。`plan()` 让 LLM 产出**动作列表（JSON）**，`observe()` 把全体动作按公开/私密/需回应拆分成各国自己的下一轮 situation。
- **Secretary（秘书，规则引擎 + 校验器 + 消息中枢）**：`src/building_blocks/secretary.py`。**世界状态的唯一权威更新者是它，不是 LLM**：`update_board()` / `update_stick()` 是纯 Python 规则代码，把"已接受的动作"映射为关系矩阵变更（下详）。
- **Board（世界状态）**：`src/building_blocks/board.py`，国家间关系矩阵（W=交战、M=军事同盟、T=互不侵犯、P=和平协定等），提供 `single_update/batch_update/batch_reverse_update/resolve_board_update_conflict/translate_to_text`。**LLM 从不直接写 Board，只能读它的文本化视图。**

### 2.2 LLM 输出的三层校验回路（对我们最有价值的部分）

`agent.py` 的 `plan()` 原文流程：

1. LLM 生成 `thought_process, action_list = generate_action(prompt, self.model, i)`；
2. **确定性格式校验（纯代码）**：`self.secretary_agent.check_action_names(action_list)` + `check_action_input(self.identity, action_list)`。后者按 `action_property_definition` 的动作 schema 逐条检查（`secretary.py:54`）：动作名必须在 schema 内；`input: list_countries` 的每个元素必须匹配 `^Country .*$`；`list_tuple_countries` 的每个元组必须包含发起国；目标国不得是自己（Publish 类除外）……不合格就把**具体失败原因**塞回 prompt 重新生成；
3. **LLM 逻辑校验（Secretary 也调 LLM）**：`action_feedback()` 检查动作与 Board/Stick 的逻辑一致性；连续 3 次不通过则 `direct_action_modification()` 由 Secretary **直接改写动作列表**兜底（`agent.py` 原文："Secretary has checked 4 times and still not agree ... thus the Secretary directly modifies the action list."）。

动作 schema 本体在 `src/history_setting/action_definition.py`，每个动作带机器可校验的元数据：

```python
action_property_definition = {
    "Declare War": {"publicity": "public", "input": "list_countries",
                    "prompt": "against", 'require_response': False},
    "Request Military Alliance": {"publicity": "non-public", "input": "list_countries",
                    "prompt": "to", 'require_response': True},
    ...
}
```

`publicity`（公开/密约）决定消息广播范围，`require_response` 决定它会不会成为对方下一轮的 request——**这就是"LLM 输出结构化 JSON + 规则引擎按 schema 校验"的完整可运行样本**，和我们的硬约束同构。JSON 解析容错在 `src/utils/parse.py`（json → json5 → 正则修复三级降级）。

### 2.3 数值/状态由确定性代码算（证据）

`secretary.py:363 update_board()` 是纯 if/elif 规则代码，例如：

```python
if action == 'Declare War':
    update_dictionary['W'].append((agent1, agent2))
elif action == 'Accept Military Alliance' or action == 'Publish Military Alliance':
    update_dictionary['M'].append((agent1, agent2))
...
board.batch_update(update_dictionary)   # 还先做背叛动作的 batch_reverse_update
```

即：**LLM 只决定"做什么动作"，动作对世界的一切后果（谁和谁进入什么关系）由代码表驱动**。战争是否爆发不是 LLM 说的，而是 Board 上出现 W 边。评估也基于此：`src/evaluation_metric.py` 用 Jaccard 相似度 / 联盟划分准确率对比模拟结果与真实历史（WWI/WWII/战国三个 scenario，`src/history_setting/agent_profile_*.py` 定义各国 profile）。

### 2.4 主循环（`src/main.py`）

每轮：所有 Agent **同时** `plan()`（同步阻塞逐个调 LLM）→ 收集全部 `agent_messages` → 每个 Agent `observe()` 得到自己视角的 public/private 消息与 requests → Secretary 依动作更新各国 Board/Stick → 打印/记录上帝视角 board。跑 `--rounds` 轮后统计是否开战、何时开战、谁参战。

### 2.5 对我们可复用 / 不可用

**可复用**：
- 「动作 schema（publicity/input/require_response）+ 确定性校验 + 带失败原因的重试 + 次数上限 + 兜底改写」这套 **LLM 命令校验回路**，可整体平移到我们的规则引擎；重试上限（3+1）就是天然的低频控 token 手段。
- 按 `publicity` 分发密约/公开消息 → 对应我们的"按房间成员投影事件"。
- 每国独立 Board 视图（`Board(this_agent=..., agents=...)`）= 每玩家信息隔离的极简实现。

**不可用 / 警示**：
- **无权威核心纪律**：Secretary 的 `action_feedback`/`direct_action_modification` 本身调 LLM，校验层混入了 LLM 判断——违反我们"数值全由确定性代码算"的约束，我们应只保留它的第 2 层（纯代码 schema 校验），第 3 层降级为"拒绝并留痕"。
- 无持久化、无房间、无网络、无回放、无观战客户端（终端打印即"上帝视角"）；LLM 随机性导致**不可确定性重放**；单进程串行调用，成本与延迟都不可控。

---

## 3. 替代案例 B：facebookresearch/diplomacy_cicero —— "LLM 只做外交文本、数值交给规划器"的教科书

> 仓库：https://github.com/facebookresearch/diplomacy_cicero （MIT + 模型权重单独许可；1433 star；已下载 main tarball 3MB 实读。注意：旧名 `facebookresearch/diplomacy` 已 404）
> 论文：*Human-Level Play in the Game of Diplomacy by Combining Language Models with Strategic Reasoning*（Science, 2022）；*Mastering the Game of No-Press Diplomacy via Human-Regularized Reinforcement Learning and Planning*（ICLR 2023，Diplodocus）
> README 原文定位："This code contains checkpoints and training code for the following papers..."，并明确"the central logic for Cicero's strategic planning lives [in] `fairdiplomacy/agents/br_corr_bilateral_search.py` and `fairdiplomacy/agents/bqre1p_agent.py`"。

Diplomacy（外交棋）是 7 人谈判+同时出牌的桌游：每阶段所有玩家**秘密提交命令，引擎同时裁决**——这正是"国战"的核心机制（同时行动、联盟、背刺、密约）。

### 3.1 单一权威核心：C++ 引擎 `pydipcc::Game`

- 规则裁决、地图、阶段推进全部在 C++（`dipcc/`，经 pybind 暴露为 `fairdiplomacy.pydipcc.Game`）。Python 侧 `fairdiplomacy/env.py` 的 `GameEnv` 持有唯一 `Game` 实例驱动整局：所有 agent 每阶段被依次调用，收齐各方 orders 后 `game.process(...)` **一次性确定性裁决**（冲突支援被砍、对峙双双失败等规则全在引擎）。
- **任何 agent（人或 AI）都不能改状态，只能提交 orders，由引擎裁决**——与案例 03 的 aonw 完全同构，但这是它的"祖先级"实现。

### 3.2 人类 / AI / 观战共享同一核心

- **统一接口**：`fairdiplomacy/agents/base_agent.py` 的 `BaseAgent`（ABC）：

```python
class BaseAgent(ABC):
    def get_orders(self, game: Game, power: Power, state: AgentState) -> Action: ...
    def generate_message(self, game, power, timestamp, state, recipient=None,
                         pseudo_orders=None) -> Optional[MessageDict]: ...
```

  每个 agent 只拿到 `game`（或其受收视角 `game_from_view_of(game, power)`）+ 自己执掌的 `power`。CICERO、纯规划 bot（`BQRE1PAgent`）、随机 bot、人类代理全是 `BaseAgent` 子类，**引擎不区分对面是人还是 AI**。
- **人类接入**：`fairdiplomacy/webdip/`（`utils.py`、`message_approval_cache_api.py`）把 CICERO 接到 webdiplomacy.net 的真人对局——CICERO 作为普通"玩家"注册进人类房间，人类在网页 UI 上玩，回合数据同步进同一个 `Game`；`utils.py` 专门做 webdip 的 turn/phase 到引擎 Phase 的翻译（"Convert webdip notion of turn and phase into dipcc notion of phase"）。**观战**由 webdiplomacy 平台本身提供（平台侧观察者读同一份对局数据），仓库内另有 `fairdiplomacy_external`（README："a separately licensed subfolder ... contains some utilities for visually rendering games, or connecting agents to be run online"）与 `fairdiplomacy/viz/` 做上帝视角渲染。
- 结论：**"权威核心 + 一切参与者皆 client"**，人类 UI、AI agent、渲染/观战工具是同一 `Game` 对象的三种消费方式——这正是业主想学的形态（虽然它的 spectator 依托外部平台而非仓库内建）。

### 3.3 LLM-as-a-player：语言与战略的硬分离

`fairdiplomacy/agents/parlai_full_press_agent.py`（CICERO 的开源对话侧入口，127 行）把两种能力**在类型层面**分开：

```python
class ParlaiFullPressAgent(BaseAgent):
    def __init__(self, cfg):
        # Required: Orders Model
        self.model_orders = load_order_wrapper(cfg.model_orders)   # 规划器/价值网络，非LLM
        self.order_handler = ParlaiOrderHandler(self.model_orders)
        # Required: Message Handler
        self.message_handler = ParlaiMessageHandler(cfg.dialogue, model_orders=self.model_orders)

    def get_orders(self, game, power, state):
        return self.order_handler.get_orders(game, power)          # 数值/走子：规划器说了算

    def generate_message(self, game, power, timestamp, state, recipient=None,
                         pseudo_orders=None):
        ...
        maybe_msg_dict = self.message_handler.generate_message(
            game, power, timestamp, recipient, pseudo_orders)      # 文本：以规划结果为条件生成
```

- **走子命令永远不来自语言模型**：`bqre1p_agent.py`（1302 行，DiL-piKL：人类正则化 RL 价值网络 + one-ply 搜索）与 `br_corr_bilateral_search.py`（CICERO 的双边/相关规划）负责战略；候选命令由 `plausible_order_sampling.py` 从规则引擎的合法动作空间采样，再由价值网络打分——**动作空间合法性由 C++ 引擎保证，数值由网络+搜索算，两者都不含 LLM**。
- **LLM 只做对话，且被"锚定"在规划结果上**：`generate_message(..., pseudo_orders)` 的 `pseudo_orders` 就是规划器当前意图；对话模型以"我方计划这样走"为条件生成外交辞令（Science 论文的核心设计：dialogue grounded in planning），并用意图识别把**对方**的自然语言解析成结构化信号。
- **对 LLM/文本的结构化校验**：`parlai_diplomacy/tasks/` 下全是"把语言变成受控结构"的分类器任务——`recipient_classifier`（这句话是说给谁的）、`sleep_classifier`（该不该现在发言）、`lie_detector`、`denoising`、`discriminator`、`draw_classifier`，以及 `agents/bart_classifier`、`generator_custom_inference`。对话模型输出的是受约束的消息对象（收件人、时间戳、文本），**不可能产出任何直接改状态的东西**；即便消息里承诺了走子，兑现与否仍由规划器+引擎决定（这也是它能在真人局里"守信/背刺"权衡的原因）。

### 3.4 对我们可复用 / 不可用

**可复用（与我们硬约束一一对应）**：
1. **"LLM 只做外交文本/战略建议，数值与裁决全在确定性核心"** 的分工范式：我们的 LLM 输出（战略建议 JSON、外交辞令）对应它的 message 层；我们的规则引擎对应 pydipcc+planner。**LLM 的建议要像 pseudo_orders 一样被"锚定"：只能引用引擎给出的合法动作 id，越界即拒。**
2. **BaseAgent 统一接口**：人类（经 SillyTavern 面板）、AI 玩家、观战端全部实现/消费同一 `get_state(view_of(power)) + submit(command)` 面，引擎不感知对面是谁。
3. **同时提交-统一裁决**的阶段模型（secret orders → `process()` 一次裁决），天然适合国战"各国同时下旨、回合结算"。
4. **把自然语言结构化的分类器思路**：我们可用"LLM 输出 + 规则校验 + 小分类/抽取步骤"替代大模型自由发挥，成本更低。

**不可用**：
- 工程极重：C++ 编译链、conda py3.7、ParlAI/PyTorch 全家桶、RL 训练代码；是研究发布而非产品服务器。
- **无多房间服务端**：`GameEnv` 单进程单局；无房间管理、无断线重连、无持久化协议（对局序列化有，但不是多租户服务）。
- 无 WebSocket/HTTP 服务层、无 SQLite 级轻量存储；模型权重单独许可，不能直接商用。
- 观战依托 webdiplomacy 外部平台，仓库内没有可抄的 spectator 服务实现（这一点 aonw 的 recipient 投影 + 只读回放反而是更好的抄写对象，见案例 03 第 3.3/7 节）。

---

## 4. 三案例合成：给我们的"单一权威核心"设计定调

| 关注点 | 抄谁 | 具体形态 |
| --- | --- | --- |
| 核心纪律（无 IO/时钟/随机、拒绝不改状态、行为指纹） | aonw（案例 03） | 核心模块零框架依赖 + 架构测试强制 |
| 命令协议（四类输入输出、稳定拒绝码、AI 走同一通道） | aonw ADR 0003 | Intent/Command/SystemCommand/Event 四分 |
| LLM 玩家命令校验（schema 校验 + 带原因重试 + 上限 + 拒绝兜底） | WarAgent Secretary（只取纯代码层） | 动作 schema 含 publicity/require_response |
| LLM 与数值的职责切分（文本锚定在规划结果上） | CICERO | 建议只能引用引擎合法动作 id |
| 人类/AI/观战共享核心 | CICERO BaseAgent + aonw recipient 投影 | 每参与者一个受收视角；观战=只读全知投影/回放 |
| 同时行动裁决 | Diplomacy `game.process()` | 收集→锁定→一次结算→事件广播 |

## 5. 来源

- WarAgent：https://github.com/agiresearch/WarAgent （本地实读 `src/main.py`、`src/building_blocks/{agent,secretary,board}.py`、`src/history_setting/action_definition.py`、`src/utils/parse.py`、`src/evaluation_metric.py`）；论文 arXiv:2311.17227
- CICERO：https://github.com/facebookresearch/diplomacy_cicero （本地实读 `README.md`、`fairdiplomacy/agents/{base_agent,parlai_full_press_agent,bqre1p_agent}.py`、`fairdiplomacy/env.py`、`fairdiplomacy/webdip/utils.py`、`parlai_diplomacy/tasks/` 目录）；Science 2022 论文 https://www.science.org/doi/10.1126/science.ade9097
- 搜索过程涉及的 API/检索：GitHub users/repos API（ernestwisniewski、smokycamera）、GitHub search API（`CITAR game OR LLM`、`"agent wars"`、`cicero diplomacy`、`histrategy`）、WebSearch（中英文，见第 1 节表格；命中项如 [狼人杀 Agent 博客](https://blog.csdn.net/2401_86343364/article/details/159554750)、[LLM Game Agents 综述](https://arxiv.org/html/2404.02039v1) 等均与 "Agent Wars/CITAR" 无关）
- 旧仓库 `facebookresearch/diplomacy` 已 404（2026-10 实测），以 `diplomacy_cicero` 为准
