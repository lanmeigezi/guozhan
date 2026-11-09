/* civ-ui.js — 群星君主（离线单机）在桌游合集 APK 内的界面层。
   与 app.js 同为 classic script（Android WebView 从 file:// 不加载 ES module）。
   自包含：只依赖 window.CIVMONARCHS（civ-core.bundle.js）与 init() 注入的 4 个回调。
   本机设置页里的 API Key 只存在 JS 内存，绝不写 localStorage / 存档 / 日志。 */
(function () {
  'use strict';

  var CIV = window.CIVMONARCHS;
  var host = null;
  var hooks = null;
  var SAVE_KEY = 'civmon-offline-v1';
  var reqSeq = 0;
  var stateId = '';
  var ui = {
    tab: 'map', seat: 'civ-01', actionIdx: 0, selectedRegion: null, busy: false,
    diag: [], lastReport: '', note: '',
    form: { seed: '', baseUrl: '', model: '', apiKey: '', dm: false, saveText: '',
      dmType: 'boost', dmTarget: '', dmRegion: '', dmMag: 1, seats: {} },
  };

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function rid() { reqSeq += 1; return 'civ-req-' + reqSeq; }
  function snap() { return host.call('snapshot', { viewerCivId: null }).snapshot; }
  function toast(msg) { if (hooks && hooks.toast) hooks.toast(msg); }
  function rerender() { if (hooks && hooks.rerender) hooks.rerender(); }
  function persist() {
    try { localStorage.setItem(SAVE_KEY, host.call('save').json); } catch (_) { /* 隐私模式/额度满 */ }
  }
  function readSave() {
    try { return localStorage.getItem(SAVE_KEY); } catch (_) { return null; }
  }

  // Android 原生 HTTPS 通道：file:// 页面直连 LLM 端点会被 CORS 拦掉，
  // 壳工程已提供 civLlmChat（HttpURLConnection，Key 只在进程内存）。
  // 桌面浏览器 / 无 bridge 时返回 null，browser-host 自动回退到 fetch。
  function makeNativeTransport() {
    var bridge = window.UnoBtAndroid;
    if (!bridge || typeof bridge.civLlmChat !== 'function' || typeof bridge.llmConfigure !== 'function') return null;
    var pending = {};
    var seq = 0;
    var prev = window.UnoBtOnLlmResponse;
    window.UnoBtOnLlmResponse = function (id, payload) {
      var key = String(id);
      if (key.indexOf('civllm-') === 0) {
        var p = pending[key];
        if (!p) return;
        delete pending[key];
        clearTimeout(p.timer);
        p.resolve(payload && typeof payload === 'object'
          ? { ok: !!payload.ok, text: String(payload.text || ''), error: String(payload.error || '') }
          : { ok: false, error: '原生回执格式异常' });
        return;
      }
      if (typeof prev === 'function') return prev(id, payload);
    };
    return function (cfg, system, user, budget) {
      return new Promise(function (resolve) {
        try { bridge.llmConfigure(cfg.baseUrl, cfg.model, cfg.apiKey); }
        catch (err) { resolve({ ok: false, error: String(err && err.message || err) }); return; }
        seq += 1;
        var id = 'civllm-' + Date.now().toString(36) + '-' + seq;
        var timer = setTimeout(function () {
          delete pending[id];
          resolve({ ok: false, error: '超时' });
        }, budget.timeoutMs);
        pending[id] = { resolve: resolve, timer: timer };
        try {
          bridge.civLlmChat(id, JSON.stringify([
            { role: 'system', content: system }, { role: 'user', content: user },
          ]), budget.maxTokensPerDecision, budget.timeoutMs);
        } catch (err) {
          clearTimeout(timer); delete pending[id];
          resolve({ ok: false, error: String(err && err.message || err) });
        }
      });
    };
  }

  function init(h) {
    hooks = h;
    if (!CIV) { /* bundle 缺失时由 app.js 兜底提示 */ return; }
    host = CIV.createHost({ llmTransport: makeNativeTransport() });
    var old = readSave();
    if (old) {
      var r = host.call('load', { json: old });
      ui.note = r.ok ? ('已恢复上局存档 · 第 ' + r.turn + ' 回合') : ('旧存档不兼容，已开新局');
    } else {
      ui.note = '离线单机 · 无需网络即可游玩';
    }
    var appEl = h.appEl;
    appEl.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-civ-region]') : null;
      if (el) { ui.selectedRegion = el.getAttribute('data-civ-region'); ui.tab = 'map'; rerender(); }
    });
    appEl.addEventListener('input', onField);
    appEl.addEventListener('change', onField);
  }

  function onField(e) {
    var el = e.target;
    var key = el.getAttribute && el.getAttribute('data-civ-field');
    if (!key) return;
    if (el.type === 'checkbox') ui.form[key] = el.checked;
    else ui.form[key] = el.value;
    if (key === 'seat') ui.seat = el.value;
    if (key === 'actionIdx') ui.actionIdx = Number(el.value) || 0;
    if (key.indexOf('llmSeat:') === 0) {
      var id = key.slice(8);
      ui.form.seats[id] = !!el.checked;
    }
  }

  function doCall(op, body, after) {
    var res;
    try { res = host.call(op, body); } catch (err) { toast('操作失败：' + (err && err.message ? err.message : err)); return; }
    Promise.resolve(res).then(function (r) {
      if (r && r.code) { toast(r.message || r.code); return; }
      if (after) after(r);
      persist();
      rerender();
    }).catch(function (err) { toast('操作失败：' + (err && err.message ? err.message : err)); });
  }

  // ---------- 各面板 ----------
  function headHtml(s) {
    var phase = s.phase === 'ended' ? '已终局' : '提交中';
    var win = s.winner ? (' · 胜者 ' + esc(winnerName(s))) : '';
    return '<div class="civ-head">' +
      '<div class="civ-title">群星君主 <span class="civ-tag">离线单机</span></div>' +
      '<div class="civ-sub">第 ' + s.turn + ' 回合 · 纪元 ' + s.year + ' 年 · ' + phase + win + '</div>' +
      '<div class="civ-sub">种子 ' + esc(s.seed) + ' · 状态 ' + esc(stateId.slice(0, 8)) + '</div>' +
      '<div class="hint tiny">' + esc(ui.note) + '</div>' +
      '<div class="btn-row civ-actions">' +
        '<button class="btn small secondary" data-action="civ-back">← 首页</button>' +
        '<button class="btn small secondary" data-action="civ-help">ⓘ 玩法</button>' +
        '<button class="btn small secondary" data-action="civ-new">重开</button>' +
      '</div></div>';
  }
  function winnerName(s) {
    var c = s.civs.filter(function (x) { return x.id === s.winner; })[0];
    return c ? c.name : s.winner;
  }

  function tabsHtml() {
    var tabs = [['map', '地图'], ['ranks', '列强'], ['chron', '编年史'], ['order', '下令'],
      ['dm', 'DM 修正'], ['seats', '席位'], ['llm', 'LLM 设置'], ['save', '存档']];
    return '<div class="civ-tabs">' + tabs.map(function (t) {
      return '<button class="btn small ' + (ui.tab === t[0] ? '' : 'secondary') + '" data-action="civ-tab:' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
  }

  function mapHtml(s) {
    var cols = 8;
    var cells = s.regions.map(function (r) {
      var owner = s.civs.filter(function (c) { return c.id === r.owner; })[0];
      var color = owner ? owner.color : '#3b4055';
      var sel = ui.selectedRegion === r.id ? ' sel' : '';
      return '<div class="civ-region' + sel + '" data-civ-region="' + esc(r.id) + '" style="--own:' + color + '">' +
        '<span class="civ-rname">' + esc(r.name) + '</span>' +
        '<span class="civ-rmeta">' + esc(r.terrainName || r.terrain) + ' · ' + (owner ? esc(owner.name) : '无主') + '</span></div>';
    }).join('');
    var detail = '';
    if (ui.selectedRegion) {
      var r2 = s.regions.filter(function (x) { return x.id === ui.selectedRegion; })[0];
      if (r2) {
        var o = s.civs.filter(function (c) { return c.id === r2.owner; })[0];
        detail = '<div class="civ-detail"><b>' + esc(r2.name) + '</b> · ' + esc(r2.terrainName || r2.terrain) +
          '<br>归属：' + esc(o ? o.name : '无主') + ' · 发展度 ' + esc(r2.development) +
          ' · 人口 ' + esc(r2.population) +
          '<br>产出：粮 ' + esc(r2.yields.food) + ' / 矿 ' + esc(r2.yields.ore) + ' / 能 ' + esc(r2.yields.energy) + '</div>';
      }
    }
    return '<div class="civ-panel"><div class="ai-label">星球政区 · 8 × 6 = 48 州（点地块看详情）</div>' +
      '<div class="civ-map" style="grid-template-columns:repeat(' + cols + ',minmax(0,1fr))">' + cells + '</div>' +
      detail + '</div>';
  }

  function ranksHtml(s) {
    var rows = s.civs.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).map(function (c, i) {
      var st = c.alive ? '' : ' <span class="civ-dead">已亡</span>';
      return '<div class="civ-rank"><span class="civ-dot" style="background:' + esc(c.color) + '"></span>' +
        '<span class="civ-rk">' + (i + 1) + '. ' + esc(c.name) + st + '</span>' +
        '<span class="civ-rv">' + esc(c.epoch) + ' · 科技 ' + Math.round(c.tech) + ' · 分 ' + esc(c.score) + '</span></div>';
    }).join('');
    return '<div class="civ-panel"><div class="ai-label">列强榜（全知数值 · 仅本机）</div>' + rows + '</div>';
  }

  function chronHtml(s) {
    var lines = s.chronicle.slice().reverse().map(function (e) {
      return '<div class="civ-chron"><span class="civ-ct">T' + esc(e.turn) + '</span> ' + esc(e.text) + '</div>';
    }).join('');
    return '<div class="civ-panel"><div class="ai-label">编年史（最近 40 条 · 所有台词由史官统一润色）</div>' +
      '<div class="civ-chron-list">' + (lines || '<p class="hint tiny">暂无纪事</p>') + '</div>' +
      '<div class="ai-label" style="margin-top:12px">本回合战报</div>' +
      '<pre class="civ-report">' + esc(host.call('report').report || '（尚未结算）') + '</pre>' +
      '<div class="btn-row" style="margin-top:8px"><button class="btn small secondary" data-action="civ-copy-report">复制带防注入包裹的战报</button></div></div>';
  }

  function orderHtml(s) {
    var opts = s.civs.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (ui.seat === c.id ? ' selected' : '') + '>' + esc(c.name) + ' · ' + esc(c.monarch) + '</option>';
    }).join('');
    var legal = host.call('actions', { civId: ui.seat }).actions.actions || [];
    if (ui.actionIdx >= legal.length) ui.actionIdx = 0;
    var acts = legal.map(function (a, i) {
      return '<option value="' + i + '"' + (ui.actionIdx === i ? ' selected' : '') + '>' +
        esc(a.label) + (a.targetName ? ' → ' + esc(a.targetName) : '') + ' ×' + esc(a.magnitude) + '</option>';
    }).join('');
    return '<div class="civ-panel"><div class="ai-label">君主下令（触屏选择 · 意图经规则引擎校验）</div>' +
      '<label class="civ-field">席位<select data-civ-field="seat">' + opts + '</select></label>' +
      '<label class="civ-field">合法动作<select data-civ-field="actionIdx">' + (acts || '<option value="0">（无可执行动作）</option>') + '</select></label>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn small" data-action="civ-order"' + (legal.length ? '' : ' disabled') + '>提交意图</button></div>' +
      '<p class="hint tiny">十二国的决策由谁做出对任何模型不可知；本机可随时接管任意席位。未下令的席位结算时由确定性君主补位。</p></div>';
  }

  function dmHtml(s) {
    var types = host.call('rules').dmTypes || [];
    var typeOpts = types.map(function (t) {
      return '<option value="' + esc(t) + '"' + (ui.form.dmType === t ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');
    var civOpts = '<option value="">（天下 / 不指定）</option>' + s.civs.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (ui.form.dmTarget === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
    var regOpts = '<option value="">（不指定州）</option>' + s.regions.map(function (r) {
      return '<option value="' + esc(r.id) + '"' + (ui.form.dmRegion === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>';
    }).join('');
    var magOpts = [1, 2, 3].map(function (m) {
      return '<option value="' + m + '"' + (String(ui.form.dmMag) === String(m) ? ' selected' : '') + '>×' + m + '</option>';
    }).join('');
    return '<div class="civ-panel"><div class="ai-label">DM 修正（权重 0.75 · 每回合最多 4 条）</div>' +
      '<label class="civ-field">类型<select data-civ-field="dmType">' + typeOpts + '</select></label>' +
      '<label class="civ-field">目标文明<select data-civ-field="dmTarget">' + civOpts + '</select></label>' +
      '<label class="civ-field">目标州<select data-civ-field="dmRegion">' + regOpts + '</select></label>' +
      '<label class="civ-field">强度<select data-civ-field="dmMag">' + magOpts + '</select></label>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn small" data-action="civ-dm">提交修正</button></div>' +
      '<p class="hint tiny">DM 只提交修正意图，所有数值由确定性引擎裁决；destroy 仅在 ×3 时生效。</p></div>';
  }

  function seatsHtml(s) {
    var view = host.call('seats').seats;
    var rows = view.seats.map(function (x) {
      var human = x.control === 'human';
      return '<div class="civ-seat"><span class="civ-dot" style="background:' + esc((s.civs.filter(function (c) { return c.id === x.civId; })[0] || {}).color || '#888') + '"></span>' +
        '<span class="civ-rk">' + esc(x.name) + '</span>' +
        '<button class="btn small ' + (human ? '' : 'secondary') + '" data-action="civ-seat:' + esc(x.civId) + '">' + (human ? '人类' : '人机') + '</button></div>';
    }).join('');
    return '<div class="civ-panel"><div class="ai-label">席位管理 · 仅本机可见（严禁截图转发给模型）</div>' + rows +
      '<p class="hint tiny">默认 12 席全人机。点按钮切换「人类 / 人机」；人类可随时用上面的「下单」面板接管。此分配不进入存档、编年史、快照或任何模型提示词。</p></div>';
  }

  function llmHtml(s) {
    var status = host.call('llmStatus').status;
    var seats = s.civs.map(function (c) {
      return '<label class="civ-check"><input type="checkbox" data-civ-field="llmSeat:' + esc(c.id) + '"' +
        (ui.form.seats[c.id] ? ' checked' : '') + ' /> ' + esc(c.name) + '</label>';
    }).join('');
    var diag = ui.diag.length ? ui.diag.map(function (d) {
      return '<div class="civ-diag">' + esc(d.name || d.civId) + ' · ' + (d.source === 'model' ? '模型出意图' : ('确定君主降级' + (d.error ? '（' + esc(String(d.error).slice(0, 26)) + '）' : ''))) + ' · ' + esc(d.ms) + 'ms</div>';
    }).join('') : '<p class="hint tiny">尚未触发模型推演。</p>';
    return '<div class="civ-panel"><div class="ai-label">自接 LLM（可选 · 不填也能完整玩一局）</div>' +
      '<label class="civ-field">OpenAI 兼容端点 baseUrl<input class="chat-input" type="text" data-civ-field="baseUrl" placeholder="https://api.deepseek.com/v1" value="' + esc(ui.form.baseUrl) + '" /></label>' +
      '<label class="civ-field">模型 ID<input class="chat-input" type="text" data-civ-field="model" placeholder="deepseek-chat" value="' + esc(ui.form.model) + '" /></label>' +
      '<label class="civ-field">API Key<input class="chat-input" type="password" data-civ-field="apiKey" placeholder="仅存内存，重启需重填" value="' + esc(ui.form.apiKey) + '" /></label>' +
      '<label class="civ-check"><input type="checkbox" data-civ-field="dm"' + (ui.form.dm ? ' checked' : '') + ' /> 同时让模型提交 DM 修正</label>' +
      '<div class="ai-label" style="margin-top:10px">启用模型的席位（默认全关）</div><div class="civ-seat-grid">' + seats + '</div>' +
      '<div class="btn-row" style="margin-top:10px">' +
        '<button class="btn small" data-action="civ-llm-save">保存配置（仅内存）</button>' +
        '<button class="btn small secondary" data-action="civ-llm-clear">清除 Key</button></div>' +
      '<p class="hint tiny">当前：' + (status.configured ? '已配置 ' + esc(status.model) + '，启用 ' + status.enabledSeats.length + ' 席' : '未配置（12 席全确定性君主）') +
      '。预算：并发 ' + status.budget.concurrency + ' / 超时 ' + status.budget.timeoutMs + 'ms / ' + status.budget.maxTokens + ' tokens。Key 不落盘、不进存档、不进日志；断网 / 错 Key / 超时 / 非法输出会自动降级。</p>' +
      '<div class="ai-label" style="margin-top:10px">最近一次推演回执（仅本机可见）</div>' + diag + '</div>';
  }

  function saveHtml(s) {
    return '<div class="civ-panel"><div class="ai-label">本地存档（自动保存 · 不含 Key 与席位身份）</div>' +
      '<div class="btn-row"><button class="btn small" data-action="civ-export">导出到文本框</button>' +
      '<button class="btn small secondary" data-action="civ-import">从文本框导入</button>' +
      '<button class="btn small secondary" data-action="civ-copy-save">复制存档</button></div>' +
      '<textarea class="civ-save-text" data-civ-field="saveText" placeholder="点「导出到文本框」生成 JSON；也可把别处的存档粘贴到这里再点导入">' + esc(ui.form.saveText) + '</textarea>' +
      '<label class="civ-field">新局种子（留空用默认）<input class="chat-input" type="text" data-civ-field="seed" value="' + esc(ui.form.seed) + '" /></label>' +
      '<p class="hint tiny">存档即权威 state 的 JSON，带 stateId 校验；与 PC 版 0.3.0 存档双向兼容。读档后席位分配回到默认全人机（身份不落盘）。</p></div>';
  }

  function footerHtml(s) {
    // 终局后 advanceTurn 会抛 PHASE_NOT_SUBMITTING；这里从源头置灰，避免误触弹错误 toast。
    var ended = !!s && s.phase === 'ended';
    var dis = (ui.busy || ended) ? ' disabled' : '';
    var hint = ended
      ? '本局已终局' + (s.winner ? '（胜者 ' + esc(winnerName(s)) + '）' : '') + '，请点上方「重开」开始新局；存档仍可导出。'
      : '「结算一回合」永不联网；只有点「让模型推演本回合」才会调用你配置的端点。';
    return '<div class="civ-footer"><div class="btn-row" style="justify-content:center">' +
      '<button class="btn" data-action="civ-advance"' + dis + '>结算一回合</button>' +
      '<button class="btn secondary" data-action="civ-auto"' + dis + '>' + (ui.busy ? '推演中…' : '让模型推演本回合') + '</button>' +
      '</div><p class="hint tiny">' + hint + '</p></div>';
  }

  function renderHtml() {
    if (!host) return '<div class="screen"><p class="hint">群星君主核心未加载。</p></div>';
    var s = snap();
    stateId = s.stateId;
    var body = ui.tab === 'map' ? mapHtml(s)
      : ui.tab === 'ranks' ? ranksHtml(s)
      : ui.tab === 'chron' ? chronHtml(s)
      : ui.tab === 'order' ? orderHtml(s)
      : ui.tab === 'dm' ? dmHtml(s)
      : ui.tab === 'seats' ? seatsHtml(s)
      : ui.tab === 'llm' ? llmHtml(s)
      : saveHtml(s);
    return '<div class="screen civ-screen">' + headHtml(s) + tabsHtml() +
      '<div class="civ-body">' + body + '</div>' + footerHtml(s) + '</div>';
  }

  function enter() {
    if (!CIV) { toast('群星君主核心未加载：请确认 civ-core.bundle.js 已打包进 APK'); return false; }
    if (!host) init(hooks);
    ui.note = ui.note || '离线单机 · 无需网络即可游玩';
    if (hooks && hooks.setScreen) hooks.setScreen('civ');
    if (hooks && hooks.setStatus) hooks.setStatus('群星君主 · 离线单机（无需服务器）');
    rerender();
    return true;
  }

  function copyText(text, label) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed'; area.style.left = '-9999px';
    document.body.appendChild(area); area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(area);
    if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(label + '已复制'); }, function () { toast('复制失败，请手动选中文本'); });
    } else toast(ok ? label + '已复制' : '复制失败，请手动选中文本');
  }

  /** 由 app.js 的 onAction 调用；返回 true 表示该 action 已由本模块消费 */
  function onAction(action) {
    if (!action || action.indexOf('civ-') !== 0) return false;
    if (!host) return true;
    var s = snap();
    stateId = s.stateId;

    // 终局后禁止再下令 / DM / 结算 / 模型推演 / 改席位；重开、返回、看说明、
    // 导出导入存档与 LLM 配置仍可用（配置本身不触发结算）。
    if (s.phase === 'ended' && (action === 'civ-advance' || action === 'civ-auto' ||
        action === 'civ-order' || action === 'civ-dm' || action.indexOf('civ-seat:') === 0)) {
      toast('本局已终局，请点「重开」开始新局'); return true;
    }

    if (action === 'civ-back') { persist(); if (hooks.setScreen) hooks.setScreen('home'); if (hooks.rerender) hooks.rerender(); return true; }
    if (action === 'civ-help') { if (hooks.showHelp) hooks.showHelp('civmonarchs'); return true; }
    if (action === 'civ-new') {
      ui.form.saveText = ''; ui.diag = [];
      doCall('reset', { seed: ui.form.seed || undefined }, function () { ui.note = '已开新局'; });
      return true;
    }
    if (action.indexOf('civ-tab:') === 0) { ui.tab = action.slice(8); rerender(); return true; }
    if (action.indexOf('civ-seat:') === 0) {
      var sid = action.slice(9);
      var view = host.call('seats').seats;
      var cur = view.seats.filter(function (x) { return x.civId === sid; })[0];
      var next = cur && cur.control === 'human' ? 'ai' : 'human';
      doCall('setSeats', { stateId: stateId, requestId: rid(), list: [{ civId: sid, control: next }] });
      return true;
    }
    if (action === 'civ-order') {
      var legal = host.call('actions', { civId: ui.seat }).actions.actions || [];
      var a = legal[Number(ui.form.actionIdx) || 0];
      if (!a) { toast('没有可提交的动作'); return true; }
      doCall('decisions', { stateId: stateId, requestId: rid(), decisions: [a.command] }, function (r) {
        ui.note = (r.accepted.length ? '意图已登记' : '提交被拒绝') + '，点「结算一回合」推进';
      });
      return true;
    }
    if (action === 'civ-dm') {
      var edit = { type: ui.form.dmType, magnitude: Number(ui.form.dmMag) || 1,
        target: ui.form.dmTarget || null, region: ui.form.dmRegion || null, note: '' };
      doCall('dm', { stateId: stateId, requestId: rid(), edits: [edit] }, function (r) {
        ui.note = r.accepted.length ? 'DM 修正已登记（本回合结算时生效）' : '修正被拒绝';
      });
      return true;
    }
    if (action === 'civ-advance') {
      doCall('advance', { stateId: stateId, requestId: rid() }, function (r) {
        ui.note = r.winner ? ('终局判胜：' + r.winner) : ('第 ' + (r.turn - 1) + ' 回合已结算');
      });
      return true;
    }
    if (action === 'civ-auto') {
      if (ui.busy) return true;
      ui.busy = true; rerender();
      Promise.resolve(host.call('auto', { stateId: stateId, requestId: rid(), includeDm: !!ui.form.dm, apply: true }))
        .then(function (r) {
          ui.busy = false;
          if (r && r.code) { toast(r.message || r.code); rerender(); return; }
          ui.diag = r.diagnostics || [];
          var n = ui.diag.filter(function (d) { return d.source === 'model'; }).length;
          ui.note = '模型推演完成：' + n + ' 席由模型出意图，其余自动降级；' +
            (r.advanced ? '第 ' + (r.advanced.turn || r.turn - 1) + ' 回合已结算' : '未结算');
          persist(); rerender();
        }).catch(function (err) { ui.busy = false; toast('推演失败：' + (err && err.message ? err.message : err)); rerender(); });
      return true;
    }
    if (action === 'civ-llm-save') {
      var enabled = [];
      Object.keys(ui.form.seats).forEach(function (k) { if (ui.form.seats[k]) enabled.push(k); });
      var cfg = { baseUrl: ui.form.baseUrl, model: ui.form.model, apiKey: ui.form.apiKey,
        enabledSeats: enabled, dm: !!ui.form.dm };
      var res = host.call('llmConfigure', { config: cfg });
      toast(res.status.configured ? ('已启用 ' + enabled.length + ' 席（Key 仅内存）') : '配置不完整：需要端点 + 模型 ID + Key');
      rerender();
      return true;
    }
    if (action === 'civ-llm-clear') {
      host.call('llmClear'); ui.form.apiKey = ''; ui.form.seats = {}; ui.form.dm = false;
      toast('Key 已清除'); rerender(); return true;
    }
    if (action === 'civ-export') { ui.form.saveText = host.call('save').json; toast('已导出到文本框'); rerender(); return true; }
    if (action === 'civ-import') {
      if (!ui.form.saveText.trim()) { toast('请先粘贴存档 JSON'); return true; }
      doCall('load', { json: ui.form.saveText }, function (r) { ui.note = '存档已导入 · 第 ' + r.turn + ' 回合（席位重置为全人机）'; });
      return true;
    }
    if (action === 'civ-copy-save') { copyText(host.call('save').json, '存档'); return true; }
    if (action === 'civ-copy-report') { copyText(CIV.wrapAsGameData(host.call('report').report || ''), '战报'); return true; }
    return true;
  }

  window.CIVUI = {
    init: init, enter: enter, onAction: onAction, renderHtml: renderHtml,
    saveNow: function () { if (host) persist(); },
    hasCore: function () { return !!CIV; },
    get host() { return host; },
  };
})();
