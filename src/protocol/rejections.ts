/**
 * 稳定拒绝码（P5：表现层永不自己判断"为什么不行"）。
 *
 * 这些码是 wire 契约的一部分：酒馆扩展与 MCP 客户端只负责把它们翻译成人话，
 * 核心的拒绝理由必须逐字稳定，否则 LLM 无法带原因重试。
 *
 * 新增码时只追加、不改语义、不复用编号 —— 旧客户端遇到未知码应显示原文而非崩溃。
 */
export const RejectionCode = {
  /** stateId(CAS) 与当前 state_digest 不符：客户端拿的是过期状态 */
  STALE_REVISION: 'STALE_REVISION',
  /** 当前阶段不接受玩家命令（只有 submitting 阶段接受） */
  PHASE_NOT_SUBMITTING: 'PHASE_NOT_SUBMITTING',
  /** 对局已结束 */
  MATCH_FINISHED: 'MATCH_FINISHED',
  /** 该席位本回合已提交（同时提交模型下不可追加） */
  ORDERS_ALREADY_LOCKED: 'ORDERS_ALREADY_LOCKED',
  /** 席位令牌无权操作该势力 */
  SEAT_NOT_AUTHORIZED: 'SEAT_NOT_AUTHORIZED',
  /** 载荷不符合 zod schema（含多余字段，.strict() 拒绝） */
  MALFORMED_PAYLOAD: 'MALFORMED_PAYLOAD',
  /** 命令类型未注册到任何 RuleModule */
  UNSUPPORTED_COMMAND: 'UNSUPPORTED_COMMAND',

  /** 目标区域不存在 */
  UNKNOWN_REGION: 'UNKNOWN_REGION',
  /** 目标势力不存在 */
  UNKNOWN_FACTION: 'UNKNOWN_FACTION',
  /** 目标部队不存在 */
  UNKNOWN_UNIT: 'UNKNOWN_UNIT',
  /** 目标外交文书不存在 */
  UNKNOWN_MESSAGE: 'UNKNOWN_MESSAGE',
  /** 目标 AI 建议不存在或已过期 */
  UNKNOWN_ADVICE: 'UNKNOWN_ADVICE',

  /** 该区域不属于你 */
  REGION_NOT_OWNED: 'REGION_NOT_OWNED',
  /** 该部队不属于你 */
  UNIT_NOT_OWNED: 'UNIT_NOT_OWNED',
  /** 两区域在邻接图上不相邻（且无合法路径） */
  REGION_NOT_ADJACENT: 'REGION_NOT_ADJACENT',
  /** 移动力不足以抵达 */
  NO_LEGAL_PATH: 'NO_LEGAL_PATH',
  /** 目标区域不可通行（水域等） */
  REGION_IMPASSABLE: 'REGION_IMPASSABLE',
  /** 战争迷雾：目标区域对你不可见 */
  TARGET_NOT_VISIBLE: 'TARGET_NOT_VISIBLE',
  /** 不能以自己为目标 */
  SELF_TARGET_NOT_ALLOWED: 'SELF_TARGET_NOT_ALLOWED',

  /** 国库不足 */
  INSUFFICIENT_GOLD: 'INSUFFICIENT_GOLD',
  /** 粮草不足 */
  INSUFFICIENT_FOOD: 'INSUFFICIENT_FOOD',
  /** 可征兵池不足 */
  INSUFFICIENT_MANPOWER: 'INSUFFICIENT_MANPOWER',
  /** 征兵超过人口比例上限（动态比例 + 疲劳） */
  CONSCRIPT_ABOVE_CAP: 'CONSCRIPT_ABOVE_CAP',
  /** 税率超出 [min_rate, max_rate] */
  TAX_RATE_OUT_OF_RANGE: 'TAX_RATE_OUT_OF_RANGE',
  /** 发展度已满级 */
  DEVELOPMENT_MAXED: 'DEVELOPMENT_MAXED',
  /** 未知兵种类型 */
  UNKNOWN_UNIT_TYPE: 'UNKNOWN_UNIT_TYPE',
  /** 兵种作战域与当前位置不符（如水师不在港口） */
  UNIT_DOMAIN_MISMATCH: 'UNIT_DOMAIN_MISMATCH',
  /** 未知法令 */
  UNKNOWN_LAW: 'UNKNOWN_LAW',
  /** 未颁布对应国策（如未开鬻奴令却买奴） */
  LAW_NOT_ENABLED: 'LAW_NOT_ENABLED',
  /** 贸易政策为禁运（交战或恨意过高） */
  SLAVE_TRADE_EMBARGO: 'SLAVE_TRADE_EMBARGO',
  /** 卖方地块可卖人口不足 */
  SLAVE_POPULATION_INSUFFICIENT: 'SLAVE_POPULATION_INSUFFICIENT',
  /** 目标区域当前没有可宣称的起义政权 */
  REBELLION_NOT_ACTIVE: 'REBELLION_NOT_ACTIVE',
  /** 起义民兵已全灭，不能再宣称 */
  REBELLION_ALREADY_ENDED: 'REBELLION_ALREADY_ENDED',
  /** 宣称国民心不高于原属国 */
  CLAIM_MORALE_TOO_LOW: 'CLAIM_MORALE_TOO_LOW',
  /** 只有原属国能进攻未归附的起义区 */
  REBELLION_NOT_YOURS: 'REBELLION_NOT_YOURS',
  /** 守城民兵不可移动/进攻/编成 */
  GARRISON_LOCKED: 'GARRISON_LOCKED',
  /** 开荒地块已有其他势力部队，不能共占 */
  REGION_CONTESTED: 'REGION_CONTESTED',
  /** 开荒部队本回合刚移动，须下一回合再开荒 */
  FRONTIER_NEEDS_NEXT_TURN: 'FRONTIER_NEEDS_NEXT_TURN',

  /** AI 单回合命令数超出预算（aonw: invalid_ai_command_budget） */
  AI_COMMAND_BUDGET_EXCEEDED: 'AI_COMMAND_BUDGET_EXCEEDED',
  /** 该席位 token 预算已耗尽，本回合降级为纯确定性 */
  TOKEN_BUDGET_EXCEEDED: 'TOKEN_BUDGET_EXCEEDED',
} as const;

export type RejectionCode = (typeof RejectionCode)[keyof typeof RejectionCode];

export const ALL_REJECTION_CODES: readonly RejectionCode[] = Object.freeze(
  Object.values(RejectionCode),
);

/** 单条命令的拒绝结果。reason 面向 LLM 与日志，message 面向人类。 */
export interface Rejection {
  readonly code: RejectionCode;
  /** 机器可读的补充字段，供带原因重试（WarAgent 的校验回路） */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
  /** 人类可读的一句话；酒馆扩展直接显示，不再自行推断 */
  readonly message: string;
}

/** RejectionCode → HTTP 状态码。适配器层用，核心不感知 HTTP。 */
export const REJECTION_HTTP_STATUS: Readonly<Record<RejectionCode, number>> = Object.freeze({
  STALE_REVISION: 409,
  PHASE_NOT_SUBMITTING: 409,
  MATCH_FINISHED: 409,
  ORDERS_ALREADY_LOCKED: 409,
  SEAT_NOT_AUTHORIZED: 403,
  MALFORMED_PAYLOAD: 400,
  UNSUPPORTED_COMMAND: 400,
  UNKNOWN_REGION: 404,
  UNKNOWN_FACTION: 404,
  UNKNOWN_UNIT: 404,
  UNKNOWN_MESSAGE: 404,
  UNKNOWN_ADVICE: 404,
  REGION_NOT_OWNED: 403,
  UNIT_NOT_OWNED: 403,
  REGION_NOT_ADJACENT: 422,
  NO_LEGAL_PATH: 422,
  REGION_IMPASSABLE: 422,
  TARGET_NOT_VISIBLE: 403,
  SELF_TARGET_NOT_ALLOWED: 422,
  INSUFFICIENT_GOLD: 422,
  INSUFFICIENT_FOOD: 422,
  INSUFFICIENT_MANPOWER: 422,
  CONSCRIPT_ABOVE_CAP: 422,
  TAX_RATE_OUT_OF_RANGE: 422,
  DEVELOPMENT_MAXED: 422,
  UNKNOWN_UNIT_TYPE: 400,
  UNIT_DOMAIN_MISMATCH: 422,
  UNKNOWN_LAW: 400,
  LAW_NOT_ENABLED: 422,
  SLAVE_TRADE_EMBARGO: 422,
  SLAVE_POPULATION_INSUFFICIENT: 422,
  REBELLION_NOT_ACTIVE: 422,
  REBELLION_ALREADY_ENDED: 422,
  CLAIM_MORALE_TOO_LOW: 422,
  REBELLION_NOT_YOURS: 403,
  GARRISON_LOCKED: 422,
  REGION_CONTESTED: 422,
  FRONTIER_NEEDS_NEXT_TURN: 422,
  AI_COMMAND_BUDGET_EXCEEDED: 422,
  TOKEN_BUDGET_EXCEEDED: 429,
});
