# guozhan —— AI 辅助国战模拟后端

**SillyTavern（AI 酒馆）当客户端，TypeScript/Node 24 当后端，SQLite(WAL) 每房间一库。**
确定性规则核心负责一切数值结算（移动/战斗/经济），LLM 只做战略建议与叙事 —— LLM 挂了、预算超了、根本没配 key，游戏照样能玩。部署目标：1-2 核 / 2-4GB 轻量云服务器，零重型中间件（无 Redis）。

## 两种 AI 形态，同一套代码

任务书里的两句话其实是同一个开关：

| 形态 | 席位设置 | 行为 | 谁改状态 |
|---|---|---|---|
| **军师模式**（人机配合） | `kind=human` / `autoCommit=false` | 建议存为 `pending`，酒馆面板显示"采纳"；人类点采纳 → 转成 `DomainCommand` 走**人类同一条**提交通道 | 人类 |
| **独立国家**（AI 自动作战） | `kind=ai` / `autoCommit=true` | 闸门通过的命令自动提交并锁定；回合到齐自动结算 | AI 自己 |

两个开关正交：`autoCommit` 决定**谁拍板**，`llmDriven` 决定**这个席位能不能用模型**（人类席位默认开，按需请求，不自动烧 token）。
人类席位的建议入口：酒馆面板「求军师」按钮 → `POST /api/rooms/{id}/advice`（MCP 工具 `request_advice` 等价）。AI 席位由回合边界自动触发。
两种形态都受同一套硬约束：LLM 只给 `legalActionId` + 理由，数值一律由 core 算，闸门逐条剔除并留痕。

### 外部 Agent（如 DSH）代理一个国家

- 服务端提供有状态 MCP：`http://<host>:<port>/mcp`，用某个席位的令牌做 `Authorization: Bearer ...`。
- **完整对局记忆**：`GET /api/rooms/{id}/memory` 返回 `guozhan-match-memory` JSON（逐回合战报/命令/叙事 + 原始事件流 + 外交文书），供酒馆/外部压缩器自行压缩；玩家席位按战争迷雾裁剪，观战/管理令牌拿全知版本。酒馆扩展的「同步完整对局记忆」按钮和 `client.memory()` 已接入该端点。
- **多用户账号 / 房间大厅**：`/api/auth/register|login|logout`、`/api/me`；账号可建房/加入/观战/离开，房主可踢人/封禁/解封/删除房间。账号会话（`usr_`）只用于大厅，游戏内仍使用加入时签发的席位令牌（`gz_`）。网页首屏是桌游大厅：先登录，选国战后再选剧本建房或加入；未登录不能进入其余桌游（网页层门禁）。其余桌游走 `npm run start:board` 的桌游服务（默认 8766）。**没打完的对局不会丢**：重新登录/刷新后大厅顶部出现「继续对局」，一键回到原席位（服务端旋转席位令牌、旧令牌立刻失效）。完整契约与安全边界见 [docs/07-多用户与对局记忆.md](docs/07-多用户与对局记忆.md)。
- 外部 Agent 通过 `@deepseek-ai/dsh-mcp-client` 以 `transport: streamable-http` 接入，获得 `mcp__guozhan__*` 工具。
- 每回合流程：读 `get_situation` / `list_legal_actions` → `validate_orders` → `submit_orders` → **`lock_orders`**。不锁回合，房间会一直等它。
- AI 代理国家与人类席位看到同一份战争迷雾投影，走同一条命令通道，不存在全知后门；双方独立提交，全员锁定后统一裁决。

### AI 自我迭代（引擎复盘，不靠模型自吹）

- 每回合快照带 `selfReview`（只给本席位）：上回合得地/失地、进攻胜负、被拒命令、金粮民心增量，加上 3-6 条确定性 lessons 和策略参数（进攻门槛、守备/基建/谍报权重、建议税率、命令数上限）。
- 启发式 AI **真的消费这些参数**：失地/进攻失败会提高门槛与守备权重；粮草/低民心会降税；高动乱会修基建；交战无情报会派间谍；有余钱会调税/颁法令/合兵。
- LLM 与 DSH 也在 `get_situation` 里看到同一份复盘与策略建议，不需要自己凭空“反思”。
- 复盘参数来自战报与状态，纯确定性；同序列重放得到同一策略。
- 闸门：`tests/deterministic/selfplay.test.ts`。

## 网页参考客户端（不装酒馆也能玩）

```bash
npm run build
# 终端 A：起后端（令牌 ≥24 字符；Origin 要放行静态页）
GUOZHAN_TOKEN=demo-token-0123456789abcd GUOZHAN_ORIGINS=http://127.0.0.1:8080 npm start
# 终端 B：起静态页（只放行 web/ 与扩展 lib/）
npm run web            # http://127.0.0.1:8080/web/
```

页面与酒馆扩展**共用同一套传输层** `extensions/sillytavern-guozhan/lib/client.js` —— 它同时是"可玩的最小前端"和"传输层可复用"的证据。
命令来自 `GET /api/rooms/{id}/actions` 返回的 `action.command`：UI 不解析动作 id、不自己拼规则。
令牌只存页面内存，刷新即丢；服务端文本一律 `textContent` 渲染。

### 六角战略地图（Hex Empire 式）

地图是纯 SVG、无第三方依赖的六角棋盘：势力色块、格内兵力与全国民心棋子、都城星标、战争迷雾、邻接道路。
**道路才是合法邻接**，六角格摆在哪里完全由 `config/map/layout.json` 决定 —— 画图坐标不构成第二份规则真相。

- 点己方六角格 → 地图高亮该区出发的合法命令目标（红=可进攻，蓝=可调动）→ 点目标格即把引擎给的 `action.command` 加入军令；一条目标有多支可选部队时，右侧面板列出候选。
- 军令可逐条移除，地图上用带编号的箭头预览；提交后由服务端统一裁决，前端不收结果不自己改状态。
- 战争迷雾按接收者投影：未探明区只显示位置；仅知归属区不显示驻军；邻境区用 `?` 代替精确兵力。
- 战斗/易主/征兵/调动事件会在地图上播放动画；地图数据仍以 `/snapshot` 为真相，事件只负责"播报"。
- 缩放：滚轮或 `+ / − / ⟲`；拖拽平移；`⛶` 全屏；可切到「文字拓扑」查看发给 LLM 的同一份 `mapText`。
- `GET /api/rooms/{id}/layout` 只返回静态坐标、画布尺寸、阵营色与首都；归属与兵力永远走投影后的快照，布局也不进 LLM 提示词。

布局契约由 `tests/deterministic/map-layout.test.ts` 强制（19 区全覆盖、格子不重叠、不越界、不夹带迷雾字段、道路长度可读），
前端静态自检由 `tests/deterministic/web-assets.test.ts` 强制（DOM id 必须存在、入口文件齐全、模块可解析、无 emoji 图标）。

### 第二模式：连续六角棋盘 + 水路（`iron-front`）

同一套后端与前端按剧本自动切换棋盘类型，不需要另起服务：

- **连续六角棋盘**：5 排 × 6 列的 pointy-top 六角网格，其中 0/1 排是北岸陆地、2 排是蓝色水域、3/4 排是南岸陆地；共 24 个陆地六角格 + 6 个水格，格子边对边紧贴，没有缝隙。
- **陆军只走桥**：普通邻接只在 b2-c2、b5-c5 两座桥跨过水排；其余跨水方向对陆军是断的。
- **水域是水师的航道**：`waterRoutes` 是无向特殊边，端点必须是港口；水师（`domain: "water"`）只能沿蓝色水路移动、只能在港口征募。蓝色水格本身是视觉航道，不承载归属或陆军。
- **一回合多格**：水师的 `movement` 为 6，每条水路消耗 1；一条移动命令可以连走 `b1→b3→b4→c4→c6`（4 格）。事件携带完整 `path`，网页会画出折线箭头、标注“格数 · 水路”，战报也会写出“N 格”。
- **跨水突击 1-2 格**：水师可以沿水路突击相邻港口，也可以跨过一个中间港口打第二格（`waterRoutePath(..., 2)`）；陆军不能这样打。`isAttackAdjacent` 是唯一裁决入口，完整航线随战斗证据下发，夺城进驻也沿这条航线走，不会瞬移穿过中间港口。
- **每回合复位**：回合结算末尾清空 `movedThisTurn`，单位下一回合重新可用；旧存档加载时也会做一次迁移清零（修复此前“移动过就永久停摆”的 bug）。
- **行动次数**：同一部队每回合最多移动一次、最多进攻一次；允许“先移动再进攻”，但重复进攻命令会被 core 拒绝（UI/启发式之外的兜底）。

创建第二模式房间时把 `scenarioId` 设为 `iron-front`；布局端点的 `kind` 为 `hexboard`，并额外返回 `hexSize`、`waterCells`、`bridges`、`ports`、`waterRoutes`。
剧本通过 `scenario.json.knowledge` 指向自己的 `mapFile/layoutFile/unitsFile`，共享战斗/经济/移动参数；旧剧本的 knowledge 解析结果与旧硬编码路径逐字相同，`contentHash` 保持不变。

规则与布局闸门：`tests/deterministic/scenario-iron-front.test.ts`（水师多格、陆军绕桥、港口征募、跨水进攻、六角邻居/桥与邻接一致、旧哈希不变）与
`tests/deterministic/room-loop.test.ts` 的铁河全 AI 自动局；前端仍由同一套 `map-view.js` 渲染，`kind: "hexboard"` 时切换为连续六角格、水域、桥和水师航线。

### 随机地图（`random-front`，种子可复现）

`random-front` 不读静态地图，而是由 `src/server/random-map.ts` 按房间 `rootSeed` 生成一张六角战场：

- **输入种子**：同一个种子 ⇒ 同地形、同水域带、同港口/水路、同势力领地与首都、同开局部队、同 `contentHash`；换种子即换图。种子在房间创建时写入 `rootSeed`，重启/读档时会用同一种子重生成并通过 `verifyIdentity`。
- **生成内容**：六角半径 3（37 格）中切出一条水域带；在两岸生成跨水桥；按港口种子把陆地平衡分给四家；生成地形/资源、港口水路 MST、首都、每家的陆师/水师与至少一场接壤战争。生成器有确定性重试，保证每家领土连通、有港口、有水师、陆地全连通。
- **网页快速开局**：展开连接面板里的「随机地图快速开局」，填管理令牌、种子（可留空自动生成，点「随机种子」）、我方势力，点「生成并进入」；网页会调用现有建房/加入接口并自动连接。管理令牌只驻留内存，适合本地演示；生产环境应由管理员发放席位。
- 生成器闸门：`tests/deterministic/random-map.test.ts`（同种子逐位复现、换种子必须不同、多 Seeds 连通/领地/港口/水师/战争/桥/水路合法性），`room-loop.test.ts` 里还有一局随机全 AI 自动局。

### 全国民心 / 地区动乱 / 地区基建（`random-front-v2`，同种子同地图）

`random-front-v2` 与 `random-front` 共用 `generator.namespace`：**同一个种子仍是同一张地图**，但启用可选的 `governance.json`。旧 `random-front` 保留，旧存档与旧 contentHash 不受影响。

- **全国民心**只挂在势力上（`FactionState.morale`）：战力系数 `0.5 + morale/170`，并参与守军溃败判定（民心 < 20 时可能不战而降）。
- **地区动乱**只挂在区域上（`RegionState.unrest`）：直接惩罚本区金/粮产出（每点 -0.4%）与守备战力（每点 -0.3%），不再只是告警数字。
- **低民心放大征兵/战火动乱**：民心低于 60 后，系数 `1 + gap/60 × 1.5`（民心 0 时 ×2.5）。征兵在征兵区、战火在交战区、开战动员在出发地各自制造动乱；战斗证据里带 `lowMoraleFactor`、`unrest` 拆分与双方民心系数。
- **地区基建**：`build_infrastructure` 逐级修建（驿亭 → 仓廪 → 学宫 → 水利）。每级降低本区动乱（落成立即 + 每回合）、提高本区人口增长（+0.4% ~ +2.2%/回合），并按基建点全国汇总（每 6 点 +1 全国民心/回合）；落成时立即 +2 全国民心。不同等级的人口增长率不同。
- **战斗可视化**：结算后网页按 `turn_report.events` 逐场播放战况——图上先钉出全部战场、从出发地拉红色进攻箭头、目标格脉冲；战斗 HUD 显示“第 i/N 场 / 交战中 / 战斗结束”、双方兵力损失、战力比、双方民心系数、动乱拆分与航线；左侧「战况」面板保留本回合全部战斗，可点击定位。6 场战斗播放是慢速时间线，不是状态真相；状态仍先于叙事落定。
- **闸门**：`tests/deterministic/governance.test.ts`（基建/低民心放大/地区惩罚/水路 1-2 格/同种子同地图）与 `tests/deterministic/ux-battle-morale.test.ts`（战斗 HUD/战况面板/民心文案/DOM 接线）。

### 地形 / 平民税基 / 变法代价（全剧本生效，规则常量不改旧 contentHash）

- **地形六类**（`TERRAIN_TRAITS`，代码常量；旧剧本 `contentHash` 不变）：
  - 平原：粮产 ×1.25、金产 ×1.15、人口增长 ×1.25。
  - 林地：粮产 ×1.65（最高）、金产 ×1.25、人口增长 ×0.75；守军中的民兵/槍兵/劍士额外 ×1.15（骑兵/弓兵/器械不吃）。
  - 山地：粮产/金产 ×0.55、人口增长 ×0.45；情报费 ×1.8；行军消耗 ×3、守军战力 ×1.7（沿用战斗配置）。
  - 丘陵/都会/水乡：各有产出、人口、情报与守备倾向，都会金产 ×1.45、情报费 ×0.9。
- **税收只算平民人口**：`平民 = 总人口 − 兵力`。兵力越多，税基越小；税率动作的预估与说明直接显示平民人口。人口自然增长也按平民比例与各区地形倾向加权，全民皆兵时增长为 0。
- **地块平民与地方产出**：地块详情新增“平民 = 本区人口 − 本区驻军”；`frontier` 开荒图启用 `civilianLaborPenalty=0.35`，本区粮/金产出按平民占比打折（满驻军最多 −35%），征兵会减少平民并压低本地产出；旧剧本不配置该字段，行为不变。
- **地块人口与征兵**：每块地的 `baseManpower × 发展度系数` 会显示在网页/酒馆/桌游区域详情里；征兵上限改为**本区人口 × 征兵比例 × 疲劳**，同回合同一地块多笔征兵累计占用上限；全国总上限仍然保留。小地块不再能凭空拉出大军，AI 也更难靠单区暴兵滚雪球。
- **税率直接改全国民心**：20% 为中性；10% 轻徭薄赋 +2 民心/回合；30% -4、40% -8、50% -12、60% -16，且 50% 起还会给每个辖区叠加地区动乱。40% 不再是“无代价最优”，多拿的金要用持续民心换。
- **变法必生乱**：每次**新颁布**国策，除金币成本外，立刻一次性 −5 全国民心（已生效国策重复提交不再扣）。国策动作的标签、预估 `moraleCost` 与说明都会写出这一代价。
- **地形情报费**：派间谍不再是固定 150 金，按目标地形的情报难度计价（山地 270、林地/丘陵 173、都会 135、平原 150）；合法动作按目标逐条给出实际费用，只列付得起的。
- **可见性**：layout 新增 `terrain` 图鉴（产出/人口/情报/行军/守备/步兵加成），网页地块详情与 tooltip、酒馆面板、桌游合集窗口都显示地形效果；网页/桌游的战报仍以引擎事件为准。
- **闸门**：`tests/deterministic/terrain-economy.test.ts`（地形产出/平民税基/人口增长/变法 −5 民心/地形情报费/林地步兵守备/layout 与三端 UI 接线）。

### AI 原型：疾攻 / 守成 / 无常

- **开局随机分配**：按 `rootSeed + factionId` 确定性分配；同种子稳定、换种子换分布。3 个 AI 席位保证三种原型各至少一个，2 个 AI 不重复，1 个由种子决定。
- **疾攻**：奖励早期夺地、进攻胜和防守胜，越早拿地越高；策略是低进攻门槛、5 条命令、低守备/基建权重、优先派间谍找突破口。适合快速战争，但容易在消耗战里掉民心。
- **守成**：奖励存活回合、金粮增量、民心稳定和防守胜；策略是高进攻门槛、高守备/基建/法令权重、20% 中性税。它会筑垒、修基建、屯兵，拖到对手先崩。
- **无常**：不按固定套路，从合法动作里按 `(rootSeed, turn, factionId)` 确定性随机抽取；同局面可复现，但仍然只能选合法动作、不能重复使用同一支部队。
- 原型奖励会反馈进下一回合策略（`SelfReview.reward` → `AiPolicy`），不是只换一个名字；AI 席位在列国面板显示「疾攻/守成/无常」，快照与 LLM 提示词也会带上对手原型。
- 闸门：`tests/deterministic/ai-archetypes.test.ts`（分配覆盖/奖励分化/无常合法随机/快照只给 AI 显示）；桌游合集还会验证 3 个 AI 的三种原型都出现在视图里。

### 超大陆 · 十二雄（`grand-front`）

- **12 势力 / 115 区域 / 半径 6**：比 4 人图大 3 倍以上；支持 **2–12 人联机**，未认领或房间人数不足的势力由 AI 接管。
- **生成器参数化**：`radius` 上限从 3 提到 8；12 势力用最远点采样把港口种子均匀撒在外圈，再 BFS 分地；扩展名称池，保证 100+ 区不重名；大地图额外增加港口与初始战争。
- **旧图不动**：4 势力 / 半径 3 走原来的四象限选点与 40 个名称池，旧 `random-front` / `random-front-v2` 的 `contentHash` 与地图逐字不变。
- **网页快速开局**新增「剧本 / 地图规模」选择：随机 4 人或超大陆 12 人；选超大陆后会按 12 势力填充我方/LLM 势力下拉，并自动把其余 11 席交给 AI。
- 桌游合集大厅同样出现「超大陸 · 十二雄」，最多 12 个座位；AI 上限、Host 机器人标签、列国面板和地图缩放都按 12 人调整。酒馆面板的大地图改为可滚动/缩放视口，列国图例显示全部势力。
- 闸门：`tests/deterministic/grand-front.test.ts`（12 势力/100+ 区/同种子复现/领地连通/港口水师/旧哈希不变）、`room.test.ts` 的 10 真人席位房、桌游 `guozhan.test.js` 的 12 人开局。

### 回合复盘 + 开荒 · 自定义地图（`frontier`）

- **回合复盘**：每回合结算后生成 `turn_recap` 事件（所有势力的领地、金、粮、民心、兵力变化）；网页左侧「回合复盘」面板、酒馆日志和桌游报告都会显示。
- **开荒模式**：`frontier` 剧本开局每方只占 1 格，其余 15 格是荒地；荒地自带原住民守军和少量资金。
- **占领流程**：先 `move_units` 把部队送进荒地，再提交 `settle_region`（开荒，基建 Lv1）：需本区兵力 ≥ 原住民、支付金/粮，原住民按比例转兵源并返还少量资金；普通进攻只能驱散原住民，不能直接占领。
- **自定义地图/地名**：`config/scenarios/frontier/` 的 `regions.json`、`layout.json`、`factions.json` 可以直接改地图拓扑、地名、国名、颜色和初始部队；新增剧本目录会被服务端自动发现，网页快速开局/桌游内置 bundle 需分别加入列表（见文档）。
- 闸门：`tests/deterministic/frontier.test.ts`（自定义名/一城开局/派兵开荒/进攻不能占地/拒绝面/快照/复盘）。

### 潜在恨意 + 鬻奴令 + 自动起义（`grand-front`）

- **潜在恨意（grudge）**：宣战 +18、毁约 +12、每场战斗 +2、夺城 +5，交战每回合再 +1；和平每回合 -1、同盟 -2，一纸和约不会清零。恨意 0–100，按势力对记录，双方共享同一条。
- **贸易政策**：交战或恨意 ≥70 → `embargo`（禁运）；中立或恨意 30–69 → `restricted`（受限、报价更高）；和平/同盟且恨意 <30 → `free`（通商）。AI 对高恨意目标进攻门槛更低、低恨意才主动求和；快照/LLM 提示词/三端列国面板都显示恨意与商路。
- **鬻奴令（xunu）**：颁布后每回合 -2 民心、金 +8%，解锁 `trade_slaves`；只能从**相邻**的卖方地块买人，卖方不必同法，但必须非交战且未禁运。
- **贼配军**：买来的奴隶只能编为最低级 `militia`，带 `bandit_conscript` 头衔；每支每回合 +4 本区动乱（与自然 -3 相抵后一支净 +1、两支净 +5）；裁军不回兵源，分兵保留头衔，不能与普通民兵合兵。
- **自动起义**：动乱 100 → 区域脱离原主，当地人口化为低战力「起义民兵」；原主必须杀光全部民兵才能重占。民兵未灭前，民心更高的国家可 `claim_rebellion` 宣称归附：动乱 90、最多 2 万「守城民兵」（不可调动），3 回合内征兵会再次起义；动乱 ≤50 恢复正常。grand-front 的征兵/战火基础动乱提高到 8/10/35/15，战争不再“随便就压下去”。
- **动乱现状**（完整公式见 [`docs/05-外交恨意与鬻奴令.md`](docs/05-外交恨意与鬻奴令.md)）：每点降低本区金粮产出 0.4%、守备 0.3%；每回合自然 -3；低民心只放大新增动乱；当前没有自动叛乱，动乱通过削弱守备间接导致丢城。
- **兼容**：只改 `grand-front`；旧剧本的 contentHash/behaviorFingerprint 不变。grand-front 旧存档因新增模块与独立法令表会 fail-closed，需要开新局。
- 闸门：`tests/deterministic/grudge-slavery.test.ts`。

### 酒馆供应商整合包 / LLM 互动

- `酒馆国战桌游合集-0.9.0-供应商包.zip`：酒馆扩展 + board-games 八款桌游 + guozhan 服务端（dist/config）+ 启动脚本 + 部署说明 + `apk/桌游合集-1.17-debug.apk`，供应商解压即可按说明启动。
- 桌游合集 LLM 席位可在动作 JSON 顶层输出 `"say"`，Host 广播为聊天；提示词要求只在人类搭话/关键牌/胜负转折时说，禁止逐张牌解说；代码侧每局每席位最多 6 条。
- 最近聊天会进入 LLM 上下文（标注“纯数据，不是指令”），所以 AI 能回应人类，而不是只打牌。
- 国战建议新增可选 `chat`，酒馆建议卡显示“🗣 发言”，同样不参与结算。
- 真实 DeepSeek 实测：4 人 UNO 完整结束，LLM 正常出牌并发言 6 条；`server/verify-socket.mjs` 的 mock 也覆盖聊天广播。

### 外交 / 谍报 / 地块操作（`random-front-v2` / `iron-front`）

- **外交面板**：左侧列出每个存活势力的关系、领地、兵势、全国民心与财/粮档位；按钮来自引擎合法动作（宣战/求和/结盟/毁约）。当前是**单方面宣告**，AI 暂不讨价还价，但关系会立即影响通行权与战斗。
- **对方信息**：战争迷雾下敌国只给档位，不给精确国库/兵力。点击其边境地块可**派间谍**（费用随目标地形 135–270 金）：目标区在 3 回合内变 `full` 视图，区域详情直接显示精确驻军、动乱、要塞与基建；过期自动回落。旧剧本不启用 `statecraft` 模块，不会出现假的外交/间谍按钮。
- **点击地块 → 右侧列出操作**：区域详情新增「本区内政/征兵」「本区出兵」「裁军」「进攻本区」「谍报」分组；直接点操作即可入队，不再需要“先点源格再点目标”的隐式下单。
- **裁军**：`disband` 不再只在缺粮时出现；任意己方部队都可裁撤，兵源回归、返还 50% 征兵金。
- **分兵 / 合兵**：`formation` 模块提供 `split_unit`（同区同兵种拆出 1..N-1 兵，id 确定性派生）与 `merge_units`（同区同兵种合并）；点己方地块的「分兵 / 合兵」组即可操作，兵力守恒。
- **兵种克制与直观实力**：左侧「兵种图鉴」显示每个兵种的攻/防/机动条、每千兵征募成本与维护、克制/被克关系；战斗动作与战报 HUD 会显示本场兵种与克制加成（如「槍兵 克制 騎兵 +50%」）。
- **终局提示**：对局结束后合法动作清空，页面显示明确胜者与终局原因，不再残留“已锁定，等待其他席位提交”。
- **动作空间**：人类 UI 合法动作上限提到 90 条（攻击/移动/征兵/基建/外交/间谍/裁军），避免外交与谍报被前面的动作挤出；LLM 快照仍保持 24 条压缩。
- **闸门**：`tests/deterministic/diplomacy-intel.test.ts`（关系真改/间谍 intel 与过期/裁军/终局空动作）。

## 文档在哪

| 文档 | 内容 |
|---|---|
| [`docs/01-案例学习报告.md`](docs/01-案例学习报告.md) | 5 个同类项目的成败复盘 + P1-P15 设计模式 |
| [`docs/02-架构设计文档.md`](docs/02-架构设计文档.md) | 分层架构、数据模型、部署与运维（§7） |
| [`docs/05-外交恨意与鬻奴令.md`](docs/05-外交恨意与鬻奴令.md) | 潜在恨意/贸易政策/鬻奴令/贼配军/自动起义/地区动乱完整公式与调参入口 |
| [`docs/06-开荒与自定义地图.md`](docs/06-开荒与自定义地图.md) | 回合复盘/开荒模式/自定义地图与国名地名/调参入口 |
| [`docs/research/01-tavern-battle-mcp.md`](docs/research/01-tavern-battle-mcp.md) | 酒馆扩展通信模式与 compose 安全基线的参考样本 |
| [`docs/research/02~05`](docs/research/) | Histrategy / Age of New Worlds / WarAgent(CICERO) / OpenRA-RL 调研 |
| [`extensions/sillytavern-guozhan/README.md`](extensions/sillytavern-guozhan/README.md) | 酒馆扩展安装与调用示例 |

## 一键启动

### 路线 A：Docker（推荐，安全基线全套）

```bash
cp .env.example .env        # 填 GUOZHAN_TOKEN（≥24 字符）与 GUOZHAN_ORIGINS，两者必填
npm ci && npm run build     # 镜像只 COPY dist/，构建在宿主机做
# 国内服务器构建镜像时覆盖两个源（默认值不变）：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine #                --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t guozhan .
mkdir -p data && sudo chown -R 1000:1000 data   # ★容器以 node(uid 1000) 运行；bind mount 沿用宿主机属主
docker compose up -d        # guozhan 只绑 127.0.0.1:8788；公网走 caddy 反代（改 deploy/Caddyfile 域名）
docker compose logs -f guozhan
```

compose 安全基线（照抄架构文档 §7.2）：`read_only: true` 根文件系统、`cap_drop: [ALL]`、`no-new-privileges`、`init: true`、端口只绑 loopback、日志限 5m×2、必填环境变量缺失直接拒绝启动。

### 路线 B：裸跑（无 Docker）

```bash
cp .env.example .env        # 裸跑建议 HOST=127.0.0.1，公网交给系统里的 nginx/caddy
./scripts/start.sh          # 前置检查(Node≥24/config/data 可写) → npm ci → build → 前台启动
./scripts/start.sh -d       # 后台启动，PID 写 data/guozhan.pid
./scripts/stop.sh           # 停止
./scripts/backup.sh         # 原子备份 data/index.db + data/rooms/*.db（sqlite3 .backup，缺 sqlite3 则三件套复制）

# 路线 C：systemd 常驻（生产推荐；开机不做 npm ci / build）
sudo cp deploy/guozhan.service /etc/systemd/system/ && sudo systemctl enable --now guozhan
```

### 路线 D：桌游合集（可选，独立进程）

UNO / 斗地主 / 炸弹猫 / 骗子酒馆 / 国战 / 大富翁 / 狼人杀 Web 版随包放在 `board-games/`，零依赖、独立端口（默认 8766），与 guozhan 的 8788 互不影响：

```bash
npm run start:board              # 裸跑：http://127.0.0.1:8766/
# 或 Docker（compose 已含 board-games 服务，端口只绑 loopback）：
docker compose up -d board-games
```

桌游合集还带跨游戏积分榜（我的积分 / 本服榜、今日/本周/总榜、段位），在线对局成绩由服务器写入 `board-games/data/leaderboard.jsonl`（可用 `BOARD_GAMES_DATA_DIR` 改目录）；其 Web 大厅与房间服务（一个进程 = 一个房间；需要多桌时用不同 `BOARD_GAMES_PORT` 启动多个实例）；酒馆扩展的设置抽屉里有「桌游合集」区块，填地址后可新标签页打开或直接在酒馆内嵌 iframe（`127.0.0.1` 只适合酒馆与桌游服务都在同一台本机、且你就在那台机器上打开；否则填服务器的局域网 IP / 反代域名）。远程部署请给 board-games 配一个反代域名（`deploy/Caddyfile` 末尾有示例），HTTPS 酒馆页面不能内嵌 `http://` 地址。桌游合集没有席位令牌，公网部署请自行限制访问；如果配置了 `LLM_API_KEY`，任何房主都能添加 LLM 席位并消耗服务器模型额度。

**APK 1.26 新增第 9 款「群星君主 · 单机」**（`release/桌游合集-guozhan-1.26.apk`）：这是 `civ-monarchs` 的离线单机版，**不进房间服务、不联网也能完整玩一局**。12 国 48 州确定性推演、编年史、DM 修正、席位管理、localStorage 存档；用户可自接 OpenAI 兼容 LLM（Key 只存内存，缺 Key / 超时 / 断网自动降级）；席位身份对任何模型不可见。1.26 修复终局后结算/推演按钮未禁用问题。实现、命令与本轮验收数据见 [`civ-monarchs/android/README.md`](civ-monarchs/android/README.md)，一键出包 `node civ-monarchs/android/build-apk.mjs`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `GUOZHAN_TOKEN` | ★是（compose 强制） | — | 管理端 Bearer 令牌，≥24 字符 |
| `GUOZHAN_ORIGINS` | ★是（compose 强制） | — | 浏览器 Origin 白名单，逗号分隔 |
| `LLM_API_BASE` | 否 | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `LLM_API_KEY` | 否 | 空 | **留空 = 离线纯确定性模式**：规则结算照常，只是没有 AI 建议与 LLM 叙事 |
| `LLM_MODEL` | 否 | `deepseek-chat` | 模型名 |
| `PORT` | 否 | `8788` | 监听端口 |
| `HOST` | 否 | `0.0.0.0`（Docker）/ 建议裸跑 `127.0.0.1` | 监听地址 |
| `DATA_DIR` | 否 | `./data`（Docker 内 `/app/data`） | SQLite 数据目录 |
| `BOARD_GAMES_PORT` | 否 | `8766` | 桌游合集房间服务端口 |
| `BOARD_GAMES_HOST` | 否 | `0.0.0.0` | 桌游合集监听地址；公网请走反代并设 Origin 防火墙 |
| `BOARD_GAMES_DEFAULT_GAME` | 否 | `uno` | 房间默认游戏：`uno/doudizhu/exploding/liarsbar/guozhan/monopoly/werewolf` |
| `BOARD_GAMES_DATA_DIR` | 否 | `board-games/data`（Docker 内 `/app/data`） | 桌游合集积分榜 JSONL 目录 |

## SillyTavern 扩展怎么装

1. 打开 SillyTavern → 扩展面板（三只积木图标）→「安装扩展」
2. 选择 `extensions/sillytavern-guozhan/` 整个目录打包的 zip，或直接把该目录拷进酒馆的 `data/default-user/extensions/`
3. 刷新页面 → 扩展设置里出现「国战」区块 → 填服务器地址 + 席位令牌 → 点「连接」
4. 同一设置区下方「桌游合集」填 `http://127.0.0.1:8766/`（或反代地址）→ 新标签页/内嵌打开；它不使用酒馆席位令牌
5. 详细步骤、调用示例与安全边界见 [`extensions/sillytavern-guozhan/README.md`](extensions/sillytavern-guozhan/README.md)

扩展默认**关闭、opt-in**：不点连接就零流量；令牌只存页面内存，关页（`pagehide`）即断。

## 验收命令清单（`npm run verify` 每步在验什么）

```bash
npm run verify   # = 下面 4 步依次执行，任何一步 EXIT≠0 即验收失败
```

| 步骤 | 命令 | 验什么 |
|---|---|---|
| 1 | `npm run arch-check` | 确定性核心零 IO/零时钟/零系统随机/依赖方向向内（机器强制 P4） |
| 2 | `npm run typecheck` | `tsc --noEmit` 全量类型闸门 |
| 3 | `npm run validate-config` | 配置装载器视角的完整性（五个剧本都要装载成功、无 undefined/NaN） |
| 4 | `npm run test` | **366 条**确定性测试（含桌游合集工件闸门：运行时/启动/扩展入口）：RNG 黄金值、配置闸门（七剧本）、部署安全基线、确定性重放（同种子 digest 逐位相同、换种子必须不同、拒绝不改状态）、房间层集成（真实 SQLite + core）、HTTP/WS/MCP 适配器、AI 判断层（四道闸门/启发式/预算闸）、军师模式端到端（假 LLM → 建议落库 → 人类采纳 → 进结算）、**运行期注册外挂模块**（外交模块不改 core 即可参与结算）、**酒馆扩展传输契约**、**MCP ↔ 真实引擎**（会话/工具/提交/SSE/观战）、**存储层**（WAL 实测/每房间独立库/重启持久/路径穿越/导出轮转）、**全 AI 自动局跑满 40 回合且结束后停住**、并发提交不丢令、aria 端到端、**六角地图布局闸门**（19 区覆盖/不重叠/不越界/不夹带迷雾字段/道路可读）与**前端静态闸门**（DOM id 必须存在/入口齐全/模块语法与导出自检），**铁河棋局**（水师多格水路/陆军绕桥/港口征募/跨水 1-2 格突击/六角邻居与桥对账/旧哈希不变/全 AI 收敛），**随机地图**（同种子逐位复现/换种子不同/多 Seeds 连通与领地管线/全 AI 收敛），**治理规则**（基建逐级效果/低民心放大征兵与战火动乱/地区动乱惩罚产出与守备/同种子同地图）、**外交与谍报**（关系真改/间谍 intel 与过期/裁军/终局空动作）、**分兵合兵**（兵力守恒/id 确定性/跨区跨兵种拒绝）、**兵种克制图鉴**（layout 下发/UI 渲染/战斗证据带克制）、**AI 自我迭代**（复盘指标/lessons/策略参数/启发式消费/只给本席位），**合法动作覆盖**（人类 UI 全量动作不被 per-kind cap 截断/移动后进攻组合动作/机动失败不得偷袭），**国库支出**（高收入钳制回合仍真实扣除基建/国策成本），以及**政令/可读性闸门**（法令图鉴、税率真实税金与动乱、势力显示色对比度、战斗 HUD/战况面板/全国民心与地区动乱/外交/地块操作文案）、**地形经济与变法代价**（地形产出/平民税基/人口增长/变法 −5 民心/税率逐档民心/地形情报费/林地步兵守备/layout 与三端 UI 接线）、**AI 原型**（疾攻/守成/无常分配覆盖/奖励分化/无常合法随机/快照与桌游视图）、**超大陆**（12 势力/115 区生成/同种子复现/10 真人席位/旧图哈希不变）、**恨意与鬻奴令**（宣战/毁约/战斗记恨、贸易禁运、相邻买奴、贼配军头衔/动乱/裁军/分兵/合兵规则）、**自动起义**（动乱 100 起义/原主专属进攻/更高民心宣称/守城锁定/3 回合征兵再叛/动乱 50 恢复）、**回合复盘与开荒**（turn_recap/派兵进荒地/基建 Lv1 占领/自定义地图与国名地名） |

单跑某一块：`node --experimental-strip-types --test --test-reporter=tap tests/deterministic/config.test.ts`

**编译产物冒烟（源码绿 ≠ 能部署）**：

```bash
npm run build            # tsup 打包 + 拷 SQL 资源到 dist/
npm run smoke            # 启 dist/main.js，走完 建房→快照→提交→锁定→AI 行动→结算→战报→事件
npm run verify-room -- <roomId>   # 存档体检：digest 重算、fingerprint 与配置是否还一致
node --experimental-strip-types tools/measure-prompt.ts   # 提示词 token 实测（成本调参）
npm run measure          # 资源占用实测：空载 / 10 房间 / 单回合端到端
LLM_API_KEY=sk-... npm run test:llm   # 真实模型端到端（无 key 自动 skip）
```

## 已知限制

- **构建产物依赖宿主机**：Dockerfile 只 COPY `dist/`，CI/部署机必须先 `npm run build`（镜像内不装 devDependencies，省内存省时间）。
- **基础镜像必须 Node 24+**：存储用内置 `node:sqlite`，22.5–23.3 仍需 `--experimental-sqlite` 标志。好处是镜像里没有任何原生扩展要编译（不再需要 python/make/g++）。
- **LLM 离线模式功能面**：无 `LLM_API_KEY` 时没有 AI 战略建议卡与 LLM 叙事（自动降级为模板叙事），对局规则完全不受影响。
- **酒馆扩展未在真实 SillyTavern 全版本回归**：按 ST 1.12+ 扩展 API 编写（`getContext()` / jQuery / 动态 import `script.js`），不同 ST 分支的 DOM 锚点可能漂移。
- **单机单进程**：每房间一个 SQLite 库、进程内单飞锁，无跨进程协调 —— 这是刻意的（1-2 核目标机型上多进程只会更慢）。
- **剧本目录名即剧本 id**：`config/scenarios/<id>/`，加剧本零代码改动（目录扫描发现，无白名单）。
- **外交是单方面宣告**：`accept_alliance/accept_peace/reject_*` 目前会被 `MALFORMED_PAYLOAD` 拒绝（没有待答复提案状态）；当前直接用 `propose_peace/propose_alliance/declare_war/break_alliance`。
- **法令撤销不退费**：`set_law` 重复启用是幂等操作；关闭法令不返还颁布费。
- **进攻投入比例未暴露到 UI/LLM**：`attack.commitment` 在协议层限 0.1–1，core 也会防御性钳制；当前合法动作一律全军投入，属于预留字段。
- **事件断线补发从 offset 开始**：目前没有独立的事件快照压缩；房间当前状态走 `/snapshot`，事件流只补 `from` 之后的事件。
