/**
 * 四道纯代码闸门（P3）—— LLM 输出到游戏状态之间的唯一通道。
 *
 * 全部来自 Histrategy 的真实事故复盘（每条规则背后都有它的 bug 编号）：
 *
 *   ① schema      字段白名单 + 逐项解析。**逐条剔除，不整包拒绝**
 *   ② guardrail   硬约束剔除 / 软约束钳制 + warning
 *   ③ adjudicate  "LLM narrates, code decides" —— 命令从**引擎给的合法动作**里取，
 *                   不从 LLM 的文字里取；数值提示转成受钳制的 delta
 *   ④ clamp       变化幅度上限（民心单回合 |Δ| ≤ 15 等）
 *
 * ★四道全过之后产出的 `SanitizedLlmDelta` 才允许进 core/apply.ts。
 *   LLM 彻底不可用 / 四道全被剔空 ⇒ 返回 null ⇒ 本回合纯确定性结算，游戏不中断。
 *   这是"确定性引擎永远是 fallback"的落地点。
 *
 * 与架构文档的一处偏差：文档写的是 gates/ 下四个文件，这里合并成一个 gates.ts
 * 的四个导出阶段 —— 四道闸门共享 Violation 累积与上下文，拆开反而要传一堆参数。
 */
import { AdviceOutputSchema, type AdviceOutput, type AdviceViolation, type LegalAction } from '../protocol/advice.ts';
import type { SanitizedLlmDelta } from '../core/apply.ts';
import type { FactionId, GameState, RegionId } from '../core/state.ts';
import { aliveFactions } from '../core/state.ts';

/** 闸门配置（数据驱动，可被剧本覆盖） */
export interface GateLimits {
  /** 单次建议最多采纳几条动作 */
  readonly maxAcceptedActions: number;
  /** 民心单回合 |Δ| 上限（Histrategy：超过就 warning） */
  readonly maxMoraleDeltaPerTurn: number;
  /** 动乱单回合 |Δ| 上限 */
  readonly maxUnrestDeltaPerTurn: number;
  /** magnitude → 具体数值的映射。★LLM 只给档位，数值由这里定 */
  readonly magnitudeToMorale: Readonly<Record<'slight' | 'moderate' | 'strong', number>>;
  /** 外交文本里出现"数值承诺"的判定阈值 */
  readonly numericPromisePattern: string;
}

export const DEFAULT_GATE_LIMITS: GateLimits = {
  maxAcceptedActions: 6,
  maxMoraleDeltaPerTurn: 15,
  maxUnrestDeltaPerTurn: 25,
  magnitudeToMorale: { slight: 2, moderate: 5, strong: 9 },
  /**
   * LLM 不得在外交文本里承诺具体数值（Histrategy 的"话术注入"：玩家说风调雨顺就真给粮+30%）。
   *
   * ★必须同时覆盖两种语序：「送粮 50000 石」（数在名词后）与「增兵十万」（数在名词前）。
   * 第一版只写了"动词+数字+单位"，结果「秦愿送粮 50000 石」完全漏检 ——
   * 名词夹在动词与数字之间，正则断在动词后就接不上数字了。被 gates.test.ts 的坏样本抓出来。
   *
   * 命中是 **soft warning 不是 hard drop**：文书照发，只留痕说明
   * "承诺不会被引擎兑现，数值一律由代码计算"。
   */
  numericPromisePattern:
    '(?:[0-9一二三四五六七八九十百千万两]+\\s*(?:万|千|百)?\\s*余?\\s*(?:兵|粮|糧|金|石|人|匹|乘|艘|座城|城池))' +
    '|(?:(?:兵|粮|糧|金|人)\\s*[0-9一二三四五六七八九十百千万两]+)',
};

export interface GateInput {
  /** LLM 的原始文本输出 */
  readonly raw: string;
  /** 引擎给出的合法动作空间 —— ★锚定基准 */
  readonly legalActions: readonly LegalAction[];
  readonly state: GameState;
  readonly selfFaction: FactionId;
  readonly turn: number;
  readonly limits?: GateLimits;
}

export interface GateResult {
  /** 通过全部四道闸门的产物；null = 全部被剔空或不可解析 ⇒ 本回合纯确定性 */
  readonly delta: SanitizedLlmDelta | null;
  /** 要提交给核心的命令（已从 legalActions 取出，不是 LLM 写的） */
  readonly commands: ReadonlyArray<{ legalActionId: string; command: unknown }>;
  /** 外交文书（纯文本，不改数值） */
  readonly messages: ReadonlyArray<{ to: FactionId | null; publicity: 'public' | 'non-public'; body: string; requireResponse: boolean }>;
  readonly violations: readonly AdviceViolation[];
  /** 解析后的建议原文（供落库审计与酒馆显示）；null = 连解析都失败 */
  readonly output: AdviceOutput | null;
  /** 降级说明：为什么 delta 是 null */
  readonly degradeReason: string | null;
}

// ─────────────────────────────────────────────────────────────
// 多策略 JSON 提取（OpenArma arma_output_processor 的三策略 + 降级）
// ─────────────────────────────────────────────────────────────

export function extractJson(raw: string): { value: unknown; strategy: string } | null {
  const text = raw.trim();
  // 策略 1：直接解析
  try {
    return { value: JSON.parse(text), strategy: 'direct' };
  } catch { /* 继续 */ }
  // 策略 2：```json 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return { value: JSON.parse(fenced[1].trim()), strategy: 'fenced' };
    } catch { /* 继续 */ }
  }
  // 策略 3：最外层花括号
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return { value: JSON.parse(text.slice(first, last + 1)), strategy: 'braces' };
    } catch { /* 放弃 */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ① schema：字段白名单
// ─────────────────────────────────────────────────────────────

/**
 * 用 strip 模式解析：未知字段**丢弃并留痕**，而不是整包拒绝。
 * 依据：Histrategy 的 GuardrailValidator「硬约束违反→该条目剔除（不是整包丢弃）」。
 * 一个多余字段不该让整条建议作废。
 */
function stripParse(raw: unknown): { value: AdviceOutput | null; droppedKeys: string[]; error: string | null } {
  const droppedKeys: string[] = [];
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const known = new Set(Object.keys(AdviceOutputSchema.shape));
    for (const k of Object.keys(raw as Record<string, unknown>)) {
      if (!known.has(k)) droppedKeys.push(k);
    }
  }
  // 先试 strict（能给出精确错误），失败再 strip
  const strict = AdviceOutputSchema.safeParse(raw);
  if (strict.success) return { value: strict.data, droppedKeys, error: null };
  const loose = AdviceOutputSchema.strip().safeParse(raw);
  if (loose.success) return { value: loose.data, droppedKeys, error: null };
  return { value: null, droppedKeys, error: loose.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

// ─────────────────────────────────────────────────────────────
// 提示注入检测
// ─────────────────────────────────────────────────────────────

const INJECTION_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, label: 'ignore-previous-instructions' },
  { re: /disregard\s+(the\s+)?(system|rules)/i, label: 'disregard-system' },
  { re: /^\s*(system|assistant|developer)\s*:/im, label: 'role-spoof' },
  { re: /你(现在|从现在起)是/, label: 'role-reassign-zh' },
  { re: /忽略(以上|之前|前面)(的)?(所有)?(指令|规则|设定)/, label: 'ignore-instructions-zh' },
  { re: /<\s*\/?\s*(system|instructions|tool)/i, label: 'fake-tag' },
];

export function detectInjection(text: string): string | null {
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 主流程：四道闸门
// ─────────────────────────────────────────────────────────────

export function runGates(input: GateInput): GateResult {
  const limits = input.limits ?? DEFAULT_GATE_LIMITS;
  const violations: AdviceViolation[] = [];
  const push = (v: AdviceViolation): void => { violations.push(v); };

  // ── ① schema ──
  const extracted = extractJson(input.raw);
  if (!extracted) {
    push({ path: '<root>', rule: 'json_unparseable', severity: 'hard', action: 'dropped', detail: '三策略提取全部失败，降级为空 delta（本回合纯确定性）' });
    return { delta: null, commands: [], messages: [], violations, output: null, degradeReason: 'json_unparseable' };
  }
  if (extracted.strategy !== 'direct') {
    push({ path: '<root>', rule: `json_extracted_via_${extracted.strategy}`, severity: 'soft', action: 'warned', detail: '未直接输出合法 JSON，靠围栏/花括号策略救回' });
  }
  const parsed = stripParse(extracted.value);
  for (const k of parsed.droppedKeys) {
    push({ path: k, rule: 'unknown_field', severity: 'hard', action: 'dropped', detail: `未知字段 '${k}' 被丢弃（schema 白名单外）` });
  }
  if (!parsed.value) {
    push({ path: '<root>', rule: 'schema_invalid', severity: 'hard', action: 'dropped', detail: parsed.error ?? 'schema 校验失败' });
    return { delta: null, commands: [], messages: [], violations, output: null, degradeReason: 'schema_invalid' };
  }
  const output = parsed.value;

  // ── ② guardrail ──
  const legalById = new Map(input.legalActions.map((a) => [a.id, a]));
  const alive = new Set(aliveFactions(input.state));
  const commands: Array<{ legalActionId: string; command: unknown }> = [];
  const seenActionIds = new Set<string>();

  for (let i = 0; i < output.recommended.length; i++) {
    const rec = output.recommended[i]!;
    const path = `recommended[${i}]`;
    // 注入检测：理由文本不得含指令式内容
    const inj = detectInjection(rec.rationale ?? '');
    if (inj) {
      push({ path, rule: `prompt_injection:${inj}`, severity: 'hard', action: 'dropped', detail: '理由文本含提示注入特征，整条剔除' });
      continue;
    }
    // ★锚定：id 必须在引擎给的合法动作空间里
    const action = legalById.get(rec.legalActionId);
    if (!action) {
      push({ path, rule: 'action_not_in_legal_space', severity: 'hard', action: 'dropped', detail: `'${rec.legalActionId}' 不在本回合合法动作空间内（LLM 幻觉或引用了过期动作）` });
      continue;
    }
    if (seenActionIds.has(rec.legalActionId)) {
      push({ path, rule: 'duplicate_action', severity: 'hard', action: 'dropped', detail: `重复引用 '${rec.legalActionId}'` });
      continue;
    }
    if (commands.length >= limits.maxAcceptedActions) {
      push({ path, rule: 'action_budget_exceeded', severity: 'soft', action: 'dropped', detail: `超过单次建议上限 ${limits.maxAcceptedActions} 条` });
      continue;
    }
    seenActionIds.add(rec.legalActionId);
    // ★命令取自引擎的 legalAction.command，**不是** LLM 写的任何东西
    commands.push({ legalActionId: rec.legalActionId, command: action.command });
  }

  // 外交文书
  const messages: Array<{ to: FactionId | null; publicity: 'public' | 'non-public'; body: string; requireResponse: boolean }> = [];
  const numericPromise = new RegExp(limits.numericPromisePattern);
  for (let i = 0; i < (output.diplomacy?.length ?? 0); i++) {
    const d = output.diplomacy![i]!;
    const path = `diplomacy[${i}]`;
    if (!alive.has(d.to)) {
      push({ path: `${path}.to`, rule: 'unknown_faction', severity: 'hard', action: 'dropped', detail: `'${d.to}' 不是存活势力` });
      continue;
    }
    if (d.to === input.selfFaction) {
      push({ path: `${path}.to`, rule: 'self_target', severity: 'hard', action: 'dropped', detail: '不能与自己外交' });
      continue;
    }
    const inj = detectInjection(d.body);
    if (inj) {
      push({ path: `${path}.body`, rule: `prompt_injection:${inj}`, severity: 'hard', action: 'dropped', detail: '外交文本含提示注入特征' });
      continue;
    }
    if (numericPromise.test(d.body)) {
      // 软约束：不剔除文书，但标记 —— 数值承诺不会被兑现（代码才算数）
      push({ path: `${path}.body`, rule: 'numeric_promise', severity: 'soft', action: 'warned', detail: '外交文本含具体数值承诺；承诺不会被引擎兑现，数值一律由代码计算' });
    }
    messages.push({ to: d.to, publicity: d.publicity, body: d.body, requireResponse: d.intent !== undefined });
  }

  // 士气提示 → 受钳制的 delta
  const moraleAdjustments: Array<{ factionId: FactionId; delta: number; reason: string }> = [];
  for (let i = 0; i < (output.moraleHints?.length ?? 0); i++) {
    const h = output.moraleHints![i]!;
    const path = `moraleHints[${i}]`;
    if (!alive.has(h.factionId)) {
      push({ path: `${path}.factionId`, rule: 'unknown_faction', severity: 'hard', action: 'dropped', detail: `'${h.factionId}' 不是存活势力` });
      continue;
    }
    if (h.direction === 'steady') continue;
    // ★LLM 只给方向+档位，数值由 magnitudeToMorale 映射表决定（P2：LLM 调参数，代码算结果）
    let delta = limits.magnitudeToMorale[h.magnitude] * (h.direction === 'up' ? 1 : -1);
    const inj = detectInjection(h.reason);
    if (inj) {
      push({ path: `${path}.reason`, rule: `prompt_injection:${inj}`, severity: 'hard', action: 'dropped', detail: '理由含提示注入特征' });
      continue;
    }
    // ── ④ clamp ──
    const before = delta;
    delta = Math.max(-limits.maxMoraleDeltaPerTurn, Math.min(limits.maxMoraleDeltaPerTurn, delta));
    if (delta !== before) {
      push({ path, rule: 'morale_delta_clamped', severity: 'soft', action: 'clamped', detail: `${before} 钳制到 ${delta}（单回合上限 ±${limits.maxMoraleDeltaPerTurn}）` });
    }
    moraleAdjustments.push({ factionId: h.factionId, delta, reason: h.reason });
  }

  const delta: SanitizedLlmDelta = {
    ...(moraleAdjustments.length > 0 ? { moraleAdjustments } : {}),
  };
  const empty = moraleAdjustments.length === 0 && commands.length === 0 && messages.length === 0;

  return {
    delta: empty ? null : delta,
    commands,
    messages,
    violations,
    output,
    degradeReason: empty ? 'all_dropped_by_gates' : null,
  };
}

// ─────────────────────────────────────────────────────────────
// 动乱事件闸门（LLM 可提议，但数值被钳制）
// ─────────────────────────────────────────────────────────────

export function adjudicateUnrest(
  proposals: ReadonlyArray<{ regionId: RegionId; magnitude: 'slight' | 'moderate' | 'strong'; severity: 'minor' | 'major' | 'revolt'; reason: string }>,
  state: GameState,
  limits: GateLimits = DEFAULT_GATE_LIMITS,
  violations: AdviceViolation[] = [],
): NonNullable<SanitizedLlmDelta['unrestEvents']> {
  const out: Array<{ regionId: RegionId; delta: number; severity: 'minor' | 'major' | 'revolt'; reason: string }> = [];
  const magnitudeToUnrest = { slight: 5, moderate: 12, strong: 20 } as const;
  proposals.forEach((p, i) => {
    const path = `unrestProposals[${i}]`;
    if (!state.regions[p.regionId]) {
      violations.push({ path: `${path}.regionId`, rule: 'unknown_region', severity: 'hard', action: 'dropped', detail: `'${p.regionId}' 不存在` });
      return;
    }
    const inj = detectInjection(p.reason);
    if (inj) {
      violations.push({ path: `${path}.reason`, rule: `prompt_injection:${inj}`, severity: 'hard', action: 'dropped', detail: '理由含提示注入特征' });
      return;
    }
    let delta: number = magnitudeToUnrest[p.magnitude];
    if (delta > limits.maxUnrestDeltaPerTurn) {
      violations.push({ path, rule: 'unrest_delta_clamped', severity: 'soft', action: 'clamped', detail: `${delta} 钳制到 ${limits.maxUnrestDeltaPerTurn}` });
      delta = limits.maxUnrestDeltaPerTurn;
    }
    out.push({ regionId: p.regionId, delta, severity: p.severity, reason: p.reason });
  });
  return out;
}

/** 把闸门产物合并成最终交给 core 的 delta；全空则返回 null（纯确定性回合） */
export function mergeDelta(
  morale: SanitizedLlmDelta['moraleAdjustments'],
  unrest: SanitizedLlmDelta['unrestEvents'],
): SanitizedLlmDelta | null {
  const hasMorale = morale !== undefined && morale.length > 0;
  const hasUnrest = unrest !== undefined && unrest.length > 0;
  if (!hasMorale && !hasUnrest) return null;
  return {
    ...(hasMorale ? { moraleAdjustments: morale } : {}),
    ...(hasUnrest ? { unrestEvents: unrest } : {}),
  };
}

/** 供测试与诊断：把违规清单压成一行人类可读摘要（进酒馆显示为"⚠️ 军师来报：…"） */
export function summarizeViolations(violations: readonly AdviceViolation[]): string {
  if (violations.length === 0) return '';
  const dropped = violations.filter((v) => v.action === 'dropped').length;
  const clamped = violations.filter((v) => v.action === 'clamped').length;
  const warned = violations.filter((v) => v.action === 'warned').length;
  const parts: string[] = [];
  if (dropped > 0) parts.push(`${dropped} 条被剔除`);
  if (clamped > 0) parts.push(`${clamped} 条被钳制`);
  if (warned > 0) parts.push(`${warned} 条警告`);
  const first = violations.find((v) => v.severity === 'hard');
  return `军师建言经校核：${parts.join('、')}${first ? `（首因：${first.rule}）` : ''}`;
}
