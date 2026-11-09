/**
 * 酒馆扩展的**传输层**（无 DOM、无 jQuery，可在 Node 里做契约测试）。
 *
 * ★为什么单独抽出来：扩展此前把服务端响应形状猜错了三处（快照没解包 {snapshot}、
 *   WS 地址写成 /rooms/:id/events、事件按单条而非批次解析），而酒馆里跑不起来就没人发现。
 *   把这些"形状"集中在这里，就能用真实服务端跑 `tests/deterministic/extension-contract.test.ts`。
 *
 * 约定：
 *   · 用户只填服务器地址（http://host:8788 或 http://host:8788/api 都行）
 *   · 令牌只走 Authorization 头（浏览器 WS 无法带头 ⇒ 仅 WS 走查询参数）
 *   · 任何非 2xx 都返回结构化错误，绝不静默
 */

/** @param {{baseUrl:string, token:string, roomId:string, seatId:string, fetchImpl?:Function, WebSocketImpl?:Function}} opts */
export function createGuozhanClient(opts) {
    const raw = String(opts.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!raw) throw new Error('服务器地址不能为空');
    const apiBase = /\/api$/.test(raw) ? raw : `${raw}/api`;
    const wsBase = raw.replace(/^http/, 'ws').replace(/\/api$/, '');
    const token = String(opts.token ?? '');
    const roomId = String(opts.roomId ?? '');
    const seatId = String(opts.seatId ?? '');
    const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
    if (!token) throw new Error('席位令牌不能为空');
    if (!roomId) throw new Error('房间 ID 不能为空');

    let stateId = null;

    function headers(json = true) {
        /** @type {Record<string,string>} */
        const h = { Authorization: `Bearer ${token}` };
        if (json) h['Content-Type'] = 'application/json';
        return h;
    }

    async function call(method, path, body) {
        const resp = await doFetch(`${apiBase}${path}`, {
            method,
            headers: headers(body !== undefined),
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await resp.text();
        let json = null;
        try {
            json = text.length > 0 ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        return { ok: resp.ok, status: resp.status, json, text };
    }

    return {
        get stateId() {
            return stateId;
        },
        set stateId(v) {
            stateId = v;
        },
        get apiBase() {
            return apiBase;
        },

        /**
         * 静态地图布局（六角坐标/画布/阵营色/首都）。连上后拉一次即可；
         * 归属与兵力仍以 snapshot() 为准，布局只回答"画在哪"。
         */
        async layout() {
            const r = await call('GET', `/rooms/${encodeURIComponent(roomId)}/layout`);
            if (!r.ok) throw new Error(`读取地图布局失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            const layout = r.json?.layout;
            if (!layout || typeof layout !== 'object') throw new Error('布局响应缺少 layout 字段');
            return layout;
        },

        /** 拉快照并刷新 CAS 锚点；返回**解包后**的 Snapshot */
        async snapshot() {
            const r = await call('GET', `/rooms/${encodeURIComponent(roomId)}/snapshot`);
            if (!r.ok) throw new Error(`拉取快照失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            const snap = r.json?.snapshot;
            if (!snap || typeof snap !== 'object') throw new Error('快照响应缺少 snapshot 字段');
            if (typeof snap.stateId !== 'string' || snap.stateId.length === 0) throw new Error('快照缺少 stateId');
            stateId = snap.stateId;
            return snap;
        },

        /** 本席位合法动作（含命令体）。人类 UI 直接取 action.command 提交，不自己拼。 */
        async legalActions() {
            const r = await call('GET', `/rooms/${encodeURIComponent(roomId)}/actions`);
            if (!r.ok) throw new Error(`读取合法动作失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            return r.json;
        },

        /** 提交 1-8 条命令；返回 {ok, status, result}，409 由调用方决定是否重拉快照 */
        async submit(commands, requestId) {
            if (!stateId) throw new Error('尚无 stateId：请先拉快照');
            return call('POST', `/rooms/${encodeURIComponent(roomId)}/commands`, {
                stateId,
                requestId,
                commands,
            });
        },

        /** 声明本回合提交完毕；返回 {locked, waiting} */
        async lock() {
            const r = await call('POST', `/rooms/${encodeURIComponent(roomId)}/lock`);
            if (!r.ok) throw new Error(`锁定失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            return r.json;
        },

        /** 请求一次军师建议（人类席位按需触发；LLM 未配置时返回 {skipped}） */
        async requestAdvice() {
            const r = await call('POST', `/rooms/${encodeURIComponent(roomId)}/advice`);
            if (!r.ok) throw new Error(`请求建议失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            return r.json;
        },

        /** 列出本席位尚未处理的建议（重连后补显示用） */
        async pendingAdvice() {
            const r = await call('GET', `/rooms/${encodeURIComponent(roomId)}/advice`);
            if (!r.ok) throw new Error(`读取建议失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            return r.json?.advice ?? [];
        },

        /** 采纳 AI 建议（走专用端点，不塞进 commands） */
        async adopt(adviceId, commandIndices) {
            const r = await call('POST', `/rooms/${encodeURIComponent(roomId)}/advice/${encodeURIComponent(adviceId)}/adopt`, {
                ...(commandIndices !== undefined ? { commandIndices } : {}),
            });
            if (!r.ok) throw new Error(`采纳失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            return r.json;
        },

        async report(turn) {
            const r = await call('GET', `/rooms/${encodeURIComponent(roomId)}/turns/${turn}`);
            if (!r.ok) throw new Error(`战报读取失败 HTTP ${r.status}`);
            return r.json?.report ?? null;
        },

        /**
         * 完整对局记忆（逐回合战报 + 原始事件流 + 外交文书）。
         * 酒馆/外部压缩器直接消费此 JSON；玩家席位拿到的版本已按战争迷雾裁剪。
         */
        async memory() {
            const r = await call('GET', `/rooms/${encodeURIComponent(roomId)}/memory`);
            if (!r.ok) throw new Error(`对局记忆读取失败 HTTP ${r.status}：${r.text.slice(0, 200)}`);
            const memory = r.json?.memory;
            if (!memory || typeof memory !== 'object' || memory.format !== 'guozhan-match-memory') {
                throw new Error('对局记忆响应格式不正确');
            }
            return memory;
        },

        /** WS 地址（导出供测试断言；浏览器侧无需拼接） */
        eventsUrl(from = 0) {
            const params = new URLSearchParams({ room: roomId, token });
            if (from > 0) params.set('from', String(from));
            return `${wsBase}/ws?${params.toString()}`;
        },

        /**
         * 订阅事件。**服务端发的是批次** {roomId, events:[{offset,event}], stateDigest, turn}，
         * 这里逐条回调，并把最大 offset 交还调用方用于断线补发。
         */
        events({ from = 0, onBatch, onOpen, onClose, onError } = {}) {
            const ws = new WS(this.eventsUrl(from));
            let lastOffset = from > 0 ? from - 1 : -1;
            ws.onopen = () => {
                if (onOpen) onOpen();
            };
            ws.onmessage = (evt) => {
                let batch;
                try {
                    batch = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
                } catch {
                    return;
                }
                if (!Array.isArray(batch?.events)) return;
                for (const item of batch.events) {
                    if (typeof item?.offset === 'number') lastOffset = Math.max(lastOffset, item.offset);
                    if (onBatch) onBatch(item.event, item.offset, batch);
                }
            };
            ws.onclose = () => {
                if (onClose) onClose(lastOffset + 1);
            };
            ws.onerror = (err) => {
                if (onError) onError(err);
            };
            return {
                close() {
                    ws.onclose = null;
                    try {
                        ws.close();
                    } catch {
                        /* 已关闭 */
                    }
                },
                get lastOffset() {
                    return lastOffset;
                },
            };
        },
    };
}
