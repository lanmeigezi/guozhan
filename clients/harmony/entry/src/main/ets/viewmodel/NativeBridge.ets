import { BleTransport } from './BleTransport';
import http from '@ohos.net.http';

/**
 * Injected into the WebView as window.UnoBtAndroid via javaScriptProxy.
 * HarmonyOS javaScriptProxy supports synchronous methods, so getters mirror
 * Android's BtJsBridge directly.
 */
export class NativeBridge {
  private role: string;
  private game: string;
  private roomUrl: string | null;
  private ble?: BleTransport;
  private onJs: (script: string) => void;
  private baseUrl: string = '';
  private model: string = '';
  private apiKey: string = '';

  constructor(role: string, game: string, roomUrl: string | null, onJs: (script: string) => void) {
    this.role = role;
    this.game = game;
    this.roomUrl = roomUrl;
    this.onJs = onJs;
    if (role === 'host' || role === 'guest') {
      this.ble = new BleTransport(role, onJs);
    }
  }

  getRole(): string { return this.role; }
  getGame(): string { return this.game; }
  getRoomUrl(): string | null { return this.roomUrl; }
  getDeviceName(): string { return '鸿蒙设备'; }

  openServer(): void { this.ble?.openServer(); }
  closeServer(): void { this.ble?.closeServer(); }
  findAndConnect(): void { this.ble?.findAndConnect(); }
  disconnect(): void { this.ble?.disconnect(); }
  sendToChannel(id: number, b64: string): void { this.ble?.sendToChannel(id, b64); }
  closeChannel(id: number): void { this.ble?.closeChannel(id); }
  sendToHost(b64: string): void { this.ble?.sendToHost(b64); }

  llmInfo(): string {
    return JSON.stringify({
      configured: this.apiKey.length > 0 && this.baseUrl.length > 0,
      baseUrl: this.baseUrl,
      model: this.model,
    });
  }

  llmConfigure(base: string, model: string, key: string): boolean {
    const b = base.trim();
    const k = key.trim().length > 0 ? key.trim() : this.apiKey;
    if (b.length === 0 || k.length === 0) return false;
    this.baseUrl = b;
    this.model = model.trim().length > 0 ? model.trim() : 'deepseek-chat';
    this.apiKey = k;
    return true;
  }

  llmClear(): void { this.baseUrl = ''; this.model = ''; this.apiKey = ''; }

  llmChat(requestId: string, messagesJson: string): void {
    this.chat(requestId, messagesJson, 450, 30000);
  }

  civLlmChat(requestId: string, messagesJson: string, maxTokens: number, timeoutMs: number): void {
    this.chat(requestId, messagesJson, maxTokens, timeoutMs);
  }

  private chat(requestId: string, messagesJson: string, maxTokens: number, timeoutMs: number): void {
    if (!this.apiKey || !this.baseUrl) { this.llmResult(requestId, false, 'LLM 未配置'); return; }
    const base = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const body = JSON.stringify({
      model: this.model || 'deepseek-chat',
      messages: JSON.parse(messagesJson),
      temperature: 0.35,
      max_tokens: maxTokens,
      stream: false,
    });
    const req = http.createHttp();
    req.request(endpoint, {
      method: http.RequestMethod.POST,
      header: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      extraData: body,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    }, (err: BusinessError, data: http.HttpResponse) => {
      if (err) { this.llmResult(requestId, false, err.message); return; }
      try {
        const json = JSON.parse(String(data.result));
        const text = json?.choices?.[0]?.message?.content?.trim() ?? '';
        if (!text) this.llmResult(requestId, false, 'LLM 返回空内容');
        else this.llmResult(requestId, true, text);
      } catch (e) {
        this.llmResult(requestId, false, String(e));
      }
      req.destroy();
    });
  }

  private llmResult(requestId: string, ok: boolean, text: string): void {
    const payload = ok ? { ok: true, text } : { ok: false, error: text };
    this.onJs(`window.UnoBtOnLlmResponse(${JSON.stringify(requestId)},${JSON.stringify(payload)})`);
  }
}
