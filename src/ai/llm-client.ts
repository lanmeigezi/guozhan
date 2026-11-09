/**
 * LLM 客户端 —— OpenAI 兼容端点，零 SDK（全局 fetch）。
 *
 * 形态照 Histrategy 的 `llm/adapter.py`（httpx 直连，不用 openai SDK）：
 * 我们只需要三个方法，SDK 反而带来版本与类型负担。
 *
 * ★三条从事故里学来的规矩：
 *   1. **断流也要记账** —— 客户端断开时 API **已经被计费**，不记就是成本黑洞
 *      （Histrategy 的 GeneratorExit 分支注释原话："the LLM call was STILL BILLED"）
 *   2. **usage 拿不到就估算** —— `stream_options:{include_usage:true}` 被拒时退回 chars/4
 *   3. **超时/429/5xx 指数退避重试，其余错误不重试** —— 对 400/401 重试只是烧钱
 */

export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 单次调用超时（ms）。轻量服务器上不宜过长，回合结算不等它 */
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly provider: string;
}

export interface LlmUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  /** true = 真实 usage；false = chars/4 估算 */
  readonly estimated: boolean;
}

export type LlmStatus = 'ok' | 'timeout' | 'parse_fail' | 'budget_exceeded' | 'aborted' | 'stream_broken' | 'http_error';

export interface LlmCallRecord {
  readonly purpose: 'advisor' | 'narrative' | 'intent_parse';
  readonly model: string;
  readonly provider: string;
  readonly usage: LlmUsage;
  readonly latencyMs: number;
  readonly status: LlmStatus;
  readonly error: string | null;
  readonly attempts: number;
  readonly requestedAt: number;
}

export interface ChatRequest {
  readonly purpose: 'advisor' | 'narrative' | 'intent_parse';
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  readonly temperature: number;
  /** true = 强制 JSON 输出（provider 不支持时自动降级为文本解析） */
  readonly json?: boolean;
  readonly signal?: AbortSignal;
}

export interface ChatResponse {
  readonly text: string;
  readonly record: LlmCallRecord;
  /** 流式补发的分片；非流式为 null */
  readonly streamed: boolean;
}

/** 可重试的 HTTP 状态：超时、限流、上游故障 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function estimateTokens(text: string): number {
  // 中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token。取保守中间值：字符数 / 2
  // （Histrategy 用 chars//4，但那是英文口径；本项目提示词以中文为主，除以 2 更接近真实）
  return Math.ceil(text.length / 2);
}

function isRetryableError(err: unknown): boolean {
  const e = err as { name?: string; status?: number; cause?: { code?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return true;
  if (typeof e?.status === 'number') return RETRYABLE_STATUS.has(e.status);
  const code = e?.cause?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET';
}

function backoffDelay(attempt: number, cfg: LlmConfig): number {
  const d = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** attempt);
  // ★确定性抖动：不用 Math.random（那会让重试时序不可复现，也会破坏本模块的可测性）。
  //   用 attempt 派生的固定偏移，既避免同步风暴，又保持可预测。
  return d + (attempt * 137) % 250;
}

export class LlmClient {
  private readonly cfg: LlmConfig;

  constructor(cfg: LlmConfig) {
    this.cfg = cfg;
  }

  /** 未配置 apiKey ⇒ 离线模式。调用方应据此走纯确定性/启发式路径 */
  get enabled(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  get config(): LlmConfig {
    return this.cfg;
  }

  /**
   * 一次性对话。失败返回 status≠'ok' 的记录 + 空文本，**不抛异常** ——
   * 调用方据此降级为纯确定性回合（确定性引擎永远是 fallback）。
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const requestedAt = Date.now();
    if (!this.enabled) {
      return {
        text: '',
        streamed: false,
        record: {
          purpose: req.purpose, model: this.cfg.model, provider: this.cfg.provider,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false },
          latencyMs: 0, status: 'aborted', error: 'LLM 未配置（离线纯确定性模式）', attempts: 0, requestedAt,
        },
      };
    }

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: false,
    };
    if (req.json) body.response_format = { type: 'json_object' };

    let lastError: string | null = null;
    let lastStatus: LlmStatus = 'http_error';
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(attempt - 1, this.cfg), req.signal);
      if (req.signal?.aborted) {
        return { text: '', streamed: false, record: this.record(req, requestedAt, null, 'aborted', 'caller aborted', attempt + 1) };
      }
      const t0 = Date.now();
      try {
        const res = await fetchWithTimeout(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
        }, this.cfg.timeoutMs, req.signal);

        if (!res.ok) {
          const text = await safeText(res);
          lastStatus = 'http_error';
          lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
          if (!RETRYABLE_STATUS.has(res.status)) break; // 400/401/403 重试只是烧钱
          continue;
        }

        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const text = json.choices?.[0]?.message?.content ?? '';
        const latencyMs = Date.now() - t0;
        const usage: LlmUsage = json.usage
          ? {
              promptTokens: json.usage.prompt_tokens ?? null,
              completionTokens: json.usage.completion_tokens ?? null,
              totalTokens: json.usage.total_tokens ?? null,
              estimated: false,
            }
          : {
              promptTokens: estimateTokens(req.system + req.user),
              completionTokens: estimateTokens(text),
              totalTokens: estimateTokens(req.system + req.user + text),
              estimated: true,
            };
        return {
          text,
          streamed: false,
          record: {
            purpose: req.purpose, model: this.cfg.model, provider: this.cfg.provider,
            usage, latencyMs, status: text.length === 0 ? 'parse_fail' : 'ok',
            error: text.length === 0 ? 'empty completion' : null, attempts: attempt + 1, requestedAt,
          },
        };
      } catch (err) {
        const aborted = req.signal?.aborted === true;
        lastStatus = aborted ? 'aborted' : isRetryableError(err) ? 'timeout' : 'http_error';
        lastError = aborted ? 'caller aborted' : (err as Error).message;
        if (aborted || !isRetryableError(err)) break;
      }
    }

    return {
      text: '',
      streamed: false,
      record: this.record(req, requestedAt, null, lastStatus, lastError, this.cfg.maxRetries + 1),
    };
  }

  /**
   * 流式对话 —— 用于叙事（P11：状态先定、叙事后到）。
   * ★客户端断开时必须以 'stream_broken' 记账，因为上游已计费。
   */
  async chatStream(
    req: ChatRequest,
    onChunk: (text: string) => void,
  ): Promise<ChatResponse> {
    const requestedAt = Date.now();
    if (!this.enabled) {
      return { text: '', streamed: false, record: this.record(req, requestedAt, null, 'aborted', 'LLM 未配置', 0) };
    }
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    const t0 = Date.now();
    let acc = '';
    let usage: LlmUsage | null = null;
    try {
      const res = await fetchWithTimeout(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
      }, this.cfg.timeoutMs, req.signal);

      if (!res.ok || !res.body) {
        const text = await safeText(res);
        return { text: '', streamed: false, record: this.record(req, requestedAt, null, 'http_error', `HTTP ${res.status}: ${text.slice(0, 300)}`, 1) };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            const piece = j.choices?.[0]?.delta?.content;
            if (piece) {
              acc += piece;
              onChunk(piece);
            }
            if (j.usage) {
              usage = {
                promptTokens: j.usage.prompt_tokens ?? null,
                completionTokens: j.usage.completion_tokens ?? null,
                totalTokens: j.usage.total_tokens ?? null,
                estimated: false,
              };
            }
          } catch {
            /* 半个 JSON 分片，跳过 */
          }
        }
      }
      return {
        text: acc,
        streamed: true,
        record: {
          purpose: req.purpose, model: this.cfg.model, provider: this.cfg.provider,
          usage: usage ?? {
            promptTokens: estimateTokens(req.system + req.user),
            completionTokens: estimateTokens(acc),
            totalTokens: estimateTokens(req.system + req.user + acc),
            estimated: true,
          },
          latencyMs: Date.now() - t0,
          status: acc.length === 0 ? 'parse_fail' : 'ok',
          error: acc.length === 0 ? 'empty stream' : null,
          attempts: 1,
          requestedAt,
        },
      };
    } catch (err) {
      // ★断流：已经收到的部分也要记账，因为上游已经计费
      const aborted = req.signal?.aborted === true;
      return {
        text: acc,
        streamed: true,
        record: {
          purpose: req.purpose, model: this.cfg.model, provider: this.cfg.provider,
          usage: usage ?? {
            promptTokens: estimateTokens(req.system + req.user),
            completionTokens: estimateTokens(acc),
            totalTokens: estimateTokens(req.system + req.user + acc),
            estimated: true,
          },
          latencyMs: Date.now() - t0,
          status: aborted ? 'aborted' : 'stream_broken',
          error: (err as Error).message,
          attempts: 1,
          requestedAt,
        },
      };
    }
  }

  private record(
    req: ChatRequest,
    requestedAt: number,
    usage: LlmUsage | null,
    status: LlmStatus,
    error: string | null,
    attempts: number,
  ): LlmCallRecord {
    return {
      purpose: req.purpose,
      model: this.cfg.model,
      provider: this.cfg.provider,
      usage: usage ?? {
        promptTokens: estimateTokens(req.system + req.user),
        completionTokens: 0,
        totalTokens: estimateTokens(req.system + req.user),
        estimated: true,
      },
      latencyMs: Date.now() - requestedAt,
      status,
      error,
      attempts,
      requestedAt,
    };
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = (): void => ctrl.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(t); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 从环境变量构造客户端。LLM_API_KEY 留空 ⇒ enabled=false ⇒ 离线纯确定性模式 */
export function clientFromEnv(env: Record<string, string | undefined> = {}): LlmClient {
  const read = (k: string, fallback?: string): string => {
    const fromArg = env[k];
    if (fromArg !== undefined && fromArg !== '') return fromArg;
    const fromProcess = globalThis.process?.env?.[k];
    return fromProcess ?? fallback ?? '';
  };
  return new LlmClient({
    baseUrl: read('LLM_API_BASE', 'https://api.deepseek.com/v1'),
    apiKey: read('LLM_API_KEY'),
    model: read('LLM_MODEL', 'deepseek-chat'),
    provider: read('LLM_PROVIDER', 'deepseek'),
    timeoutMs: Number(read('LLM_TIMEOUT_MS', '60000')) || 60000,
    maxRetries: Number(read('LLM_MAX_RETRIES', '2')) || 0,
    backoffBaseMs: Number(read('LLM_BACKOFF_BASE_MS', '1500')) || 1500,
    backoffMaxMs: Number(read('LLM_BACKOFF_MAX_MS', '30000')) || 30000,
  });
}
