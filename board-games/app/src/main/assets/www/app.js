/* app.js — UNO-BT / 联机桌游合集 UI. Runs in the Android WebView (with a native
   Bluetooth bridge) or in a desktop/mobile browser (web mode).
   - On-device (Android): bridge = window.UnoBtAndroid (BT host/guest), as before.
   - Web (browser): a home/room lobby — host a local game vs AI, or join a room
     server over WebSocket (PC-web / Android WebView / iOS WebView all use this).
   In-game text chat + emoji bar are available in the lobby and the game. */
(function () {
  'use strict';

  var U = window.UNOKU;
  var CIVUI = window.CIVUI || null;   // 群星君主 · 离线单机（civ-ui.js）
  var native = window.UnoBtAndroid || null;
  var bridge = native
    ? {
        role: native.getRole ? native.getRole() : 'demo',
        deviceName: native.getDeviceName ? native.getDeviceName() : '玩家',
        openServer: native.openServer ? function () { native.openServer(); } : null,
        closeServer: native.closeServer ? function () { native.closeServer(); } : null,
        findAndConnect: native.findAndConnect ? function () { native.findAndConnect(); } : null,
        sendToChannel: function (id, b64) { native.sendToChannel(id, b64); },
        closeChannel: function (id) { native.closeChannel(id); },
        sendToHost: function (b64) { native.sendToHost(b64); },
        disconnect: function () { native.disconnect(); },
        getRoomUrl: native.getRoomUrl ? function () { return native.getRoomUrl(); } : null,
        getGame: native.getGame ? function () { return native.getGame(); } : null,
        llmInfo: native.llmInfo ? function () { return native.llmInfo(); } : null,
        llmConfigure: native.llmConfigure ? function (base, model, key) { return native.llmConfigure(base, model, key); } : null,
        llmClear: native.llmClear ? function () { native.llmClear(); } : null,
        llmChat: native.llmChat ? function (id, json) { native.llmChat(id, json); } : null,
      }
    : null;
  var appEl = document.getElementById('app');
  var statusEl = document.getElementById('status');
  var roleEl = document.getElementById('role');
  var toastEl = document.getElementById('toast');

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setStatus(t) { statusEl.textContent = t; }
  var toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2400); }
  function b64(bytes) { var bin = ''; for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); }
  function unb64(str) { var bin = atob(str); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  var COLOR_ZH = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
  function colorName(c) { return COLOR_ZH[c] || c; }
  // A stable per-device id so the room server can bind/reclaim a player's seat
  // across reconnects (prevents a lingering connection leaving a ghost seat).
  var _devId = null;
  function deviceId() {
    if (_devId) return _devId;
    try {
      _devId = localStorage.getItem('unoBt-dev');
      if (!_devId) { _devId = 'dev-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36); localStorage.setItem('unoBt-dev', _devId); }
    } catch (_) { _devId = 'dev-' + Math.random().toString(36).slice(2, 10); }
    return _devId;
  }

  // ---- transports ----
  // U.Transport is an ES class in the generated bundle, so it cannot be invoked
  // via .call(this); initialize onMessage/onDisconnect directly instead.
  function BridgeTransport(sendBytes, closeFn) { this.onMessage = null; this.onDisconnect = null; this._sendBytes = sendBytes; this._closeFn = closeFn; }
  BridgeTransport.prototype = Object.create(U.Transport.prototype);
  BridgeTransport.prototype.send = function (bytes) { this._sendBytes(bytes); };
  BridgeTransport.prototype.close = function () { if (this._closeFn) this._closeFn(); };

  function WsTransport(ws) {
    this.onMessage = null; this.onDisconnect = null; this.ws = ws; ws.binaryType = 'arraybuffer'; var self = this;
    ws.onmessage = function (e) {
      var d = e.data;
      var bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : (d && d.buffer ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null);
      if (bytes && self.onMessage) self.onMessage(bytes);
    };
    ws.onclose = function () { if (self.onDisconnect) self.onDisconnect(); };
    ws.onerror = function () { setStatus('与房间服务器连接异常'); };
  }
  WsTransport.prototype = Object.create(U.Transport.prototype);
  WsTransport.prototype.send = function (bytes) { this.ws.send(bytes); };
  WsTransport.prototype.close = function () { try { this.ws.close(); } catch (_) {} };

  // ---- state ----
  var st = {
    screen: 'boot',
    role: bridge ? bridge.role : 'web',
    you: 0, hostSeat: 0, seats: [], view: null, last: null,
    prevHandIds: [], drawnId: null, pendingWildId: null, guestState: 'connecting',
    aiCount: 0, game: null, gameName: '', name: '玩家', wsUrl: '',
    chat: [], owner: false, selectedDdz: [], ekSelected: [], ekFavorCard: null, ekAttackCard: null, ekShuffleSel: [],
    chatText: '', lastPingAt: Date.now(), connOk: false, idleTimeout: 180000, pingNoteIdx: 0,
    mods: [], modFiles: [],
    llmCount: 0, llmSeats: [], llmAvailable: false, llmModel: '', llmBase: '', llmCfg: null,
    gzSelected: null, gzScenario: 'random-front-v2', gzSeed: '', gzUnlimited: true, gzZoom: 1, chatTo: null,
    lastScore: null,
    lb: { tab: 'mine', range: 'all', server: null, loading: false, error: '', seq: 0 },
  };
  var MAX_AI = 7;
  function maxAiForGame() {
    var def = U.getGame && st.game ? U.getGame(st.game) : null;
    var max = (def && def.max ? def.max : 8);
    if (st.game === 'guozhan') {
      var sc = (U.GZ_SCENARIOS || []).filter(function (x) { return x.id === (st.gzScenario || 'random-front-v2'); })[0];
      if (sc && sc.maxPlayers) max = sc.maxPlayers;
    }
    var humans = Math.max(1, (st.seats && st.seats.length ? st.seats.length : 1) - (st.aiCount || 0));
    return Math.max(0, max - humans);
  }
  function maxLlmForGame() {
    var def = U.getGame && st.game ? U.getGame(st.game) : null;
    var max = (def && def.max ? def.max : 8);
    var fixed = Math.max(1, (st.seats && st.seats.length ? st.seats.length : 1) - (st.llmCount || 0));
    return Math.max(0, Math.min(7, max - fixed));
  }
  function syncLlm(delta) {
    var target = Math.max(0, Math.min(7, (st.llmCount || 0) + delta));
    target = Math.min(target, maxLlmForGame());
    st.llmCount = target;
    if (client) client.send({ t: 'llm', op: 'set', count: target });
    else if (host && host.setLlmCount) host.setLlmCount(target);
  }
  var BOT_LABEL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  var EMOJI = ['😀','😂','😊','😎','😭','😡','😱','❤️','👍','👎','🎉','🙏','😅','🤔','😴','🥳','🔥','💀','🤡','😇'];
  var chatBound = false;

  var host = null, client = null, clientTransport = null;
  var channels = new Map();
  var demoStop = false;
  var localLlmDriver = null;
  var llmWaiters = {};
  var llmReqSeq = 0;

  // Native bridge callback for the on-device LLM seat.
  window.UnoBtOnLlmResponse = function (requestId, payload) {
    var waiter = llmWaiters[requestId];
    if (!waiter) return;
    delete llmWaiters[requestId];
    clearTimeout(waiter.timer);
    if (payload && payload.ok) waiter.resolve(String(payload.text || ''));
    else waiter.reject(new Error((payload && payload.error) || 'LLM 调用失败'));
  };

  function localLlmChat(messages) {
    if (bridge && bridge.llmChat) {
      return new Promise(function (resolve, reject) {
        var id = 'llm-' + Date.now().toString(36) + '-' + (++llmReqSeq);
        var timer = setTimeout(function () {
          delete llmWaiters[id];
          reject(new Error('LLM 请求超时'));
        }, 45000);
        llmWaiters[id] = { resolve: resolve, reject: reject, timer: timer };
        try { bridge.llmChat(id, JSON.stringify(messages)); }
        catch (err) { clearTimeout(timer); delete llmWaiters[id]; reject(err); }
      });
    }
    // Desktop web local mode: direct OpenAI-compatible fetch. Some providers
    // block browser CORS; Android uses the native bridge above instead.
    var cfg = st.llmCfg;
    if (!cfg || !cfg.key || !cfg.baseUrl) return Promise.reject(new Error('LLM 未配置'));
    var base = cfg.baseUrl.replace(/\/+$/, '');
    var url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model || 'deepseek-chat',
        messages: messages,
        temperature: 0.35,
        max_tokens: 450,
        stream: false,
      }),
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error('LLM HTTP ' + res.status + ': ' + text.slice(0, 300));
        var data = JSON.parse(text);
        var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 返回空内容');
        return content;
      });
    });
  }

  function ensureLocalLlmDriver() {
    if (localLlmDriver) return localLlmDriver;
    if (!U.createLlmDriver) return null;
    localLlmDriver = U.createLlmDriver(localLlmChat);
    var info = null;
    try { if (bridge && bridge.llmInfo) info = JSON.parse(bridge.llmInfo()); } catch (_) { info = null; }
    if (info && info.configured) {
      st.llmBase = info.baseUrl || '';
      st.llmModel = info.model || '';
      localLlmDriver.configure({ available: true, baseUrl: st.llmBase, model: st.llmModel });
    } else if (!bridge && st.llmCfg && st.llmCfg.key) {
      st.llmBase = st.llmCfg.baseUrl || '';
      st.llmModel = st.llmCfg.model || '';
      localLlmDriver.configure({ available: true, baseUrl: st.llmBase, model: st.llmModel });
    } else {
      st.llmBase = '';
      st.llmModel = '';
      localLlmDriver.configure({ available: false, baseUrl: '', model: '' });
    }
    return localLlmDriver;
  }

  function configureLocalLlm(baseUrl, model, key) {
    var base = String(baseUrl || '').trim();
    var m = String(model || '').trim() || 'deepseek-chat';
    var k = String(key || '').trim();
    var hasExisting = localLlmDriver && localLlmDriver.available === true;
    if (!base || (!k && !hasExisting)) { toast('请填写 API 地址和 Key'); return false; }
    var driver = ensureLocalLlmDriver();
    if (!driver) { toast('当前版本不支持本机 LLM'); return false; }
    if (bridge && bridge.llmConfigure) {
      if (!bridge.llmConfigure(base, m, k)) { toast('配置失败'); return false; }
      st.llmBase = base; st.llmModel = m;
      driver.configure({ available: true, baseUrl: base, model: m });
    } else {
      st.llmCfg = { baseUrl: base, model: m, key: k || (st.llmCfg && st.llmCfg.key) || '' };
      st.llmBase = base; st.llmModel = m;
      driver.configure({ available: true, baseUrl: base, model: m });
    }
    if (host) host.broadcastLobby();
    toast('LLM 已配置：' + m);
    return true;
  }

  function showLlmSettings() {
    var old = document.getElementById('llmSettings'); if (old) old.remove();
    var modal = document.createElement('div');
    modal.className = 'overlay'; modal.id = 'llmSettings';
    modal.innerHTML = '<div class="modal llm-settings-modal"><h2>LLM 玩家位设置</h2>' +
      '<p class="hint tiny">Key 只保留在' + (bridge ? ' Android 原生内存' : '当前页面内存') + '，不会发给其他玩家或房间服务器。App 进程结束后需要重新填写。</p>' +
      '<label class="llm-field">API 地址<input id="llmBase" class="chat-input" type="text" placeholder="https://api.deepseek.com/v1" value="' + esc(st.llmBase || 'https://api.deepseek.com/v1') + '" /></label>' +
      '<label class="llm-field">模型<input id="llmModel" class="chat-input" type="text" placeholder="deepseek-chat" value="' + esc(st.llmModel || 'deepseek-chat') + '" /></label>' +
      '<label class="llm-field">API Key<input id="llmKey" class="chat-input" type="password" placeholder="sk-..." value="" /></label>' +
      '<div class="btn-row" style="justify-content:center;margin-top:10px"><button class="btn" data-action="llm-save">保存</button> <button class="btn secondary" data-action="llm-cancel">取消</button></div>' +
      '</div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { modal.remove(); return; }
      var b = e.target.closest('[data-action]'); if (!b) return;
      if (b.getAttribute('data-action') === 'llm-cancel') { modal.remove(); return; }
      if (b.getAttribute('data-action') === 'llm-save') {
        var baseEl = document.getElementById('llmBase'), modelEl = document.getElementById('llmModel'), keyEl = document.getElementById('llmKey');
        if (configureLocalLlm(baseEl && baseEl.value, modelEl && modelEl.value, keyEl && keyEl.value)) modal.remove();
      }
    });
    document.body.appendChild(modal);
    var input = document.getElementById('llmKey'); if (input) setTimeout(function () { input.focus(); }, 30);
  }

  // ============ ON-DEVICE (Android Bluetooth) ============
  window.UnoBtOnJoin = function (channelId) {
    if (st.role !== 'host') return;
    var t = new BridgeTransport(function (bytes) { bridge.sendToChannel(channelId, b64(bytes)); }, function () { bridge.closeChannel(channelId); });
    channels.set(channelId, t); host.addTransport(t); setStatus('有玩家正在加入…');
  };
  window.UnoBtOnData = function (channelId, b64str) {
    var bytes = unb64(b64str);
    if (st.role === 'host') { var t = channels.get(channelId); if (t && t.onMessage) t.onMessage(bytes); }
    else if (clientTransport && clientTransport.onMessage) clientTransport.onMessage(bytes);
  };
  window.UnoBtOnDisconnect = function (channelId) { var t = channels.get(channelId); if (t && t.onDisconnect) t.onDisconnect(); channels.delete(channelId); };
  window.UnoBtOnConnected = function () {
    if (st.role !== 'guest') return;
    client.send({ t: 'join', name: bridge.deviceName || '玩家', deviceId: deviceId(), game: st.game || 'uno' }); st.guestState = 'connected'; setStatus('已连接，等待主机开始…');
    if (st.screen === 'guest-home') render();
  };
  window.UnoBtOnStatus = handleStatus;
  function handleStatus(text) {
    setStatus(text);
    if (st.role === 'guest' && /(连接失败|超时|不可用|无法连接|断)/.test(text)) { st.guestState = 'failed'; if (st.screen === 'guest-home') render(); }
  }

  function bootDevice() {
    if (bridge && bridge.getGame) st.game = bridge.getGame() || st.game || 'uno';
    if (st.role === 'host') bootHost();
    else if (st.role === 'guest') bootGuest();
    else bootDemo('uno');
  }
  function bootHost() {
    var name = (bridge && bridge.deviceName) || '主机'; st.game = st.game || 'uno';
    var driver = ensureLocalLlmDriver();
    host = new U.Host({ game: st.game, playerName: name, options: { unoPenalty: true }, llm: driver });
    host.onLocalUpdate = applyUpdate; roleEl.textContent = '主机'; roleEl.classList.remove('guest');
    host.broadcastLobby();
    if (bridge && bridge.openServer) bridge.openServer();
    setStatus('蓝牙服务已开启，等待玩家…');
  }
  function bootGuest() {
    clientTransport = new BridgeTransport(function (bytes) { bridge.sendToHost(b64(bytes)); }, function () { bridge.disconnect(); });
    client = new U.Client({ transport: clientTransport });
    client.onMessage = onGuestMessage;
    client.onDisconnect = function () { setStatus('与主机断开连接'); if (st.screen !== 'lobby') { st.screen = 'broke'; render(); } };
    roleEl.textContent = '玩家'; roleEl.classList.add('guest'); st.guestState = 'connecting'; st.screen = 'guest-home'; render();
    if (bridge && bridge.findAndConnect) bridge.findAndConnect();
  }

  // ============ LOCAL GAME (host + AI, offline) ============
  function bootDemo(gameKey) {
    st.role = 'demo';
    st.wsUrl = '';
    st.game = gameKey || 'uno'; st.gameName = (U.getGame ? U.getGame(st.game).name : st.game);
    roleEl.textContent = '演示'; roleEl.classList.add('guest'); demoStop = false;
    var driver = ensureLocalLlmDriver();
    host = new U.Host({ game: st.game, playerName: '主机', options: { unoPenalty: true }, llm: driver });
    host.onLocalUpdate = applyUpdate;
    host.broadcastLobby();
    st.aiCount = 2; syncAi();
    setStatus('演示：您作为主机，可添加AI对手后开始。');
  }
  function syncAi() {
    var target = Math.max(0, Math.min(maxAiForGame(), st.aiCount));
    st.aiCount = target;
    if (host) {
      while (host.botSeats.size > target) { host.removeBot(Math.max.apply(null, Array.from(host.botSeats))); }
      // Each addBot broadcasts a lobby update, which overwrites st.aiCount; keep
      // the requested target in a local variable so the loop cannot stop early.
      while (host.botSeats.size < target) { host.addBot('机器人' + BOT_LABEL[host.botSeats.size]); }
      st.aiCount = target;
    } else if (client) {
      client.send({ t: 'bot', op: 'set', count: target });
    }
  }
  var _stallKey = ''; var _stallCount = 0;
  function _key(g) { return g.phase + '|' + (g.current == null ? '' : g.current) + '|' + ((g.counts || []).join(',')) + '|' + (g.pendingDefuse ? 1 : 0) + (g.pendingFavor ? 1 : 0) + (g.pendingRoulette ? 1 : 0); }
  // 保守动作：AI 抛错或反复不推进时用它兜底，保证桌子永远不冻。
  function _fallbackAct() {
    return host.gameKey === 'guozhan' ? { kind: 'gz_lock' }
      : host.gameKey === 'uno' || host.gameKey === 'exploding' ? { kind: 'draw' }
        : host.gameKey === 'doudizhu' ? { kind: 'pass' }
          : { kind: 'call' };
  }
  function _botAct(seat) {
    return host.botActionSafe ? host.botActionSafe(seat) : host.ai(seat);
  }
  function botLoop() {
    if (demoStop || !host) return;
    var g = host.game; if (!g) return;
    if (g.phase !== 'playing' && g.phase !== 'bidding') return;
    try {
      // A pending Favor: the *target* (which may be a bot) must hand a card.
      if (g.pendingFavor && host.isBotSeat(g.pendingFavor.target)) {
        var tseat = g.pendingFavor.target;
        var tact = _botAct(tseat);
        if (tact) host.execute(tseat, { t: 'act', kind: tact.kind, ...tact });
        setTimeout(botLoop, 500); return;
      }
      // 炸弹猫: a bot that just drew a bomb must defuse or die.
      if (g.pendingDefuse && host.isBotSeat(g.pendingDefuse.seat)) {
        var dseat = g.pendingDefuse.seat;
        var dact = _botAct(dseat);
        if (dact) host.execute(dseat, { t: 'act', kind: dact.kind, ...dact });
        setTimeout(botLoop, 500); return;
      }
      // 骗子酒馆: a bot that lost a challenge must pull the trigger.
      if (g.pendingRoulette && host.isBotSeat(g.pendingRoulette.seat)) {
        host.execute(g.pendingRoulette.seat, { t: 'act', kind: 'fire' });
        setTimeout(botLoop, 500); return;
      }
      var seat = g.current;
      if (seat == null) return;
      if (host.isBotSeat(seat)) {
        var act = _botAct(seat);
        if (act) {
          var k0 = _key(g);
          host.execute(seat, { t: 'act', kind: act.kind, ...act });
          // Watchdog: if the same bot move never advances the game, force a safe move
          // so an AI can never hard-lock the round.
          _stallCount = (_key(g) === k0) ? _stallCount + 1 : 0;
          if (_stallCount > 4) { host.execute(seat, { t: 'act', ..._fallbackAct() }); _stallCount = 0; }
        }
        setTimeout(botLoop, 700); return;
      }
    } catch (e) {
      // 任何异常（包括 AI 契约 bug）都不能终止循环：记一次停滞，必要时强制保守动作。
      console.error('[botLoop]', e);
      _stallCount += 1;
      if (_stallCount > 2 && host.game && g.current != null) {
        try { host.execute(g.current, { t: 'act', ..._fallbackAct() }); } catch (e2) { /* 交给下一轮 */ }
        _stallCount = 0;
      }
    }
    setTimeout(botLoop, 700);
  }

  // ============ WEB MODE ============
  function bootWeb() {
    roleEl.textContent = '网页'; roleEl.classList.add('guest');
    var params = new URLSearchParams(location.search);
    st.wsUrl = params.get('room') || (location.protocol.indexOf('http') === 0 ? location.origin.replace(/^http/, 'ws') + '/ws' : '');
    if (params.get('room')) connectRoom(st.wsUrl);
    else { st.screen = 'home'; render(); loadModList(); }
  }
  function connectRoom(wsUrl, name) {
    st.wsUrl = wsUrl; st.name = name || st.name || '玩家';
    st.screen = 'guest-home'; st.guestState = 'connecting'; render();
    function open() {
      var ws;
      try { ws = new WebSocket(wsUrl); } catch (e) { toast('无法连接房间'); return; }
      clientTransport = new WsTransport(ws);
      client = new U.Client({ transport: clientTransport });
      client.onMessage = onGuestMessage;
      client.onDisconnect = function () { setStatus('与房间断开连接'); if (st.screen !== 'lobby') { st.screen = 'broke'; render(); } };
      ws.onopen = function () { client.send({ t: 'join', name: st.name, deviceId: deviceId(), game: st.game || 'uno' }); setStatus('已加入房间，等待…'); };
      ws.onerror = function () { setStatus('连接房间失败'); if (st.screen === 'guest-home') { st.guestState = 'failed'; render(); } };
    }
    // A user-picked game wins; a bare `?room=` / pasted address should adopt the
    // room server's launched game instead of racing the fetch and joining as UNO.
    if (st.game) { loadModList(); open(); return; }
    var base = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
    var settled = false;
    var fallback = setTimeout(function () {
      if (settled) return;
      settled = true;
      loadModList();
      open();
    }, 900);
    fetch(base + '/api/room').then(function (r) { return r.json(); }).then(function (d) {
      if (settled) return;
      settled = true; clearTimeout(fallback);
      if (d && d.game && U.getGame) { st.game = d.game; st.gameName = U.getGame(d.game).name; }
      loadModList();
      open();
    }).catch(function () {
      if (settled) return;
      settled = true; clearTimeout(fallback);
      loadModList();
      open();
    });
  }

  // ---- message handling (device guest + web client) ----
  function onGuestMessage(msg) {
    if (msg.t === 'lobby') {
      st.screen = 'lobby'; st.seats = msg.seats; st.you = msg.you; st.hostSeat = msg.hostSeat;
      st.game = msg.game || st.game; st.gameName = msg.gameName || st.gameName; st.owner = msg.hostSeat === msg.you;
      if (msg.aiCount != null) st.aiCount = msg.aiCount;
      if (msg.llmCount != null) st.llmCount = msg.llmCount;
      if (msg.llmSeats) st.llmSeats = msg.llmSeats;
      if (msg.llmAvailable != null) st.llmAvailable = msg.llmAvailable;
      if (msg.llmModel != null) st.llmModel = msg.llmModel;
      if (msg.idleTimeout) st.idleTimeout = msg.idleTimeout;
      render();
    } else if (msg.t === 'state') {
      var prevPhase = st.view && st.view.phase;
      st.screen = 'game'; st.view = msg.view; st.last = msg.last; st.game = msg.game || st.game; st.gameName = msg.gameName || st.gameName;
      if (prevPhase === 'roundEnd' && msg.view && msg.view.phase !== 'roundEnd') st.lastScore = null;
      if (st.game === 'guozhan' && st.view) setStatus('国战 · 第 ' + st.view.turn + ' 回合');
      st.selectedDdz = []; st.ekSelected = []; st.ekFavorCard = null; st.ekAttackCard = null; st.ekShuffleSel = []; st.liarSelected = []; if (st.game === 'uno') trackDrawn(); render();
    } else if (msg.t === 'score') {
      handleScore(msg.score);
    } else if (msg.t === 'chat') {
      st.chat.push({ from: msg.from, text: msg.text, to: msg.to }); if (st.chat.length > 60) st.chat.shift();
      if (st.screen === 'lobby' || st.screen === 'game') render();
    } else if (msg.t === 'ping') {
      // keep-alive pong: mark connected, reset the disconnect countdown, and on a
      // manual ping add a "recently fixed" note to the chat so waiting isn't dull.
      var manual = st._manualPing; st._manualPing = false;
      st.connOk = true; st.lastPingAt = Date.now();
      if (manual) { st.chat.push({ from: '系统', text: pingNote() }); if (st.chat.length > 60) st.chat.shift(); if (st.screen === 'lobby' || st.screen === 'game') render(); }
      updatePingUi();
    } else if (msg.t === 'error') { toast(msg.message); }
  }
  function applyUpdate(payload) {
    if (payload.t === 'lobby') {
      st.screen = 'lobby'; st.seats = payload.seats; st.you = payload.you; st.hostSeat = payload.hostSeat;
      st.game = payload.game || st.game; st.gameName = payload.gameName || st.gameName; st.owner = payload.hostSeat === payload.you;
      if (payload.aiCount != null) st.aiCount = payload.aiCount;
      if (payload.llmCount != null) st.llmCount = payload.llmCount;
      if (payload.llmSeats) st.llmSeats = payload.llmSeats;
      if (payload.llmAvailable != null) st.llmAvailable = payload.llmAvailable;
      if (payload.llmModel != null) st.llmModel = payload.llmModel;
      render();
    } else if (payload.t === 'state') {
      var prevPhase2 = st.view && st.view.phase;
      st.screen = 'game'; st.view = payload.view; st.last = payload.last; st.game = payload.game || st.game; st.gameName = payload.gameName || st.gameName;
      if (prevPhase2 === 'roundEnd' && payload.view && payload.view.phase !== 'roundEnd') st.lastScore = null;
      if (st.game === 'guozhan' && st.view) setStatus('国战 · 第 ' + st.view.turn + ' 回合');
      st.selectedDdz = []; st.ekSelected = []; st.ekFavorCard = null; st.ekAttackCard = null; st.ekShuffleSel = []; st.liarSelected = []; if (st.game === 'uno') trackDrawn(); render();
      if (st.view && st.view.phase === 'roundEnd') clearLocalSave(); else saveLocalGame();
    } else if (payload.t === 'score') {
      handleScore(payload.score);
    } else if (payload.t === 'chat') {
      st.chat.push({ from: payload.from, text: payload.text, to: payload.to }); if (st.chat.length > 60) st.chat.shift();
      if (st.screen === 'lobby' || st.screen === 'game') render();
    } else if (payload.t === 'error') { toast(payload.message); }
  }
  // ---- cross-game scoreboard ----
  var SCORES_KEY = 'unoBt-scores-v1';
  var _memScores = [];
  function loadScoreEvents() {
    try {
      var raw = localStorage.getItem(SCORES_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return _memScores; }
  }
  function persistScoreEvents(events) {
    _memScores = events;
    try { localStorage.setItem(SCORES_KEY, JSON.stringify(events)); } catch (_) {}
  }

  // ---- 本地对局存档：退出/切后台后还能接着打 ----
  // ⚠️ 快照是上帝视角（含所有人手牌与身份），只写本机 localStorage，绝不上送服务端、不进聊天/日志。
  var SAVE_KEY = 'unoBt-save-v1';
  var SAVE_VERSION_LOCAL = 1;
  function readLocalSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || s.v !== SAVE_VERSION_LOCAL || !s.gameKey || !s.game) return null;
      if (!(U.getGame && U.getGame(s.gameKey))) return null; // Mod 被卸载后不再提供继续
      var phase = s.game.phase;
      if (phase !== 'playing' && phase !== 'bidding') return null; // 局末/大厅状态不算
      return s;
    } catch (_) { return null; }
  }
  function saveLocalGame() {
    if (!host || client || typeof host.captureSave !== 'function') return;
    // 只有"全本地座位"（本机真人 + AI）才能安全恢复；带远程客人的房间恢复后
    // 那些座位没有传输通道，会变成永远等不到人的死局。
    if (host.remote || (host.guests && host.guests.size > 0)) return;
    var g = host.game;
    if (!g || (g.phase !== 'playing' && g.phase !== 'bidding')) return;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(host.captureSave())); } catch (_) { /* 隐私模式/额度满：跳过 */ }
  }
  function clearLocalSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (_) {}
  }
  function saveSummary(s) {
    var g = s.game || {};
    var names = (g.players || []).map(function (p) { return p && p.name; }).filter(Boolean).join('、');
    var d = s.capturedAt ? new Date(s.capturedAt) : null;
    var when = d ? (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '';
    return {
      name: s.gameName || s.gameKey,
      sub: names || '',
      turn: g.turnCount != null ? ('第 ' + g.turnCount + ' 回合') : '',
      when: when,
    };
  }
  function resumeLocalSave() {
    var s = readLocalSave();
    if (!s) { toast('没有可继续的对局'); render(); return; }
    try {
      var driver = ensureLocalLlmDriver();
      demoStop = false;
      st.role = 'demo'; st.wsUrl = '';
      st.game = s.gameKey; st.gameName = s.gameName || s.gameKey;
      host = new U.Host({
        game: s.gameKey,
        playerName: (s.host && s.host.playerNames && s.host.playerNames[0]) || '主机',
        options: { unoPenalty: true },
        llm: driver,
      });
      host.onLocalUpdate = applyUpdate;
      var res = host.restoreSave(s);
      st.you = host.localSeat == null ? 0 : host.localSeat;
      st.aiCount = host.botSeats.size;
      st.llmSeats = Array.from(host.llmSeats || []);
      roleEl.textContent = '演示'; roleEl.classList.add('guest');
      st.screen = 'game';
      host.broadcastGame();
      setStatus('已恢复上一局 · ' + (s.gameName || s.gameKey) + (res && res.phase ? '（' + res.phase + '）' : ''));
      botLoop();
    } catch (e) {
      clearLocalSave();
      toast('存档恢复失败：' + (e && e.message ? e.message : e));
      st.screen = 'home'; render();
    }
  }
  function saveScoreEvent(score) {
    if (!score || !score.matchId) return;
    var events = loadScoreEvents();
    var id = score.matchId + ':' + (score.seat == null ? 0 : score.seat);
    for (var i = events.length - 1; i >= 0; i--) if (events[i] && events[i].id === id) return;
    events.push({
      v: U.SCORE_VERSION || 1, id: id, playerKey: deviceId(), name: score.name || st.name || '玩家',
      game: score.game, endedAt: score.endedAt || new Date().toISOString(),
      durationSec: score.durationSec || 0, outcome: score.outcome, points: Math.max(0, score.points || 0),
      players: score.playerCount || 0, humans: score.humanCount || 0,
    });
    if (events.length > 2000) events = events.slice(events.length - 2000);
    persistScoreEvents(events);
  }
  function handleScore(score) {
    if (!score) return;
    st.lastScore = score;
    saveScoreEvent(score);
    if (st.screen === 'game') render();
    if (document.getElementById('lbModal')) renderLeaderboardModal();
  }
  function scoreRangeStart(range) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    if (range === 'week') {
      var day = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - day);
    }
    return range === 'all' ? 0 : d.getTime();
  }
  function aggregateLocal(range) {
    return U.aggregateScoreEvents(loadScoreEvents(), { range: range || 'all' });
  }
  function myScoreRow(rows) {
    var key = deviceId();
    return (rows || []).filter(function (r) { return r.key === key; })[0] || null;
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Number(sec) || 0);
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ' 分' + (s ? ' ' + s + ' 秒' : '');
  }
  function fmtScoreDate(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function outcomeLabel(outcome) {
    return outcome === 'win' ? '胜利' : outcome === 'draw' ? '平局' : '参与';
  }
  function scoreSummaryHtml() {
    if (!st.lastScore) return '<div class="score-card pending"><div class="score-points">积分结算中…</div></div>';
    var s = st.lastScore, d = s.detail || {};
    var cls = s.outcome === 'win' ? 'win' : s.outcome === 'draw' ? 'draw' : 'loss';
    var breakLine = d.base != null
      ? '基础 ' + d.base + ' × 人数 ' + d.sizeFactor + ' × 时长 ' + d.durationFactor + ' × 真人 ' + d.humanFactor + ' × 胜负 ' + d.resultFactor
      : '';
    return '<div class="score-card ' + cls + '">' +
      '<div class="score-head"><span class="score-outcome">' + outcomeLabel(s.outcome) + '</span><span class="score-points">+' + (s.points || 0) + ' 分</span></div>' +
      '<div class="score-meta">' + esc(s.gameName || s.game || '') + ' · ' + fmtDuration(s.durationSec) + ' · ' + (s.playerCount || 0) + ' 人局（真人 ' + (s.humanCount || 0) + '）</div>' +
      (breakLine ? '<div class="score-break">' + esc(breakLine) + '</div>' : '') +
      '<div class="btn-row" style="justify-content:center;margin-top:8px"><button class="btn secondary small" data-action="leaderboard">查看积分榜</button></div></div>';
  }
  function scoreRulesHtml() {
    var rules = U.SCORE_RULES || {};
    var formula = U.SCORE_FORMULA || {};
    var rows = Object.keys(rules).map(function (key) {
      var r = rules[key];
      return '<tr><td>' + esc(r.name || key) + '</td><td>' + r.base + '</td><td>' + r.parMin + ' 分钟</td></tr>';
    }).join('');
    return '<details class="lb-rules"><summary>积分怎么算？</summary>' +
      '<p class="hint small">胜利积分 = 基础分 × 人数系数 × 时长系数 × 真人系数 × 胜负系数；只给真人座位计分。</p>' +
      '<ul class="lb-formula-list">' +
      '<li>人数：' + esc(formula.size || '') + '</li>' +
      '<li>时长：' + esc(formula.duration || '') + '</li>' +
      '<li>真人：' + esc(formula.human || '') + '（AI/LLM 不计分，只计入人数）</li>' +
      '<li>胜负：胜 ×1、平 ×0.4、负 ×0.1（参与分）</li>' +
      '</ul>' +
      '<table class="lb-rules-table"><thead><tr><th>游戏</th><th>基础分</th><th>参考时长</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="hint tiny">参考时长用于把不同游戏的“每分钟精力”拉齐：越复杂、越耗时的游戏基础分越高，但短局不会因为刷局数压过长局。我的积分含本地/蓝牙/在线真人局；本服榜只含在线房间对局。</p></details>';
  }
  function showLeaderboard(tab) {
    if (tab) st.lb.tab = tab;
    if (!canServerBoard() && st.lb.tab === 'server') st.lb.tab = 'mine';
    var old = document.getElementById('lbModal'); if (old) old.remove();
    var modal = document.createElement('div'); modal.className = 'overlay lb-overlay'; modal.id = 'lbModal';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { modal.remove(); return; }
      var tabBtn = e.target.closest('[data-lb-tab]');
      if (tabBtn) {
        st.lb.tab = tabBtn.getAttribute('data-lb-tab');
        st.lb.server = null; st.lb.error = '';
        renderLeaderboardModal();
        if (st.lb.tab === 'server') loadServerLeaderboard();
        return;
      }
      var rangeBtn = e.target.closest('[data-lb-range]');
      if (rangeBtn) {
        st.lb.range = rangeBtn.getAttribute('data-lb-range');
        st.lb.server = null; st.lb.error = '';
        renderLeaderboardModal();
        if (st.lb.tab === 'server') loadServerLeaderboard();
        return;
      }
      if (e.target.closest('[data-lb-refresh]')) {
        if (st.lb.tab === 'server') loadServerLeaderboard();
        else renderLeaderboardModal();
        return;
      }
      if (e.target.closest('[data-lb-close]')) modal.remove();
    });
    renderLeaderboardModal();
    if (st.lb.tab === 'server' && !st.lb.server) loadServerLeaderboard();
  }
  function canServerBoard() { return !!client && !!st.wsUrl; }
  function roomHttpBase() {
    var u = st.wsUrl || '';
    var m = u.match(/^(wss?):\/\/([^/]+)/i);
    if (m) return (m[1].toLowerCase() === 'wss' ? 'https' : 'http') + '://' + m[2];
    return apiBase();
  }
  function loadServerLeaderboard() {
    if (!canServerBoard()) return;
    var seq = ++st.lb.seq;
    st.lb.loading = true; st.lb.error = '';
    renderLeaderboardModal();
    fetch(roomHttpBase() + '/api/leaderboard?range=' + encodeURIComponent(st.lb.range) + '&limit=50', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (seq !== st.lb.seq) return;
        if (!d || !d.ok) throw new Error((d && d.error) || '读取失败');
        st.lb.server = d; st.lb.loading = false;
        renderLeaderboardModal();
      })
      .catch(function (e) {
        if (seq !== st.lb.seq) return;
        st.lb.loading = false; st.lb.error = e && e.message ? e.message : '读取失败';
        renderLeaderboardModal();
      });
  }
  function myLeaderboardHtml() {
    var allRows = aggregateLocal('all');
    var meAll = myScoreRow(allRows);
    var rangeRows = aggregateLocal(st.lb.range);
    var me = myScoreRow(rangeRows);
    var pointsAll = meAll ? meAll.points : 0;
    var tier = U.tierFor(pointsAll);
    var progress = Math.round(tier.progress * 100);
    var hero = '<div class="lb-hero"><div class="lb-tier">' + esc(tier.name) + '</div>' +
      '<div class="lb-total">' + pointsAll + ' <span>总分</span></div>' +
      '<div class="lb-progress"><span style="width:' + progress + '%"></span></div>' +
      '<div class="hint tiny">' + (tier.next ? '距离「' + esc(tier.next) + '」还差 ' + tier.toNext + ' 分' : '已达最高段位') + '</div></div>';
    var rangeName = st.lb.range === 'today' ? '今日' : st.lb.range === 'week' ? '本周' : '总榜';
    var stats = me
      ? '<div class="lb-stats"><div><b>' + me.points + '</b><span>' + rangeName + '积分</span></div><div><b>' + me.wins + '</b><span>胜场</span></div><div><b>' + me.plays + '</b><span>对局</span></div><div><b>' + Math.round(me.winRate * 100) + '%</b><span>胜率</span></div></div>'
      : '<p class="hint">还没有已结算的真人对局。本地、蓝牙或在线打完一局就会开始累计。</p>';
    var gameRows = me ? Object.keys(me.games).sort(function (a, b) { return me.games[b].points - me.games[a].points; }).map(function (key) {
      var g = me.games[key], rule = (U.SCORE_RULES || {})[key] || {};
      return '<div class="lb-game-row"><span>' + esc(rule.name || key) + '</span><span>' + g.plays + ' 局 · ' + g.wins + ' 胜</span><b>' + g.points + ' 分</b></div>';
    }).join('') : '';
    var cutoff = scoreRangeStart(st.lb.range);
    var recent = loadScoreEvents().filter(function (ev) { return Date.parse(ev.endedAt || '') >= cutoff; })
      .sort(function (a, b) { return Date.parse(b.endedAt) - Date.parse(a.endedAt); }).slice(0, 8).map(function (ev) {
        var rule = (U.SCORE_RULES || {})[ev.game] || {};
        return '<div class="lb-recent-row"><span>' + esc(rule.name || ev.game) + ' · ' + esc(outcomeLabel(ev.outcome)) + '</span><b>+' + (ev.points || 0) + '</b><span class="muted">' + esc(fmtScoreDate(ev.endedAt)) + '</span></div>';
      }).join('');
    return hero + stats +
      (gameRows ? '<div class="lb-section"><div class="lb-section-title">' + rangeName + '游戏战绩</div>' + gameRows + '</div>' : '') +
      (recent ? '<div class="lb-section"><div class="lb-section-title">最近对局</div>' + recent + '</div>' : '') +
      scoreRulesHtml();
  }
  function serverLeaderboardHtml() {
    if (!canServerBoard()) return '<p class="hint">连上房间服务器后可以查看本服排行榜。</p>';
    if (st.lb.loading) return '<p class="hint">正在读取本服积分…</p>';
    if (st.lb.error) return '<div class="lb-error">读取失败：' + esc(st.lb.error) + ' <button class="btn secondary small" data-lb-refresh>重试</button></div>';
    if (!st.lb.server) return '<p class="hint">正在读取本服积分…</p>';
    var rows = st.lb.server.rows || [];
    if (!rows.length) return '<p class="hint">本服还没有已结算的在线真人对局。开一局试试。</p>' + scoreRulesHtml();
    var myName = (st.lastScore && st.lastScore.name) || st.name;
    var list = rows.map(function (r, i) {
      var topGame = Object.keys(r.games || {}).sort(function (a, b) { return r.games[b].points - r.games[a].points; })[0];
      var rule = topGame ? ((U.SCORE_RULES || {})[topGame] || {}) : {};
      return '<div class="lb-rank-row' + (r.name === myName ? ' me' : '') + '"><span class="lb-rank">' + (i + 1) + '</span>' +
        '<span class="lb-name">' + esc(r.name) + (r.name === myName ? ' <span class="tag">你</span>' : '') + '</span>' +
        '<span class="lb-games">' + r.wins + ' 胜 / ' + r.plays + ' 局' + (topGame ? ' · ' + esc(rule.name || topGame) : '') + '</span>' +
        '<b class="lb-points">' + r.points + '</b></div>';
    }).join('');
    return '<div class="lb-stats single"><div><b>' + rows.length + '</b><span>上榜玩家</span></div><div><b>' + (st.lb.server.range === 'today' ? '今日' : st.lb.server.range === 'week' ? '本周' : '总榜') + '</b><span>统计范围</span></div></div>' + list + scoreRulesHtml();
  }
  function renderLeaderboardModal() {
    var modal = document.getElementById('lbModal'); if (!modal) return;
    var serverTab = canServerBoard() ? '<button class="lb-tab' + (st.lb.tab === 'server' ? ' active' : '') + '" data-lb-tab="server">本服榜</button>' : '';
    var body = st.lb.tab === 'server' ? serverLeaderboardHtml() : myLeaderboardHtml();
    modal.innerHTML = '<div class="modal lb-modal"><div class="lb-head"><h2>🏆 积分榜</h2><button class="lb-x" data-lb-close>×</button></div>' +
      '<div class="lb-tabs"><button class="lb-tab' + (st.lb.tab === 'mine' ? ' active' : '') + '" data-lb-tab="mine">我的积分</button>' + serverTab +
      '<button class="lb-refresh" data-lb-refresh>刷新</button></div>' +
      '<div class="lb-ranges">' +
      '<button class="lb-range' + (st.lb.range === 'today' ? ' active' : '') + '" data-lb-range="today">今日</button>' +
      '<button class="lb-range' + (st.lb.range === 'week' ? ' active' : '') + '" data-lb-range="week">本周</button>' +
      '<button class="lb-range' + (st.lb.range === 'all' ? ' active' : '') + '" data-lb-range="all">总榜</button></div>' +
      '<div class="lb-body">' + body + '</div></div>';
  }

  function trackDrawn() {
    var view = st.view; if (!view) return;
    var ids = view.hand.map(function (c) { return c.id; });
    if (view.turnState === 'drawn') { var newId = ids.find(function (id) { return st.prevHandIds.indexOf(id) === -1; }); st.drawnId = newId || null; }
    else st.drawnId = null;
    st.prevHandIds = ids;
  }

  // ---- chat + emoji ----
  function sendChat(text) {
    text = (text || '').trim(); if (!text) return;
    if (client) client.send({ t: 'chat', text: text, ...(st.chatTo != null ? { to: st.chatTo } : {}) });
    else if (host) { host.broadcastChat(st.name || (bridge && bridge.deviceName) || '我', text); }
    var input = document.getElementById('chatInput'); if (input) input.value = '';
    st.chatText = '';
  }
  function chatTargetHtml() {
    var me = st.you;
    var list = [];
    if (st.view && st.view.players) list = st.view.players.map(function (p) { return { seat: p.id, name: p.name }; });
    else if (st.seats) list = st.seats.map(function (s) { return { seat: s.seat, name: s.name }; });
    var opts = '<option value="">公共</option>' + list.filter(function (p) { return p.seat !== me; })
      .map(function (p) { return '<option value="' + p.seat + '"' + (st.chatTo === p.seat ? ' selected' : '') + '>私聊 ' + esc(p.name) + '</option>'; })
      .join('');
    return '<select id="chatTo" class="chat-to" title="发言对象">' + opts + '</select>';
  }
  function chatBarHtml() {
    var items = st.chat.slice(-8).map(function (m) {
      var tag = m.to != null ? '<span class="chat-private">私聊</span>' : '';
      return '<div class="chat-line">' + tag + '<b>' + esc(m.from) + '：</b>' + esc(m.text) + '</div>';
    }).join('');
    var log = items ? '<div class="chat-log">' + items + '</div>' : '';
    return log + '<div class="chat-bar">' +
      chatTargetHtml() +
      '<button class="emoji-btn" data-action="emoji">😀</button>' +
      '<input id="chatInput" class="chat-input" type="text" placeholder="说点什么…" maxlength="120" value="' + esc(st.chatText) + '" />' +
      '<button class="btn small" data-action="send">发送</button>' +
      '<div id="emojiBar" class="emoji-bar hidden"></div>' +
      '</div>';
  }
  function toggleEmoji() {
    var bar = document.getElementById('emojiBar'); if (!bar) return;
    if (!bar.classList.contains('hidden')) { bar.classList.add('hidden'); return; }
    bar.innerHTML = EMOJI.map(function (e) { return '<button class="emoji-pick" data-action="emoji:' + e + '">' + e + '</button>'; }).join('');
    bar.classList.remove('hidden');
  }
  function inputChat() {
    var input = document.getElementById('chatInput'); if (!input) return;
    if (chatBound) return;
    chatBound = true;
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(input.value); });
    input.addEventListener('input', function () { st.chatText = input.value; });
    input.addEventListener('focus', function () { st._chatFocused = true; });
    input.addEventListener('blur', function () { st._chatFocused = false; });
    var sel = document.getElementById('chatTo');
    if (sel) sel.addEventListener('change', function () { st.chatTo = sel.value === '' ? null : Number(sel.value); input.focus(); });
  }

  // ---- keep-alive: ping button + disconnect countdown + fix log ----
  var BUG_FIXES = [
    '已修复：全员开局进入对局', '已修复：断线清理+房主转移', '已修复：远程 AI 可加/删',
    '已修复：对局结束/进行中再加入不再转圈', '已修复：炸弹猫预测牌显示',
    '已修复：骗子酒馆开枪按钮', '已修复：聊天栏输入焦点保留', '已修复：空闲连接自动释放',
  ];
  function pingNote() {
    return '📡 连接正常 ✓ · ' + BUG_FIXES[st.pingNoteIdx++ % BUG_FIXES.length];
  }
  function fmtCd(ms) {
    if (ms <= 0) return '断线';
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60); s -= m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function updatePingUi() {
    var cd = document.getElementById('kaCd'), tx = document.getElementById('kaText'), dot = document.getElementById('kaDot');
    if (!cd) return;
    var remain = (st.idleTimeout || 180000) - (Date.now() - st.lastPingAt);
    cd.textContent = '断线倒计时 ' + fmtCd(Math.max(0, remain));
    if (tx) tx.textContent = st.connOk ? '已连接' : '连接中…';
    if (dot) dot.textContent = st.connOk ? '🟢' : '🟡';
  }
  setInterval(updatePingUi, 1000);


  function render() {
    // Preserve the chat input + scroll across re-renders so typing/reading is
    // never interrupted by an action or a state update.
    var _chatEl = document.getElementById('chatInput');
    var _wasFocused = !!(_chatEl && document.activeElement === _chatEl);
    // 右侧信息面板/棋盘侧栏是独立滚动的；整块 innerHTML 重绘会把 scrollTop 清零，
    // 玩家点一次动作就被拽回顶部。这里按容器类名存取一次。
    var _scrolls = {};
    ['gz-side', 'mono-side', 'civ-body'].forEach(function (cls) {
      var el = document.querySelector('.' + cls);
      if (el) _scrolls[cls] = el.scrollTop;
    });
    if (appEl) appEl.classList.toggle('wide', st.screen === 'civ' || (st.screen === 'game' && (st.game === 'guozhan' || st.game === 'monopoly' || st.game === 'werewolf')));
    if (st.screen === 'civ') appEl.innerHTML = CIVUI ? CIVUI.renderHtml() : '<div class="screen"><p class="hint">群星君主界面未加载。</p></div>';
    else if (st.screen === 'home') renderHome();
    else if (st.screen === 'lobby') renderLobby();
    else if (st.screen === 'guest-home') renderGuestHome();
    else if (st.screen === 'game' && st.view && st.view.phase === 'roundEnd') { if (st.game === 'guozhan') renderGzOver(); else if (st.game === 'monopoly') renderMonoOver(); else if (st.game === 'werewolf') renderWwOver(); else renderOver(); }
    else if (st.screen === 'game' && st.view && st.view.phase === 'aborted') renderAborted();
    else if (st.screen === 'game' && st.game === 'guozhan') renderGuozhan();
    else if (st.screen === 'game' && st.game === 'monopoly') renderMonopoly();
    else if (st.screen === 'game' && st.game === 'werewolf') renderWerewolf();
    else if (st.screen === 'game' && st.game === 'doudizhu') renderDdz();
    else if (st.screen === 'game' && st.game === 'exploding') renderEk();
    else if (st.screen === 'game' && st.game === 'liarsbar') renderLiarBar();
    else if (st.screen === 'game') renderGame();
    else if (st.screen === 'broke') renderBroken();
    else renderBoot();
    chatBound = false; inputChat();
    Object.keys(_scrolls).forEach(function (cls) {
      var el = document.querySelector('.' + cls);
      if (el) el.scrollTop = _scrolls[cls];
    });
    var inp = document.getElementById('chatInput');
    if (inp) {
      inp.value = st.chatText || '';
      if (_wasFocused || st._chatFocused) { inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {} }
      var log = document.querySelector('.chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  function renderBoot() { appEl.innerHTML = '<div class="screen"><p class="hint">正在启动…</p></div>'; }
  function renderAborted() { appEl.innerHTML = '<div class="screen"><div class="modal"><h2>游戏中断</h2><p class="hint">有玩家断开了连接，本局提前结束。</p></div></div>'; }
  function renderBroken() { appEl.innerHTML = '<div class="screen"><p class="hint">与房间断开连接。<br>请重新加入。</p></div>'; }
  function renderGuestHome() {
    var state = st.guestState || 'connecting';
    var inner = state === 'failed'
      ? '<h2>连接失败</h2><p class="hint">未能连接到房间服务器（' + esc(st.wsUrl) + '）。</p><div class="btn-row" style="justify-content:center;margin-top:18px"><button class="btn" data-action="back">返回</button></div>'
      : state === 'connected'
        ? '<h2>已连接</h2><p class="hint">已加入房间，等待主机开始…</p>'
        : '<h2>正在连接…</h2><div class="spinner"></div><p class="hint">正在连接 ' + esc(st.wsUrl) + '…</p>';
    appEl.innerHTML = '<div class="screen">' + inner + '</div>';
  }

  var GAME_HELP = {
    uno: '<b>目标：</b>先出完手牌获胜。<br><b>轮到你：</b>出一张与上一张同<b>颜色</b>或同<b>数字</b>的牌；特殊牌：⏭️跳过 / ⇄反转 / +2 / ★变色 / +4。<br><b>没牌可出：</b>摸一张，只能出刚摸的牌或跳过。<br><b>UNO：</b>剩1张时点「UNO!」，忘了会被罚2张。',
    doudizhu: '<b>3 人游戏。</b><br><b>叫地主：</b>轮流叫分（0-3），最高者为地主，获得 3 张底牌。<br><b>规则：</b>地主先出，下家要出<b>更大的同类型</b>组合（单张/对子/三带/顺子/炸弹/王炸）。<br><b>胜负：</b>地主先出完 = 地主赢；任一农民先出完 = 农民赢（两人合作）。',
    exploding: '<b>轮流摸牌。</b>摸到 💣 且没有 🧯 拆除 → 出局，最后存活者赢。<br><b>手牌功能：</b>⏭️跳过摸牌 / 🔮偷看牌库前3张 / 🔀洗牌 / 🎁向别人要牌 / ⚔️让下家多摸 / 🐱两张相同猫牌换一张。<br><b>🧯 拆除：</b>摸到💣时自动消耗，可选择把💣放回牌库位置。',
    liarsbar: '<b>3–5 人吹牛酒馆。</b>每人3张牌，每轮有一个目标点数。<br><b>轮到你：</b>出一张牌「声称」它是目标点数（可以说谎），或「揭穿」上家。<br><b>揭穿判定：</b>上家没说谎 → 你开枪；说谎 → 他开枪。<br><b>开枪 = 俄罗斯轮盘：</b>中弹出局，最后活着的人赢。',
    guozhan: '<b>国战 · 六角棋（2–12 人；超大陆剧本 12 人，其余势力由 AI 接管）。</b><br><b>同时下令：</b>点地块查看可用动作，加入指令后点「锁定并结算」。所有势力锁定后同一刻结算。<br><b>核心：</b>全国民心影响战力与溃败；地区动乱压低产出和守备（每点 -0.4% 金粮、-0.3% 守备，每回合自然 -3）；基建可降动乱、涨人口并积累民心。<br><b>平民：</b>地块人口 − 本区驻军；开荒图中平民占比越低，本区粮/金产出越低（最多 -35%），并影响税收与兵源增长。<br><b>起义：</b>动乱 100 会脱离原主，人口化为低战力民兵；原主杀光民兵才能重占，高民心相邻国可宣称归附（动乱 90、2 万守城兵、3 回合征兵敏感期、动乱 ≤50 恢复）。<br><b>外交：</b>频繁交战/毁约会累积潜在恨意；恨意 ≥70 或交战即禁运。<b>鬻奴令：</b>超大陆剧本中向相邻势力买奴，奴隶只能是带「贼配军」头衔的最低级兵，每支每回合 +4 本区动乱。<br><b>提示：</b>战力比 ≥ 1 才有优势；水师可沿水路连走 1–2 条航线；侦察可看清敌区 3 回合。',
    monopoly: '<b>大富翁（2–4 人）。</b><br>掷骰绕棋盘移动；经过起点得 200 金；落在无主地产可购买，踩到别人的地产付租金；落在自己的地产可建造提升租金。现金不足会破产。目标是成为最后未破产的人，或在回合上限时净资产最高。',
    werewolf: '<b>狼人杀（6–8 人）。</b><br>身份：狼人、预言家、女巫、平民。夜晚狼人猎杀、预言家查验、女巫用药；白天依次公开发言，然后投票放逐一人。狼人全部出局好人胜；狼人数量达到好人数狼人胜。',
    civmonarchs: '<b>群星君主（离线单机 · 12 国 48 州）。</b><br><b>目标：</b>率先进入「星际」时代且拥有至少 2 个外星殖民地；第 120 回合仍无人达成则按综合分判胜。<br><b>玩法：</b>每回合在「下令」页选一个君主、从合法动作里挑一条意图，切到「DM 修正」可提交主持人干预，然后点「结算一回合」。未下令的国家由确定性君主补位，十二国每回合都有举动。<br><b>确定性：</b>所有数值、战斗、时代与胜负由规则引擎裁决，模型零裁决权；同一种子 + 同一命令序列逐位一致。<br><b>席位：</b>默认 12 席全人机，任意席位可切成「人类」用触屏接管。<b>哪一席由谁控制对任何模型不可知</b>，编年史台词由史官统一润色，存档与提示词都不含身份。<br><b>离线：</b>飞行模式可完整玩一局，无需服务器。<b>自接 LLM：</b>在「LLM 设置」填自己的 OpenAI 兼容端点 / 模型 / Key，勾选席位后点「让模型推演本回合」才会调用；缺 Key、超时、断网、非法输出会自动降级，回合照常结算。Key 只存内存、不落盘。<br><b>存档：</b>自动存本机，也可导出 / 导入 JSON；与 PC 版存档双向兼容，但不含席位分配与 Key。',
  };
  function showHelp(key) {
    var body = GAME_HELP[key] || '暂无说明。';
    var modal = document.createElement('div'); modal.className = 'overlay'; modal.id = 'helpModal';
    modal.innerHTML = '<div class="modal"><h2>ⓘ 玩法说明</h2><div class="help-body">' + body + '</div>' +
      '<div class="btn-row" style="justify-content:center;margin-top:14px"><button class="btn" data-action="close-help">知道了</button></div></div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal || (e.target.closest && e.target.closest('[data-action="close-help"]'))) modal.remove();
    });
    document.body.appendChild(modal);
  }

  // ---- visual Mod manager (fetch /api/mods on the room server) ----
  function apiBase() {
    if (location && location.protocol && location.protocol.indexOf('http') === 0) return location.origin;
    var u = st.wsUrl || '';
    var m = u.match(/^(wss?):\/\/([^/]+)/i);
    if (m) return (m[1].toLowerCase() === 'wss' ? 'https' : 'http') + '://' + m[2];
    return '';
  }
  function loadModList() {
    if (!fetch) return;
    var base = apiBase(); if (!base) { st.mods = []; st.modFiles = []; return; }
    fetch(base + '/api/mods').then(function (r) { return r.json(); }).then(function (d) {
      st.mods = (d.installed || []).filter(function (g) { return !g.builtin; });
      st.modFiles = d.files || [];
      st.disabledFiles = d.disabledFiles || [];
      // If the room server was launched for a specific game (e.g. `... guozhan`),
      // make that the default choice so a plain "join" does not switch it to UNO.
      if (!st.game && d.current && (d.installed || []).some(function (g) { return g.key === d.current; }) && U.getGame) {
        st.game = d.current;
        st.gameName = U.getGame(d.current).name;
      }
      var m = document.getElementById('modModal');
      if (m) { var h = modListHtml(); m.querySelector('#modInstalledList').innerHTML = h.inst; m.querySelector('#modFileList').innerHTML = h.files; }
      else if (st.screen === 'home' || st.screen === 'lobby') render();
    }).catch(function () {});
  }
  function modListHtml() {
    var inst = st.mods.length
      ? st.mods.map(function (g) {
          return '<div class="mod-row"><div><b>' + esc(g.name) + '</b> <span class="muted">' + esc(g.key) + ' · ' + g.min + '-' + g.max + '人</span></div>' +
            '<button class="btn small danger" data-mod-del="' + esc(g.key) + '">卸载</button></div>';
        }).join('')
      : '<p class="hint tiny">暂无 Mod（内置游戏不需要在此管理）。</p>';
    var filesHtml = st.modFiles.map(function (f) {
      var k = f.replace(/\.mjs$/, '');
      var installed = st.mods.some(function (g) { return g.key === k; });
      return '<div class="mod-row"><div><span>' + esc(f) + '</span></div>' +
        (installed ? '<span class="tag">已装</span>' : '<button class="btn small" data-mod-install="' + esc(f) + '">安装</button>') + '</div>';
    }).join('');
    var disabledHtml = (st.disabledFiles || []).map(function (f) {
      var k = f.replace(/\.mjs$/, '');
      return '<div class="mod-row"><div><span>' + esc(f) + '</span> <span class="tag off">已停用</span></div>' +
        '<button class="btn small" data-mod-enable="' + esc(k) + '">重新启用</button></div>';
    }).join('');
    var files = (filesHtml + disabledHtml) || '<p class="hint tiny">mods/ 目录为空。</p>';
    return { inst: inst, files: files };
  }
  function showModManager() {
    if (!apiBase()) { toast('未连接房间服务器，无法管理 Mod'); return; }
    var h = modListHtml();
    loadModList();
    setTimeout(function () {
      if (document.getElementById('modModal')) return;
      var modal = document.createElement('div'); modal.className = 'overlay'; modal.id = 'modModal';
      modal.innerHTML = '<div class="modal mod-modal"><h2>🛠 Mod 管理</h2>' +
        '<div class="mod-sec"><div class="ai-label">已安装（可玩）</div><div id="modInstalledList">' + h.inst + '</div></div>' +
        '<div class="mod-sec"><div class="ai-label">服务器 mods/ 目录</div><div id="modFileList">' + h.files + '</div>' +
        '<p class="hint tiny">把玩家写的 .mjs 放进服务器 <code>mods/</code> 目录，点「安装」即扫描加载；加载后自动出现在房间游戏选择。</p></div>' +
        '<p class="hint tiny">内置：UNO / 斗地主 / 炸弹猫 / 骗子酒馆 · 对局进行中不能卸载。</p>' +
        '<div class="btn-row" style="justify-content:center;margin-top:6px"><button class="btn" data-action="mod-refresh">刷新</button> <button class="btn secondary" data-action="mod-close">关闭</button></div></div>';
      modal.addEventListener('click', function (e) {
        if (e.target === modal) { modal.remove(); return; }
        var del = e.target.closest('[data-mod-del]');
        if (del) { uninstallMod(del.getAttribute('data-mod-del'), modal); return; }
        if (e.target.closest('[data-mod-install]')) { installMod(modal); return; }
        var en = e.target.closest('[data-mod-enable]');
        if (en) { enableMod(en.getAttribute('data-mod-enable'), modal); return; }
        var act = e.target.closest('[data-action]');
        if (act) {
          var a = act.getAttribute('data-action');
          if (a === 'mod-close') { modal.remove(); }
          else if (a === 'mod-refresh') { modal.remove(); loadModList(); setTimeout(showModManager, 50); }
        }
      });
      document.body.appendChild(modal);
    }, 200);
  }
  function installMod(modal) {
    fetch(apiBase() + '/api/mods/reload', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
      toast(d.ok ? '已扫描安装新 Mod ✓' : '安装失败');
      if (modal && modal.remove) modal.remove();
      showModManager();
    }).catch(function () { toast('安装请求失败'); });
  }
  function uninstallMod(key, modal) {
    fetch(apiBase() + '/api/mods/' + encodeURIComponent(key), { method: 'DELETE' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (res) {
        if (res.s === 409) { toast(res.d.error || '对局进行中，不能卸载'); showModManager(); }
        else if (res.d.ok) { toast('已卸载 ' + key); if (modal && modal.remove) modal.remove(); loadModList(); if (st.screen === 'home') render(); }
        else toast('卸载失败');
      })
      .catch(function () { toast('卸载请求失败'); });
  }
  function enableMod(key, modal) {
    fetch(apiBase() + '/api/mods/enable/' + encodeURIComponent(key), { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (res) {
        if (res.d.ok) { toast('已重新启用 ' + key); if (modal && modal.remove) modal.remove(); loadModList(); if (st.screen === 'home' || st.screen === 'lobby') render(); }
        else toast('启用失败');
      })
      .catch(function () { toast('启用请求失败'); });
  }

  var BASE_GAMES = [
    { key: 'uno', name: 'UNO', desc: '经典 UNO，2–8 人' },
    { key: 'doudizhu', name: '斗地主', desc: '经典斗地主，固定 3 人' },
    { key: 'exploding', name: '炸弹猫', desc: '炸弹猫，2–5 人' },
    { key: 'liarsbar', name: '骗子酒馆', desc: '吹牛酒馆，3–5 人' },
    { key: 'guozhan', name: '国战 · 六角棋', desc: '确定性国战，2–12 人 + AI；含超大陆剧本' },
    { key: 'monopoly', name: '大富翁', desc: '买地收租，2–4 人 + AI' },
    { key: 'werewolf', name: '狼人杀', desc: '6–8 人 · 夜间行动 · 发言投票' },
    { key: 'civmonarchs', name: '群星君主', desc: '12 国文明推演 · 离线单机 · 可自接 LLM' },
  ];
  function renderHome() {
    var games = BASE_GAMES.concat((st.mods || []).map(function (m) {
      return { key: m.key, name: m.name || m.key, desc: (m.min != null ? (m.min + '–' + m.max + ' 人') : '') + ' · Mod' + (m.desc ? '：' + m.desc : '') };
    }));
    var rows = games.map(function (g) {
      return '<div class="game-card" data-action="select:' + g.key + '"><div class="gc-title">' + g.name +
        '<span class="gc-help" data-action="help:' + g.key + '" title="玩法说明">ⓘ</span>' +
        (g.key !== 'uno' && g.key !== 'doudizhu' && g.key !== 'exploding' && g.key !== 'liarsbar' && g.key !== 'guozhan' && g.key !== 'monopoly' && g.key !== 'werewolf' && g.key !== 'civmonarchs' ? '<span class="tag">Mod</span>' : '') +
        '</div><div class="gc-desc">' + g.desc + '</div></div>';
    }).join('');
    appEl.innerHTML =
      '<div class="screen"><h2 class="home-title">桌游合集</h2>' +
      (function () {
        var s = readLocalSave();
        if (!s) return '';
        var m = saveSummary(s);
        return '<div class="resume-card"><div class="resume-main"><b>继续上局：' + esc(m.name) + '</b>' +
          '<span class="resume-sub">' + esc(m.sub) + (m.turn ? ' · ' + esc(m.turn) : '') + (m.when ? ' · ' + esc(m.when) : '') + '</span></div>' +
          '<div class="btn-row" style="margin:0">' +
          '<button class="btn" data-action="resume-save">继续</button>' +
          '<button class="btn secondary" data-action="discard-save">放弃</button></div></div>';
      })() +
      '<div class="game-list">' + rows + '</div>' +
      '<p class="hint small">先选游戏，再「本地对战」或「加入房间」。点卡片右上 ⓘ 看玩法。</p>' +
      '<div class="home-actions">' +
      '<button class="btn" data-action="local">本地对战（主机+AI）</button> ' +
      '<button class="btn secondary" data-action="leaderboard">🏆 积分榜</button> ' +
      '<button class="btn secondary" data-action="mods">🛠 Mod 管理</button></div>' +
      '<div class="join-panel"><label>加入房间（局域网 / 远程服务器）</label>' +
      '<div class="btn-row" style="align-items:center">' +
      '<input id="roomUrl" class="chat-input" type="text" placeholder="粘贴加入链接，或 主机IP:端口" />' +
      '<button class="btn small" data-action="join">加入</button></div>' +
      '<div class="btn-row" style="justify-content:center;margin-top:8px"><button class="btn secondary" data-action="join-clip">📋 从剪贴板一键加入</button></div>' +
      '<p class="hint tiny">把收到的加入链接/地址（电脑运行 <code>run-lan.ps1</code> 后打印的链接）粘贴进来，或点「从剪贴板一键加入」，无需手打 ws://。</p></div>' +
      '</div>';
  }
  function pickGame(key) {
    // 群星君主是 APK 内离线单机模式，不在 UNOKU 的房间游戏注册表里。
    if (key === 'civmonarchs') {
      st.game = key; st.gameName = '群星君主';
      toast('已选：群星君主，点「本地对战」即可离线开局（无需服务器）');
      renderHome(); return;
    }
    st.game = key; st.gameName = U.getGame ? U.getGame(key).name : key;
    toast('已选：' + (st.gameName || key) + '，再点「本地对战」或填地址「加入」');
    renderHome();
  }

  function renderLobby() {
    var isHost = st.owner || st.role === 'host' || st.role === 'demo';
    // Remote-room-server mode only (Android "join remote room" => role 'room', or
    // web/browser room => wsUrl set). Bluetooth host/guest/Demo have NO wsUrl and
    // role 'host'/'guest'/'demo', so server-only UI must be gated on this flag.
    var isRemote = st.role === 'room' || !!st.wsUrl;
    var rows = st.seats.map(function (s) {
      return '<div class="player-row"><span>' + esc(s.name) +
        (s.seat === st.hostSeat ? ' <span class="host-tag">(房主)</span>' : '') +
        (s.seat === st.you ? ' <span class="host-tag">(你)</span>' : '') +
        (host && host.isBotSeat(s.seat) ? ' <span class="ai-tag">AI</span>' : '') +
        ((st.llmSeats || []).indexOf(s.seat) >= 0 ? ' <span class="llm-tag">LLM</span>' : '') +
        '</span></div>';
    }).join('');
    var aiPanel = (isHost && (!!host || !!client))
      ? '<div class="ai-panel"><div class="ai-label">AI 对手</div>' +
        '<div class="btn-row" style="justify-content:center;align-items:center">' +
        '<button class="btn secondary" data-action="ai-minus"' + (st.aiCount <= 0 ? ' disabled' : '') + '>−</button>' +
        '<span class="ai-count">' + st.aiCount + '</span>' +
        '<button class="btn secondary" data-action="ai-plus"' + (st.aiCount >= maxAiForGame() ? ' disabled' : '') + '>＋</button>' +
        '</div></div>'
      : '';
    var minP = (U.getGame ? (U.getGame(st.game).min || 2) : 2);
    var canStart = isHost && st.seats.length >= minP;
    var localLlmHost = !!host && !client && !!U.createLlmDriver && !!(U.getGame && U.getGame(st.game) && U.getGame(st.game).ai);
    var llmControls = function () {
      return '<div class="btn-row" style="justify-content:center;align-items:center">' +
        '<button class="btn secondary" data-action="llm-minus"' + (st.llmCount <= 0 ? ' disabled' : '') + '>−</button>' +
        '<span class="ai-count">' + (st.llmCount || 0) + '</span>' +
        '<button class="btn secondary" data-action="llm-plus"' + ((st.llmCount >= maxLlmForGame() || maxLlmForGame() <= 0) ? ' disabled' : '') + '>＋</button>' +
        (localLlmHost ? '<button class="btn secondary small" data-action="llm-settings">设置</button>' : '') +
        '</div>';
    };
    var llmPanel = '';
    if (localLlmHost) {
      llmPanel = '<div class="ai-panel llm-panel"><div class="ai-label">LLM 玩家位 ' + (st.llmAvailable && st.llmModel ? '· ' + esc(st.llmModel) : '· 本机模型') + '</div>' +
        (st.llmAvailable
          ? llmControls()
          : '<div class="btn-row" style="justify-content:center"><button class="btn" data-action="llm-settings">配置 LLM</button></div>') +
        '<p class="hint tiny">Key 只保留在本机内存，不发送给其他玩家或服务器；' + (st.llmAvailable ? '模型异常时自动退回规则 AI。' : '填写 API 地址、模型和 Key 后启用。') + '</p></div>';
    } else if (st.llmAvailable || st.llmCount > 0) {
      llmPanel = '<div class="ai-panel llm-panel"><div class="ai-label">LLM 玩家位 ' + (st.llmModel ? '· ' + esc(st.llmModel) : '') + '</div>' +
        (isHost ? llmControls() : '<div class="hint tiny">房主已启用 ' + (st.llmCount || 0) + ' 个 LLM 座位</div>') +
        '<p class="hint tiny">LLM 由房间服务器调用，浏览器/手机不保存 API key；模型异常时自动退回规则 AI。</p></div>';
    }
    var gzPanel = '';
    if (st.game === 'guozhan' && isHost) {
      // 旧「戰國七雄」为兼容旧存档保留最小模块集；大厅里展示完整版并沿用同一个名字
      var scenarios = (U.GZ_SCENARIOS || [])
        .filter(function (s) { return s.id !== 'warring-states'; })
        .map(function (s) { return s.id === 'warring-states-full' ? { id: s.id, name: '戰國七雄', description: s.description } : s; });
      var picks = scenarios.map(function (s) {
        var on = (st.gzScenario || 'random-front-v2') === s.id;
        return '<button class="btn small ' + (on ? '' : 'secondary') + '" data-action="gz-pick:' + esc(s.id) + '">' + esc(s.name) + '</button>';
      }).join(' ');
      var cur = scenarios.filter(function (s) { return s.id === (st.gzScenario || 'random-front-v2'); })[0];
      gzPanel = '<div class="gz-lobby-panel"><div class="ai-label">国战剧本</div>' +
        '<div class="btn-row" style="justify-content:center">' + picks + '</div>' +
        (cur ? '<p class="hint tiny">' + esc(cur.description) + '</p>' : '') +
        '<div class="gz-seed-row"><label>地图种子</label><input id="gzSeed" class="chat-input" type="text" maxlength="64" placeholder="留空则随机" value="' + esc(st.gzSeed || '') + '" /></div>' +
        '<label class="gz-unlimited-row"><input id="gzUnlimited" type="checkbox"' + (st.gzUnlimited !== false ? ' checked' : '') + ' /> 不限回合（∞）</label>' +
        '<div class="btn-row" style="justify-content:center;margin-top:6px"><button class="btn secondary small" data-action="gz-llm-country"' + (st.llmAvailable && st.llmCount < maxLlmForGame() ? '' : ' disabled') + '>⚔ LLM 独立国家</button></div>' +
        '<p class="hint tiny">LLM 会作为独立国家拿到一个未认领势力，按自己的迷雾视图下令；不是军师。</p>' +
        '<p class="hint tiny">默认打到征服或灭亡为止；关闭后按剧本回合上限结算。同一句柄 + 同一种子 = 同一张地图与同一次开局；种子会显示在对局顶部。</p></div>';
    }
    var share = (isRemote && st.wsUrl)
      ? '<div class="share-panel"><div class="ai-label">加入方式（把这个地址发给玩家）</div>' +
        '<div class="share-link" id="shareLink">' + esc(st.wsUrl) + '</div>' +
        '<div class="btn-row" style="justify-content:center"><button class="btn secondary small" data-action="copy-room">复制地址</button></div></div>'
      : '';
    var modBtn = isRemote
      ? '<div class="btn-row" style="justify-content:center;margin-top:8px"><button class="btn secondary small" data-action="mods">🛠 Mod 管理</button></div>'
      : '';
    var control = isHost
      ? '<div class="btn-row" style="justify-content:center;margin-top:16px"><button class="btn" data-action="start"' + (canStart ? '' : ' disabled') + '>开始游戏（' + st.seats.length + '人）</button></div>'
      : '<p class="hint">等待房主开始游戏…</p>';
    // Server keep-alive panel: only meaningful when connected to a remote room
    // server. Bluetooth host/guest have no room server, so hide it (chat bar stays).
    var keepAlive = isRemote
      ? '<div class="keep-alive"><span id="kaDot">🟡</span> <span id="kaText">连接中…</span> · <span id="kaCd">断线倒计时 --</span> ' +
        '<button class="btn secondary small" data-action="ping">📡 ping 服务器</button></div>'
      : '';
    appEl.innerHTML =
      '<div class="screen"><h2>' + esc(st.gameName || st.game || '游戏') + ' · 大厅</h2>' +
      '<div class="card-list">' + rows + '</div>' + gzPanel + aiPanel + llmPanel + share + modBtn + control + keepAlive +
      chatBarHtml() + '</div>';
    updatePingUi();
    bindGzLobby();
  }
  function bindGzLobby() {
    var un = document.getElementById('gzUnlimited');
    if (un) {
      un.checked = st.gzUnlimited !== false;
      un.addEventListener('change', function () { st.gzUnlimited = un.checked; });
    }
    var inp = document.getElementById('gzSeed');
    if (!inp) return;
    inp.value = st.gzSeed || '';
    inp.addEventListener('input', function () { st.gzSeed = inp.value; });
  }

  function renderOver() {
    var view = st.view;
    var winName = view.winner != null ? view.players[view.winner].name : '—';
    var rankRows = (view.counts || []).map(function (c, i) {
      return '<div class="rank-row"><span>' + (i + 1) + '. ' + esc(view.players[i].name) + '</span><span>' + (st.game === 'uno' ? c + ' 张' : '') + '</span></div>';
    }).join('');
    var isOwner = st.owner || st.role === 'host' || st.role === 'demo';
    var btn = isOwner ? '<button class="btn" data-action="again">再来一局</button>' : '<p class="hint">等待房主开始下一局…</p>';
    appEl.innerHTML =
      '<div class="screen"><div class="modal"><h2>本局结束</h2>' +
      '<div class="winner-name">🎉 ' + esc(winName) + ' 获胜！</div>' + rankRows + scoreSummaryHtml() +
      '<div class="btn-row" style="margin-top:18px;justify-content:center">' + btn + '</div></div></div>';
  }

  // ---- UNO board ----
  function renderGame() {
    var view = st.view; if (!view) return renderBoot();
    var me = st.you; var top = view.discardTop;
    var myTurn = view.phase === 'playing' && view.current === me;
    var dir = view.direction === 1 ? '↻' : '↺';
    var playersHtml = view.players.map(function (p, i) {
      var isMe = i === me; var isTurn = i === view.current && view.phase === 'playing';
      return '<div class="p ' + (isMe ? 'me' : '') + (isTurn ? ' turn' : '') + '"><div class="n">' + esc(p.name) + (isMe ? '（你）' : '') + '</div><div class="c">' + view.counts[i] + ' 张牌</div>' +
        (view.unoAnnounced[i] ? '<div class="uno-tag">UNO</div>' : '') + '</div>';
    }).join('');
    var banner = myTurn ? '<div class="turn-banner mine">轮到你！</div>' : '<div class="turn-banner">等待 ' + esc(view.players[view.current].name) + ' 出牌…</div>';
    var controls = myTurn
      ? (view.turnState === 'awaiting'
          ? '<div class="btn-row"><button class="btn" data-action="draw">摸牌</button><button class="btn secondary small" data-action="uno">UNO!</button></div>'
          : '<div class="btn-row"><button class="btn secondary" data-action="pass">不要（过）</button><button class="btn secondary small" data-action="uno">UNO!</button></div>')
      : '<div class="btn-row"><button class="btn secondary" disabled>等待</button></div>';
    var handHtml = view.hand.map(function (c) {
      var opts = {};
      if (c.id === st.drawnId) opts.highlight = true;
      if (view.turnState === 'drawn' && c.id !== st.drawnId) { opts.dim = true; if (myTurn) opts.blocked = true; }
      if (!myTurn) opts.dim = true;
      return cardHtml(c, opts);
    }).join('');
    appEl.innerHTML =
      '<div class="screen game">' + banner + '<div class="board"><div class="piles">' +
      '<div class="pile"><div class="card back">UNO</div><div class="lbl">牌库 ' + view.drawCount + '</div></div>' +
      '<div class="pile">' + (top ? cardHtml(top, {}) : '') + '<div class="lbl">当前：' + colorName(view.color) + ' ' + dir + '</div></div>' +
      '</div><div class="players">' + playersHtml + '</div>' + controls + '<div class="hand">' + handHtml + '</div></div></div>' + chatBarHtml();
  }

  // ---- 斗地主 board ----
  var SUIT_SYM = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
  function ddzCard(c, opts) {
    opts = opts || {};
    var style = opts.top != null ? 'style="top:' + opts.top + 'px;z-index:' + opts.z + '"' : '';
    var label = c.joker ? (c.rank === 'BJ' ? '大王' : '小王') : esc(c.rank);
    return '<div class="ddz-card' + (c.joker ? ' joker' : '') + (opts.sel ? ' sel' : '') + '" ' + style + ' data-id="' + esc(c.id) + '">' + label + (c.joker ? '' : '<span class="ddz-suit">' + SUIT_SYM[c.suit] + '</span>') + '</div>';
  }
  function renderDdz() {
    var view = st.view; if (!view) return renderBoot();
    var me = st.you; var landlord = view.landlord; var cur = view.current;
    var myTurn = (view.phase === 'playing' || view.phase === 'bidding') && cur === me;
    var playersHtml = view.players.map(function (p, i) {
      var isMe = i === me; var isLandlord = i === landlord; var isTurn = i === cur;
      var role = isLandlord ? '· 地主' : (landlord != null ? '· 农民' : '');
      return '<div class="p ' + (isMe ? 'me' : '') + (isTurn ? ' turn' : '') + '"><div class="n">' + esc(p.name) + (isMe ? '（你）' : '') + '</div><div class="c">' + p.handCount + ' 张' + role + '</div></div>';
    }).join('');
    var phase = view.phase;
    var banner = phase === 'bidding'
      ? (myTurn ? '<div class="turn-banner mine">请叫地主（0-3 分）</div>' : '<div class="turn-banner">叫地主中…</div>')
      : phase === 'playing'
        ? (myTurn ? '<div class="turn-banner mine">轮到你出牌！</div>' : '<div class="turn-banner">等待 ' + esc(view.players[cur].name) + ' 出牌…</div>')
        : '';
    var bidCtrl = phase === 'bidding' && myTurn
      ? '<div class="btn-row"><button class="btn" data-action="bid:0">不叫</button><button class="btn" data-action="bid:1">1分</button><button class="btn" data-action="bid:2">2分</button><button class="btn" data-action="bid:3">3分</button></div>'
      : '';
    var playCtrl = phase === 'playing' && myTurn
      ? '<div class="btn-row"><button class="btn" data-action="ddz-play">出牌</button><button class="btn secondary" data-action="ddz-pass">不出</button></div>'
      : '';
    var last = view.lastPlay;
    var DZ_COMBO = { single: '单张', pair: '对子', triple: '三张', trio1: '三带一', trio2: '三带二', straight: '顺子', doubleStraight: '连对', plane: '飞机', planeSingle: '飞机带单', planePair: '飞机带对', four2single: '四带二', four2pair: '四带二对', bomb: '炸弹', rocket: '王炸' };
    // Public card table: show the actual cards that were just played, in the middle.
    var lastHtml = last
      ? '<div class="ddz-table"><div class="ddz-table-label">' + esc(view.players[last.seat].name) + ' 出了「' + esc(DZ_COMBO[last.combo] || last.combo) + '」</div>' +
        '<div class="ddz-table-cards">' + (last.cards || []).map(function (c) { return ddzCard(c); }).join('') + '</div></div>'
      : '';
    // Sort hand big -> small (大王 2 A K ... 3), left to right; same-rank cards
    // are stacked DOWNWARD (front card on top, the rest peek their edges below)
    // with a generous vertical gap so phone taps are precise.
    var handed = (view.hand || []).slice().sort(function (a, b) { return (b.value || 0) - (a.value || 0); });
    var stacks = [], cur = null;
    handed.forEach(function (c) { if (!cur || cur[0].value !== c.value) { cur = [c]; stacks.push(cur); } else cur.push(c); });
    var gap = 22;
    var handHtml = stacks.map(function (g) {
      var inner = '';
      g.forEach(function (c, i) { inner += ddzCard(c, { top: i * gap, z: g.length - i, sel: st.selectedDdz.indexOf(c.id) >= 0 }); });
      return '<div class="ddz-stack" style="height:' + ((g.length - 1) * gap + 76) + 'px">' + inner + '</div>';
    }).join('');
    appEl.innerHTML =
      '<div class="screen game">' + banner + '<div class="board">' +
      '<div class="players">' + playersHtml + '</div>' + lastHtml + bidCtrl + playCtrl +
      '<div class="hand ddz-hand">' + handHtml + '</div></div></div>' + chatBarHtml();
  }

  // ---- 炸弹猫 board ----
  function ekLabel(c) {
    var kind = (typeof c === 'string') ? c : c.kind;
    switch (kind) {
      case 'explode': return '💣';
      case 'defuse': return '🧯';
      case 'skip': return '⏭️';
      case 'see': return '🔮';
      case 'shuffle': return '🔀';
      case 'favor': return '🎁';
      case 'attack': return '⚔️';
      case 'cat': return '🐱';
      default: return '🐱';
    }
  }
  function ekCatColor(cat) {
    if (cat === '红') return 'cat-red';
    if (cat === '黄') return 'cat-yellow';
    if (cat === '蓝') return 'cat-blue';
    return 'cat';
  }
  function renderEk() {
    var view = st.view; if (!view) return renderBoot();
    var me = st.you; var myTurn = view.phase === 'playing' && view.current === me;
    var giving = view.pendingFavor && view.pendingFavor.target === me; // I must hand a card
    var playersHtml = view.players.map(function (p, i) {
      var isMe = i === me, isTurn = i === view.current && view.phase === 'playing';
      return '<div class="p ' + (isMe ? 'me' : '') + (isTurn ? ' turn' : '') + (p.alive ? '' : ' dead') + '"><div class="n">' + esc(p.name) + (isMe ? '（你）' : '') + '</div><div class="c">' + p.handCount + ' 张' + (p.alive ? '' : ' · 💥') + '</div></div>';
    }).join('');
    var banner = myTurn
      ? (giving ? '<div class="turn-banner mine">' + esc(view.players[view.pendingFavor.from].name) + ' 向你索要一张牌（点一张牌给出）</div>'
          : '<div class="turn-banner mine">轮到你！先出可用牌或「摸牌」</div>')
      : '<div class="turn-banner">等待 ' + esc(view.players[view.current].name) + ' 摸牌…</div>';
    var see = (view.seeTop && view.seeTop.seat === me)
      ? '<div class="ddz-last">🔮 未来三张：' + view.seeTop.top.map(ekLabel).join(' / ') + '</div>' : '';
    var handHtml = view.hand.map(function (c) {
      var sel = (c.kind === 'cat' && st.ekSelected.indexOf(c.id) >= 0) || (c.kind === 'favor' && st.ekFavorCard === c.id) || (c.kind === 'attack' && st.ekAttackCard === c.id) || (c.kind === 'shuffle' && st.ekShuffleSel.indexOf(c.id) >= 0);
      var cls = 'ek-card ' + c.kind + (c.kind === 'cat' ? ' ' + ekCatColor(c.cat) : '') + (sel ? ' sel' : '');
      return '<div class="' + cls + '" data-id="' + esc(c.id) + '">' + ekLabel(c) + '</div>';
    }).join('');
    var defusing = myTurn && view.pendingDefuse && view.pendingDefuse.seat === me;
    var defusePanel = defusing
      ? '<div class="ek-defuse-panel">你摸到💣！用🧯拆除，选择放回第 <input id="ekPos" type="number" min="1" max="' + view.drawCount + '" value="1" class="ek-pos" /> 张 <button class="btn small" data-action="ek-defuse">放回</button></div>'
      : '';
    var banner2 = defusing ? '<div class="turn-banner mine">请选择把炸弹放回牌库第几张</div>' : banner;
    var catSel = st.ekSelected || [];
    var extras = '';
    if (catSel.length >= 2 && catSel.length <= 3 && myTurn && !defusing) extras += '<button class="btn small" data-action="ek-cats">索要(🐱×' + catSel.length + ')</button> ';
    if (st.ekFavorCard && myTurn && !defusing) extras += '<button class="btn small" data-action="ek-favor">索要(🎁)</button> ';
    if (st.ekAttackCard && myTurn && !defusing) extras += '<button class="btn small" data-action="ek-attack">攻击(⚔️)</button> ';
    var shuf = st.ekShuffleSel || [];
    if (shuf.length === 1 && myTurn && !defusing) extras += '<button class="btn small" data-action="ek-shuffle">洗混(🔀)</button> ';
    if (shuf.length === 2 && myTurn && !defusing) extras += '<button class="btn small" data-action="ek-shuffle2">重置洗混(🔀×2)</button> ';
    var ctrl = myTurn && !defusing
      ? '<div class="btn-row">' + extras + '<button class="btn" data-action="ek-draw">摸牌</button></div>'
      : '';
    appEl.innerHTML =
      '<div class="screen game">' + banner2 + see + '<div class="board"><div class="players">' + playersHtml + '</div>' + ctrl + defusePanel +
      '<div class="ek-label">牌库 ' + view.drawCount + ' 张 · 摸到💣且无🧯即出局</div><div class="hand ddz-hand">' + handHtml + '</div></div></div>' + chatBarHtml();
  }

  // ---- 骗子酒馆 board ----
  function renderLiarBar() {
    var view = st.view; if (!view) return renderBoot();
    var me = st.you; st.liarSelected = st.liarSelected || [];
    var myTurn = view.phase === 'playing' && view.current === me;
    // Yellow-card volley (全场逐个开枪) takes priority over the single-shot roulette.
    var volley = view.pendingShots && view.pendingShots.remaining > 0;
    var volleyMe = volley && view.pendingShots.seat === me;
    var volleyRemaining = volley ? view.pendingShots.remaining : 0;
    var firing = !volley && view.pendingRoulette && view.pendingRoulette.seat === me;
    var firingCount = firing ? (view.pendingRoulette.count || 1) : 0;
    var designating = view.phase === 'playing' && view.designate === me;
    var otherDesignating = view.phase === 'playing' && view.designate != null && view.designate !== me;
    var playersHtml = view.players.map(function (p, i) {
      var isMe = i === me, isTurn = i === view.current && view.phase === 'playing';
      return '<div class="p ' + (isMe ? 'me' : '') + (isTurn ? ' turn' : '') + (p.alive ? '' : ' dead') + '"><div class="n">' + esc(p.name) + (isMe ? '（你）' : '') + '</div><div class="c">🔫' + (p.shots || 0) + '/6 · ' + p.handCount + ' 张</div></div>';
    }).join('');
    // Banner priority: my volley fire > volley in progress > my fire > my designate > my turn > other designate > waiting.
    var banner;
    if (volleyMe) banner = '<div class="turn-banner mine">🔫 有玩家出了黄牌，全场逐个开枪！轮到你开枪' + (volleyRemaining > 1 ? '（剩余 ' + volleyRemaining + ' 人）' : '') + '…</div>';
    else if (volley) banner = '<div class="turn-banner mine">🔫 全场开枪！' + esc(view.players[view.pendingShots.seat].name) + ' 正在开枪（剩余 ' + volleyRemaining + ' 人）…</div>';
    else if (firing && firingCount > 1) banner = '<div class="turn-banner mine">你输了这场挑战！需要连开 ' + firingCount + ' 枪…</div>';
    else if (firing) banner = '<div class="turn-banner mine">你输了这场挑战！轮到你扣动扳机…</div>';
    else if (designating) banner = '<div class="turn-banner mine">你出完了牌！指定一名玩家开枪</div>';
    else if (otherDesignating) banner = '<div class="turn-banner">' + esc(view.players[view.designate].name) + ' 出完了牌，正在指定开枪…</div>';
    else if (myTurn) banner = '<div class="turn-banner mine">轮到你：选牌「声称」，或「揭穿」</div>';
    else banner = '<div class="turn-banner">等待 ' + esc(view.players[view.current].name) + ' 出牌…</div>';
    // Show how many cards the last claim covered.
    var claimInfo;
    if (view.lastClaim) {
      var c = view.lastClaim.count || 1;
      claimInfo = '<div class="ddz-last">' + esc(view.players[view.lastClaim.seat].name) + ' 声称出了 ' + c + ' 张「' + esc(view.lastClaim.claimedRank) + '」</div>';
    } else {
      claimInfo = '<div class="ddz-last">本轮目标：<b>' + esc(view.targetRank) + '</b>（还没人出牌）</div>';
    }
    // Yellow-card volley log: a player was just exposed holding a yellow card.
    var volleyInfo = '';
    if (view.last && view.last.kind === 'yellow') {
      volleyInfo = '<div class="ddz-last">🟨 ' + esc(view.players[view.last.loser].name) + ' 的黄牌被揭穿了！全场其他玩家逐个开枪</div>';
    } else if (view.last && view.last.kind === 'volley') {
      volleyInfo = '<div class="ddz-last">🔫 ' + esc(view.players[view.last.seat].name) + ' 开了一枪' + (view.last.died ? '，💥 出局了！' : '，安然无恙') + '</div>';
    }
    var ctrl;
    if (volleyMe) {
      ctrl = '<div class="btn-row" style="justify-content:center;margin-top:14px"><button class="btn" data-action="lb-fire">🔫 开枪（全场逐个开）</button></div>';
    } else if (firing) {
      ctrl = '<div class="btn-row" style="justify-content:center;margin-top:14px"><button class="btn" data-action="lb-fire">🔫 开枪' + (firingCount > 1 ? '（共 ' + firingCount + ' 枪）' : '') + '</button></div>';
    } else if (designating) {
      ctrl = '<div class="btn-row" style="justify-content:center;margin-top:14px"><button class="btn" data-action="lb-designate">🎯 指定开枪目标</button></div>';
    } else if (myTurn) {
      var playBtn = '<button class="btn" data-action="lb-play"' + (st.liarSelected.length ? '' : ' disabled') + '>出牌' + (st.liarSelected.length ? '（' + st.liarSelected.length + '）' : '') + '</button>';
      var callBtn = view.lastClaim ? '<button class="btn secondary" data-action="lb-call">揭穿他</button>' : '';
      ctrl = '<div class="btn-row">' + playBtn + callBtn + '</div>';
    } else {
      ctrl = '';
    }
    var handHtml = view.hand.map(function (c) {
      var sel = st.liarSelected.indexOf(c.id) >= 0;
      var label = c.wild ? '🃏' : (c.yellow ? '🟨' : esc(c.rank));
      var cls = c.wild ? ' wild' : (c.yellow ? ' yellow' : '');
      var tag = c.wild ? '<span class="lb-wild-tag">JOKER</span>' : (c.yellow ? '<span class="lb-yellow-tag">黄牌</span>' : '');
      return '<div class="lb-card' + cls + (sel ? ' sel' : '') + '" data-id="' + esc(c.id) + '">' + label + tag + '</div>';
    }).join('');
    appEl.innerHTML =
      '<div class="screen game">' + banner + '<div class="board"><div class="target">本轮目标：<b>' + esc(view.targetRank) + '</b> · 万能牌可当任意点数 · 黄牌被揭穿会令全场其他玩家各开一枪</div>' + claimInfo + volleyInfo +
      '<div class="players">' + playersHtml + '</div>' + ctrl + '<div class="hand ddz-hand">' + handHtml + '</div></div></div>' + chatBarHtml();
  }

  // ---- 国战 · 六角棋 ----
  var GZ_TERRAIN = { plains: '原', hills: '丘', mountain: '山', forest: '林', river: '泽', urban: '城' };
  var GZ_AI_STYLE = { rush: '疾攻', turtle: '守成', random: '无常' };
  var GZ_TRADE = { free: '通商', restricted: '受限', embargo: '禁运' };
  var GZ_KIND = {
    attack: '进攻', move_units: '调动', recruit: '征兵', develop: '开发',
    build_infrastructure: '基建', fortify: '筑垒', split_unit: '分兵',
    merge_units: '合兵', disband: '裁军', set_tax: '税率', set_law: '法令',
    diplomacy: '外交', send_spy: '谍报', trade_slaves: '鬻奴', claim_rebellion: '宣称', settle_region: '开荒',
  };
  var GZ_GROUP = {
    attack: '出击', move_units: '调动', recruit: '内政', develop: '内政',
    build_infrastructure: '内政', fortify: '内政', split_unit: '编成',
    merge_units: '编成', disband: '编成', set_tax: '国策', set_law: '国策',
    diplomacy: '国策', send_spy: '国策', trade_slaves: '国策', claim_rebellion: '国策', settle_region: '开垦',
  };
  var GZ_TIER = { none: '无', token: '小队', garrison: '守备', field_army: '野战军', grand_army: '大军' };

  function gzHex(cx, cy, r) {
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = Math.PI / 180 * (60 * i - 90);
      pts.push((cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2));
    }
    return pts.join(' ');
  }
  function gzRgb(hex) {
    var n = parseInt(String(hex || '').slice(1), 16);
    if (!isFinite(n)) return { r: 156, g: 141, b: 110 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function gzHsl(hex) {
    var c = gzRgb(hex), r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    var d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min), h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s: s, l: l };
  }
  function gzHslHex(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return '#' + rgb.map(function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, '0'); }).join('');
  }
  // 与 guozhan web/faction-colors.js 同一显示策略：深色/低饱和势力在深色地图上提亮。
  function gzColor(raw, fid) {
    var fallback = ['#df6b6b', '#5a9bef', '#e0c05a', '#5ecf8b', '#b48bea', '#e89a55', '#55c7c0', '#d7dce3'];
    var h = 2166136261;
    for (var i = 0; i < String(fid).length; i++) { h ^= String(fid).charCodeAt(i); h = Math.imul(h, 16777619); }
    if (!/^#[0-9a-fA-F]{6}$/.test(String(raw || ''))) return fallback[(h >>> 0) % fallback.length];
    if (fid === 'qin') return '#d7dee8';
    var hsl = gzHsl(raw);
    if (hsl.s < 0.18 || hsl.l < 0.24) return fallback[(h >>> 0) % fallback.length];
    return gzHslHex(hsl.h, Math.min(0.9, Math.max(0.6, hsl.s)), Math.min(0.68, Math.max(0.54, hsl.l)));
  }
  function gzCompact(n) {
    n = Number(n) || 0;
    if (n >= 10000) { var w = n / 10000; return (w >= 10 ? w.toFixed(0) : w.toFixed(1).replace(/\.0$/, '')) + '万'; }
    return String(Math.round(n));
  }
  function gzEstimate(a) {
    var e = a.estimate || {};
    if (a.kind === 'attack') return '战力比 ' + (e.powerRatio != null ? Number(e.powerRatio).toFixed(2) : '?') + ' · 守军 ' + gzCompact(e.defenderTroops) + (e.moveCost != null ? ' · 行军 ' + e.moveCost : '') + ' · ' + (e.verdict || '');
    if (a.kind === 'move_units') return '移动力 ' + (e.movementCost != null ? e.movementCost + '/' + e.movement : '?');
    if (a.kind === 'recruit') return '金 ' + (e.goldCost || 0) + ' · 粮 ' + (e.foodCost || 0) + ' · 兵 ' + gzCompact(e.count);
    if (a.kind === 'develop') return '金 ' + (e.goldCost || 0);
    if (a.kind === 'build_infrastructure') return '金 ' + (e.goldCost || 0) + ' · 动乱 -' + (e.unrestPerTurn || 0) + '/回合 · 人口 ' + (e.populationGrowth || '');
    if (a.kind === 'fortify') return '金 ' + (e.goldCost || 0) + ' · 守备加成';
    if (a.kind === 'split_unit') return '分出 ' + gzCompact(e.splitCount) + '，余 ' + gzCompact(e.remaining);
    if (a.kind === 'merge_units') return '合兵 ' + gzCompact(e.total);
    if (a.kind === 'disband') return '遣散 ' + gzCompact(e.troopsReleased) + ' · 返金 ' + (e.goldRefund || 0);
    if (a.kind === 'send_spy') return '金 ' + (e.spyCost || 0) + ' · 情报 ' + (e.intelTurns || 3) + ' 回合';
    if (a.kind === 'set_tax') return '税收 ' + (e.taxRevenue || 0) + '/回合 · 较当前 ' + (e.goldDeltaPerTurn >= 0 ? '+' : '') + (e.goldDeltaPerTurn || 0);
    if (a.kind === 'set_law') return '金 ' + (e.goldCost || 0) + (e.lawPopulation ? ' · 人口 ' + gzCompact(e.lawPopulation) : '');
    if (a.kind === 'trade_slaves') return '奴 ' + gzCompact(e.slaveCount) + ' · 金 ' + (e.goldCost || 0) + ' · 恨意 ' + (e.grudge != null ? e.grudge : '?') + ' · 民心 -' + (e.buyerMoraleCost || 0);
    if (a.kind === 'claim_rebellion') return '起义民兵 ' + gzCompact(e.rebelTroops) + ' · 归附动乱 ' + (e.claimedUnrest || 0) + ' · 守城 ' + gzCompact(e.garrisonCap);
    if (a.kind === 'settle_region') return '原住民 ' + gzCompact(e.natives) + ' · 金 ' + (e.goldCost || 0) + ' · 粮 ' + (e.foodCost || 0) + ' · 获 ' + gzCompact(e.lootGold);
    if (a.kind === 'diplomacy') return '当前关系：' + (e.currentRelation || '中立');
    return '';
  }
  function gzRegionName(v, id) {
    var r = (v.regions || []).filter(function (x) { return x.id === id; })[0];
    return r ? r.name : id;
  }
  function gzFactionName(v, id) {
    var f = (v.factions || []).filter(function (x) { return x.id === id; })[0];
    return f ? f.name : (id || '中立');
  }
  function gzRelationText(rel) {
    return { self: '本国', war: '交战', alliance: '同盟', truce: '停战', peace: '和平', neutral: '中立' }[rel] || rel;
  }
  function gzReportEvents(v) {
    var ev = (v.report && v.report.events) || [];
    var out = [];
    // 复盘必须置顶：战斗事件很多时不能被 8 条上限挤掉
    var recapEv = ev.filter(function (x) { return x && x.type === 'turn_recap'; })[0];
    if (recapEv) {
      var recapParts = [];
      (recapEv.factions || []).forEach(function (f) {
        if (!f.regionsDelta && !f.goldDelta && !f.foodDelta && !f.moraleDelta && f.troopsAfter === f.troopsBefore) return;
        recapParts.push(f.name + ' 地' + (f.regionsDelta >= 0 ? '+' : '') + f.regionsDelta + '/金' + (f.goldDelta >= 0 ? '+' : '') + f.goldDelta + '/兵' + (f.troopsAfter - f.troopsBefore >= 0 ? '+' : '') + (f.troopsAfter - f.troopsBefore));
      });
      out.push({ tone: 'dip', text: 'T' + recapEv.turn + ' 复盘：' + (recapParts.slice(0, 6).join('；') || '无显著变化') });
    }
    for (var i = 0; i < ev.length && out.length < 8; i++) {
      var e = ev[i];
      if (!e || !e.type || e.type === 'turn_recap') continue;
      if (e.type === 'region_captured') {
        out.push({ tone: 'cap', text: gzRegionName(v, e.regionId) + ' 易手：' + gzFactionName(v, e.from) + ' → ' + gzFactionName(v, e.to) });
      } else if (e.type === 'combat_resolved' && e.evidence) {
        var evd = e.evidence;
        var a = evd.attacker || {}, d = evd.defender || {};
        var outcome = { attacker_win: '攻方胜', defender_win: '守方胜', stalemate: '僵持', attacker_rout: '攻方溃退', defender_rout: '守方溃退' }[evd.outcome] || '交战';
        var target = d.regionId || e.regionId;
        var from = evd.originRegion || (a.unitId ? '' : '');
        var lossA = Math.max(0, (a.troopsBefore || 0) - (a.troopsAfter || 0));
        var lossD = Math.max(0, (d.troopsBefore || 0) - (d.troopsAfter || 0));
        out.push({
          tone: evd.captured ? 'cap' : 'battle',
          text: (from ? gzRegionName(v, from) + ' → ' : '') + gzRegionName(v, target) +
            '：' + gzFactionName(v, a.factionId) + ' vs ' + gzFactionName(v, d.factionId) +
            ' · ' + outcome + ' · 战力比 ' + Number(evd.powerRatio || 0).toFixed(2) +
            ' · 损失 ' + gzCompact(lossA) + '/' + gzCompact(lossD),
        });
      } else if (e.type === 'diplomacy_changed') {
        out.push({ tone: 'dip', text: gzFactionName(v, e.a) + ' 与 ' + gzFactionName(v, e.b) + ' 关系变为 ' + (e.kind || '') });
      } else if (e.type === 'slaves_traded') {
        out.push({ tone: 'dip', text: '鬻奴：' + gzFactionName(v, e.seller) + ' → ' + gzFactionName(v, e.buyer) + ' · ' + gzCompact(e.count) + ' 人 · ' + (e.gold || 0) + ' 金' });
      } else if (e.type === 'rebellion_started') {
        out.push({ tone: 'battle', text: '起义：' + gzRegionName(v, e.regionId) + ' 反抗 ' + gzFactionName(v, e.original) + ' · 民兵 ' + gzCompact(e.rebelTroops) });
      } else if (e.type === 'rebellion_claimed') {
        out.push({ tone: 'dip', text: '宣称：' + gzFactionName(v, e.claimant) + ' 归附 ' + gzRegionName(v, e.regionId) + ' · 守城 ' + gzCompact(e.garrison) });
      } else if (e.type === 'rebellion_ended') {
        out.push({ tone: 'dip', text: '起义结束：' + gzRegionName(v, e.regionId) + '（' + (e.reason === 'reoccupied' ? '被重占' : '动乱回落') + '）' });
      } else if (e.type === 'frontier_settled') {
        out.push({ tone: 'cap', text: '开荒：' + gzFactionName(v, e.factionId) + ' 占领 ' + gzRegionName(v, e.regionId) + ' · 基建 Lv' + e.infrastructure + ' · 原住民 ' + gzCompact(e.natives) });
      } else if (e.type === 'spy_reported') {
        out.push({ tone: 'dip', text: gzFactionName(v, e.factionId) + ' 侦察了 ' + gzRegionName(v, e.regionId) });
      }
    }
    return out;
  }
  function gzRecentRegions(v) {
    var set = {};
    var ev = (v.report && v.report.events) || [];
    for (var i = 0; i < ev.length; i++) {
      if (ev[i] && ev[i].type === 'combat_resolved' && ev[i].evidence) {
        var d = ev[i].evidence.defender || {};
        if (d.regionId) set[d.regionId] = 'target';
        var o = ev[i].evidence.originRegion;
        if (o) set[o] = set[o] || 'origin';
      }
    }
    return set;
  }
  function gzMapHtml(v) {
    var map = v.map || {};
    var regions = map.regions || [];
    var size = Number(map.hexSize) || 58;
    var canvas = map.canvas || { width: 1000, height: 640 };
    var snap = {};
    (v.regions || []).forEach(function (r) { snap[r.id] = r; });
    var colors = map.factionColors || {};
    var recent = gzRecentRegions(v);
    var highlight = {};
    if (st.gzSelected) {
      (v.actions || []).forEach(function (a) {
        if (a.sourceRegion === st.gzSelected && a.targetRegion) highlight[a.targetRegion] = true;
        if (a.targetRegion === st.gzSelected && a.sourceRegion) highlight[a.sourceRegion] = true;
      });
    }
    // 按实际格子范围自适应 viewBox：固定画布会让战国图缩在中间一块、四周大片空白
    var bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    regions.forEach(function (r) {
      if (typeof r.x !== 'number' || typeof r.y !== 'number') return;
      bx1 = Math.min(bx1, r.x); bx2 = Math.max(bx2, r.x);
      by1 = Math.min(by1, r.y); by2 = Math.max(by2, r.y);
    });
    if (!isFinite(bx1) || !isFinite(by1)) { bx1 = 0; by1 = 0; bx2 = canvas.width; by2 = canvas.height; }
    var margin = size * 1.1 + 6;
    var vbX = Math.round(bx1 - margin), vbY = Math.round(by1 - margin);
    var vbW = Math.round((bx2 - bx1) + margin * 2), vbH = Math.round((by2 - by1) + margin * 2);
    var svg = '<svg class="gz-map" style="width:' + Math.round((st.gzZoom || 1) * 100) + '%" viewBox="' + vbX + ' ' + vbY + ' ' + vbW + ' ' + vbH + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="国战六角地图">';
    svg += '<defs><filter id="gz-glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
    // 邻接道路：区域图不是蜂窝图，没有道路时战国地图看起来是一堆漂浮的六边形
    var byId = {};
    regions.forEach(function (r) { byId[r.id] = r; });
    var roadSeen = {};
    (v.regions || []).forEach(function (r) {
      (r.adjacency || []).forEach(function (other) {
        var key = String(r.id) < String(other) ? r.id + '|' + other : other + '|' + r.id;
        if (roadSeen[key]) return;
        roadSeen[key] = 1;
        var a = byId[r.id], b = byId[other];
        if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return;
        svg += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" class="gz-road" />';
      });
    });
    // 水路：先画在格子下面
    (map.waterRoutes || []).forEach(function (r) {
      var a = byId[r.a], b = byId[r.b];
      if (!a || !b) return;
      svg += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" class="gz-route" />';
    });
    (map.bridges || []).forEach(function (b) {
      var a = byId[b.a], c = byId[b.b];
      if (!a || !c) return;
      svg += '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + c.x + '" y2="' + c.y + '" class="gz-bridge" />';
    });
    (map.waterCells || []).forEach(function (c) {
      svg += '<polygon points="' + gzHex(c.x, c.y, size) + '" class="gz-water" />';
    });
    regions.forEach(function (cell) {
      var s = snap[cell.id];
      if (!s) return;
      var owner = s.owner;
      var color = gzColor(colors[owner] || '#9c8d6e', owner || 'neutral');
      var vis = s.visibility || 'name_only';
      var cls = 'gz-hex vis-' + vis + (st.gzSelected === cell.id ? ' selected' : '') +
        (highlight[cell.id] ? ' targetable' : '') + (recent[cell.id] ? ' recent' : '');
      var fillOpacity = vis === 'full' ? 0.92 : vis === 'partial' ? 0.58 : vis === 'name_only' ? 0.34 : 0.16;
      var cap = map.capitals && owner && map.capitals[owner] === cell.id;
      var stacks = s.stacks || [];
      var troops = 0;
      stacks.forEach(function (x) { troops += Number(x.troops) || 0; });
      var line2 = GZ_TERRAIN[s.terrain] || '';
      if ((map.ports || []).indexOf(cell.id) >= 0) line2 += ' 港';
      if (vis === 'full' || vis === 'partial') {
        if (s.developmentLabel) line2 += ' ' + s.developmentLabel;
        if (s.infrastructure) line2 += ' 基' + s.infrastructure;
        if (s.unrest != null) line2 += ' 乱' + s.unrest;
      }
      var line3 = '';
      if (stacks.length) line3 = '兵' + gzCompact(troops);
      else if (vis === 'full') line3 = '无驻军';
      else if (vis === 'name_only') line3 = '情报不足';
      var tip = s.name + ' · ' + gzFactionName(v, owner) + ' · ' + vis;
      if (stacks.length) tip += ' · ' + stacks.map(function (x) { return x.typeName + (x.title === 'bandit_conscript' ? '(贼配军)' : x.title === 'rebel_militia' ? '(起义民兵)' : x.title === 'rebel_garrison' ? '(守城民兵)' : '') + ' ' + x.troops; }).join('，');
      svg += '<g class="' + cls + '" data-gz-region="' + esc(cell.id) + '">' +
        '<title>' + esc(tip) + '</title>' +
        '<polygon points="' + gzHex(cell.x, cell.y, size - 1.5) + '" fill="' + color + '" fill-opacity="' + fillOpacity + '" />' +
        (s.terrain === 'river' ? '<polygon points="' + gzHex(cell.x, cell.y, size - 5) + '" class="gz-river" pointer-events="none" />' : '') +
        '<polygon points="' + gzHex(cell.x, cell.y, size - 1.5) + '" class="gz-hex-line" />' +
        (cap ? '<circle cx="' + (cell.x - size * 0.48) + '" cy="' + (cell.y - size * 0.46) + '" r="' + Math.max(3, size * 0.09) + '" class="gz-capital" />' : '') +
        '<text x="' + cell.x + '" y="' + (cell.y - size * 0.06) + '" class="gz-name">' + esc(s.name) + '</text>' +
        '<text x="' + cell.x + '" y="' + (cell.y + size * 0.24) + '" class="gz-meta">' + esc(line2) + '</text>' +
        (line3 ? '<text x="' + cell.x + '" y="' + (cell.y + size * 0.52) + '" class="gz-troops">' + esc(line3) + '</text>' : '') +
        '</g>';
    });
    svg += '</svg>';
    return svg;
  }
  function gzActionGroupHtml(v, list, title) {
    if (!list.length) return '';
    var rows = list.map(function (a) {
      var disabled = v.locked || (v.actions || []).length === 0;
      var desc = a.description || gzEstimate(a);
      return '<button class="gz-act kind-' + esc(a.kind) + '" data-gz-act="' + esc(a.id) + '"' + (disabled ? ' disabled' : '') + '>' +
        '<span class="gz-act-kind">' + esc(GZ_KIND[a.kind] || a.kind) + '</span>' +
        '<span class="gz-act-label">' + esc(a.label) + '</span>' +
        (desc ? '<span class="gz-act-desc">' + esc(desc) + '</span>' : '') +
        '</button>';
    }).join('');
    return '<div class="gz-action-group"><div class="gz-subtitle">' + esc(title) + '</div>' + rows + '</div>';
  }
  function gzPanelHtml(v) {
    var selfId = v.factionId;
    var selfF = (v.factions || []).filter(function (f) { return f.id === selfId; })[0] || {};
    var exact = selfF.exact || {};
    var morale = selfF.morale != null ? selfF.morale : 70;
    var rules = (v.map && v.map.rules) || {};
    var coeff = (rules.morale && rules.morale.coefficient) || 170;
    var lowThreshold = (rules.lowMorale && rules.lowMorale.threshold) || 60;
    var moraleFactor = (0.5 + morale / coeff).toFixed(2);
    var sel = st.gzSelected;
    var selRegion = (v.regions || []).filter(function (r) { return r.id === sel; })[0] || null;
    var waiting = (v.waitingSeats || []).map(function (seat) {
      var sf = (v.seatFactions || []).filter(function (x) { return x.seat === seat; })[0];
      return sf ? sf.name : ('座位' + seat);
    });
    var head = '<div class="gz-card gz-self">' +
      '<div class="gz-self-title"><span class="gz-dot" style="background:' + gzColor((v.seatFactions || []).filter(function (x) { return x.factionId === selfId; })[0] && (v.seatFactions || []).filter(function (x) { return x.factionId === selfId; })[0].color, selfId) + '"></span>' +
      '<b>' + esc(selfF.name || selfId) + '</b><span class="tag">你</span></div>' +
      '<div class="gz-stat-row"><span>金 <b>' + gzCompact(exact.gold != null ? exact.gold : 0) + '</b></span><span>粮 <b>' + gzCompact(exact.food != null ? exact.food : 0) + '</b></span><span>兵源 <b>' + gzCompact(exact.manpower != null ? exact.manpower : 0) + '</b></span><span>税 <b>' + Math.round((exact.taxRate != null ? exact.taxRate : 0.3) * 100) + '%</b>' + (typeof exact.taxMoralePerTurn === 'number' ? ' · 民心 ' + (exact.taxMoralePerTurn > 0 ? '+' : '') + exact.taxMoralePerTurn + '/回合' : '') + '</span></div>' +
      '<div class="gz-morale"><div class="gz-morale-top"><span>全国民心 <b>' + morale + '</b></span><span>战力×' + moraleFactor + '</span></div>' +
      '<div class="gz-bar"><i style="width:' + Math.max(0, Math.min(100, morale)) + '%"></i></div>' +
      (morale < lowThreshold ? '<div class="gz-warn">民心偏低：征兵与战火会放大地区动乱</div>' : '') + '</div>' +
      '<div class="gz-turnline">第 ' + v.turn + ' / ' + ((v.scenario && v.scenario.maxTurns) ? v.scenario.maxTurns : '∞') + ' 回合 · 同时下令 · 种子 ' + esc((v.scenario && v.scenario.rootSeed) || '') + '</div>' +
      '</div>';
    var seatStatus = selfF.eliminated
      ? '<div class="gz-locked-note">势力已灭亡。仍可观看战局，本局在当前回合结算后结束。</div>'
      : v.locked
        ? '<div class="gz-locked-note">已锁定。等待：' + (waiting.length ? esc(waiting.join('、')) : '结算中') + '</div>'
        : '<div class="gz-orders-head"><span>本回合指令 ' + (v.pendingOrders || []).length + ' 条</span>' +
          '<button class="btn small secondary" data-action="gz-clear"' + ((v.pendingOrders || []).length === 0 ? ' disabled' : '') + '>清空</button>' +
          '<button class="btn small" data-action="gz-lock">锁定并结算</button></div>';
    var pending = (v.pendingOrders || []).length
      ? '<div class="gz-pending">' + (v.pendingOrders || []).map(function (o) { return '<div class="gz-pending-row">' + esc(o.label) + '</div>'; }).join('') + '</div>'
      : '<div class="gz-empty">尚未下单。可以空锁定（休整），也可以先点地块查看动作。</div>';
    var factions = '<div class="gz-card"><div class="gz-subtitle">列国</div><div class="gz-factions">' +
      (v.factions || []).map(function (f) {
        var color = gzColor(((v.map && v.map.factionColors) || {})[f.id], f.id);
        return '<div class="gz-faction-row' + (f.id === selfId ? ' me' : '') + '"><span class="gz-dot" style="background:' + color + '"></span>' +
          '<span class="gz-fname">' + esc(f.name) + '</span>' +
          (f.aiArchetype ? '<span class="gz-ai-style">' + esc(GZ_AI_STYLE[f.aiArchetype] || f.aiArchetype) + '</span>' : '') +
          (typeof f.grudge === 'number' ? '<span class="gz-rel" title="潜在恨意 / 贸易政策 / 历史宣战">恨 ' + f.grudge + ' · ' + esc(GZ_TRADE[f.tradePolicy] || '—') + (f.wars ? ' · ' + f.wars + '战' : '') + '</span>' : '') +
          '<span class="gz-fmeta">' + f.regionCount + ' 区 · 民心 ' + f.morale + '</span>' +
          '<span class="gz-rel rel-' + esc(f.relation || 'neutral') + '">' + esc(gzRelationText(f.relation)) + '</span></div>';
      }).join('') + '</div></div>';
    var detail = '';
    if (selRegion) {
      var stacks = selRegion.stacks || [];
      detail = '<div class="gz-card"><div class="gz-subtitle">' + esc(selRegion.name) + ' · ' + esc(gzFactionName(v, selRegion.owner)) + '</div>' +
        '<div class="gz-detail-grid">' +
        '<span>地形</span><b>' + esc(GZ_TERRAIN[selRegion.terrain] || selRegion.terrain || '?') + '</b>' +
        (selRegion.population != null ? '<span>人口</span><b>' + gzCompact(selRegion.population) + '</b>' : '') +
        (selRegion.civilianPopulation != null ? '<span>平民</span><b>' + gzCompact(selRegion.civilianPopulation) + (selRegion.population > 0 ? '（' + Math.round(selRegion.civilianPopulation / selRegion.population * 100) + '%）' : '') + '</b>' : '') +
        '<span>视野</span><b>' + ({ full: '完全掌握', partial: '部分掌握', name_only: '情报不足', unknown: '未知' }[selRegion.visibility] || '?') + '</b>' +
        (selRegion.developmentLabel ? '<span>发展</span><b>' + esc(selRegion.developmentLabel) + '</b>' : '') +
        (selRegion.fortLevel != null ? '<span>要塞</span><b>Lv' + selRegion.fortLevel + '</b>' : '') +
        (selRegion.infrastructure != null ? '<span>基建</span><b>Lv' + selRegion.infrastructure + '</b>' : '') +
        (selRegion.unrest != null ? '<span>动乱</span><b>' + selRegion.unrest + '</b>' : '') +
        '</div>' +
        (selRegion.civilianPopulation != null
          ? '<div class="gz-terrain-note">' + (selRegion.civilianOutputFactor != null ? '本区粮/金产出 ×' + Number(selRegion.civilianOutputFactor).toFixed(2) + '（平民占比越低产量越少）；' : '') + '平民 = 本区人口 − 驻军；征兵会减少平民，影响税收与兵源增长。</div>'
          : '') + gzTerrainNoteHtml(v, selRegion) +
        (selRegion.rebellion
          ? '<div class="gz-warn">' + (function (reb) {
              var bits = ['原属 ' + esc(reb.originalName || reb.original)];
              if (reb.claimedBy) {
                bits.push('已归附 ' + esc(reb.claimedByName || reb.claimedBy));
                if (reb.claimedTurn != null) bits.push('宣称于 T' + reb.claimedTurn);
                if (reb.conscriptionTurns != null) bits.push(reb.conscriptionTurns + ' 回合内征兵会再次起义');
              } else {
                bits.push('起义军据城；原属国杀光全部民兵才能重占');
              }
              bits.push('起义民兵 ' + gzCompact(reb.rebelTroops || 0));
              return bits.join('；');
            })(selRegion.rebellion) + '</div>'
          : '') +
        (selRegion.frontier && selRegion.owner === null
          ? '<div class="gz-warn">未开垦荒地：原住民 ' + gzCompact(selRegion.frontier.natives) + '（需本区兵力 ≥ ' + gzCompact(selRegion.frontier.requiredTroops || 0) + '）；派兵进入后开荒（基建 Lv' + selRegion.frontier.infrastructure + '），花 ' + selRegion.frontier.goldCost + ' 金 / ' + selRegion.frontier.foodCost + ' 粮，获约 ' + gzCompact(selRegion.frontier.lootGold) + ' 金；派兵与开荒分两回合，普通进攻不能占领。</div>'
          : '') +
        (stacks.length
          ? '<div class="gz-stacks">' + stacks.map(function (s) {
              return '<div class="gz-stack"><span style="color:' + gzColor(((v.map && v.map.factionColors) || {})[s.ownerId], s.ownerId) + '">' + esc(gzFactionName(v, s.ownerId)) + '</span>' + esc(s.typeName) + (s.title === 'bandit_conscript' ? '·贼配军' : s.title === 'rebel_militia' ? '·起义民兵' : s.title === 'rebel_garrison' ? '·守城民兵' : '') + ' · ' + gzCompact(s.troops) + ' · ' + esc(GZ_TIER[s.tier] || s.tier) + '</div>';
            }).join('') + (stacks.some(function (s) { return s.title === 'bandit_conscript'; }) ? '<div class="gz-warn">贼配军：每支每回合 +4 本区动乱；自然 -3 ⇒ 一支净 +1、两支净 +5；裁军不回兵源。</div>' : '') + '</div>'
          : '<div class="gz-empty">' + (selRegion.visibility === 'full' ? '区域内没有驻军。' : '情报不足以看清驻军。') + '</div>') +
        '</div>';
    } else {
      detail = '<div class="gz-card"><div class="gz-subtitle">地块</div><div class="gz-empty">点地图上的六角格查看该地的驻军、内政与可用动作。</div></div>';
    }
    var actionList = (v.actions || []).filter(function (a) {
      if (a.sourceRegion || a.targetRegion) return !!sel && (a.sourceRegion === sel || a.targetRegion === sel);
      return true;
    });
    var groups = {};
    actionList.forEach(function (a) { var g = GZ_GROUP[a.kind] || '其他'; (groups[g] = groups[g] || []).push(a); });
    var actions = '<div class="gz-card"><div class="gz-subtitle">可用动作' + (sel ? ' · ' + esc(gzRegionName(v, sel)) : ' · 全国') + '</div>' +
      (actionList.length
        ? ['出击', '调动', '内政', '编成', '国策', '其他'].map(function (g) { return gzActionGroupHtml(v, groups[g] || [], g); }).join('')
        : '<div class="gz-empty">' + (v.locked ? '本回合已锁定。' : (sel ? '该地块当前没有可用动作（可能没有未行动部队、资源不足或本回合已锁定）。' : '先选择一块己方或相邻地块。')) + '</div>') +
      '</div>';
    var report = gzReportHtml(v);
    return head + seatStatus + pending + detail + factions + actions + gzCodexHtml(v) + report;
  }
  function gzTerrainNoteHtml(v, r) {
    var list = (v.map && v.map.terrain) || [];
    var t = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === r.terrain) { t = list[i]; break; }
    if (!t) return '';
    var bits = [
      '粮产×' + t.food, '金产×' + t.gold, '人口×' + t.popGrowth,
      '情报费×' + t.intelCost, '行军×' + t.moveCost, '守军×' + t.defenderBonus
    ];
    if (t.infantryDefense > 1) bits.push('步兵守备×' + t.infantryDefense);
    return '<div class="gz-terrain-note">' + esc((GZ_TERRAIN[r.terrain] || r.terrain || '地形') + '：' + bits.join(' · ')) + '</div>';
  }
  function gzCodexHtml(v) {
    var units = (v.map && v.map.units) || [];
    if (!units.length) return '';
    var byName = {};
    units.forEach(function (u) { byName[u.id] = u.name; });
    var rows = units.map(function (u) {
      var counters = Object.keys(u.counters || {}).map(function (k) {
        return (byName[k] || k) + ' +' + Math.round((u.counters[k] || 0) * 100) + '%';
      }).join('、');
      var domain = u.domain === 'water' ? '水师' : u.domain === 'amphibious' ? '两栖' : '陆军';
      return '<div class="gz-unit-row"><b>' + esc(u.name) + '</b><span>' + domain + ' · 攻 ' + u.attack + ' 守 ' + u.defense + ' 移 ' + u.movement + '</span>' +
        '<span class="gz-unit-cost">征 ' + u.recruitGold + '金/' + u.recruitFood + '粮 · 养 ' + u.upkeepGold + '/' + u.upkeepFood + '</span>' +
        (counters ? '<span class="gz-unit-counter">克制 ' + esc(counters) + '</span>' : '') + '</div>';
    }).join('');
    return '<details class="gz-card gz-codex"><summary>兵种图鉴（' + units.length + '）</summary><div class="gz-unit-list">' + rows + '</div></details>';
  }
  function gzReportHtml(v) {
    var events = gzReportEvents(v);
    var review = v.selfReview;
    var money = ((v.report && v.report.baseline) || []).filter(function (d) {
      return d && (d.field === 'gold' || d.field === 'food') && d.delta;
    }).slice(0, 8);
    var moneyHtml = money.length
      ? '<div class="gz-subtitle" style="margin-top:8px">国库变化</div><div class="gz-report">' +
        money.map(function (d) {
          return '<div class="gz-event ' + (d.delta < 0 ? 'cap' : '') + '">' +
            (d.field === 'gold' ? '金 ' : '粮 ') + (d.delta > 0 ? '+' : '') + d.delta + ' · ' + esc(d.reason) + '</div>';
        }).join('') + '</div>'
      : '';
    var rejected = (v.report && v.report.rejected) || [];
    var rejectedHtml = rejected.length
      ? '<div class="gz-subtitle" style="margin-top:8px">被拒军令</div><div class="gz-report">' +
        rejected.slice(0, 8).map(function (r) {
          return '<div class="gz-event cap">' + esc((r.code || 'REJECTED') + ': ' + (r.message || '')) + '</div>';
        }).join('') + '</div>'
      : '';
    var reviewHtml = review
      ? '<div class="gz-review"><div class="gz-subtitle">战后复盘</div>' +
        (review.archetype
          ? '<div class="gz-policy">AI 原型：' + esc(GZ_AI_STYLE[review.archetype] || review.archetype) +
            (typeof review.reward === 'number' ? ' · 上回合奖励 ' + (review.reward >= 0 ? '+' : '') + review.reward : '') + '</div>'
          : '') +
        (review.lessons || []).slice(0, 3).map(function (l) { return '<div class="gz-lesson">' + esc(l) + '</div>'; }).join('') +
        (review.policy
          ? '<div class="gz-policy">策略：进攻阈值 ' + review.policy.attackRatio + ' · 防守 ' + review.policy.defenseBias + ' · 基建 ' + review.policy.infraBias + ' · 谍报 ' + review.policy.spyBias + '</div>'
          : '') + '</div>'
      : '';
    return '<div class="gz-card"><div class="gz-subtitle">上回合战报</div>' +
      (events.length
        ? '<div class="gz-report">' + events.map(function (e) { return '<div class="gz-event ' + e.tone + '">' + esc(e.text) + '</div>'; }).join('') + '</div>'
        : '<div class="gz-empty">还没有战报。第一回合锁定后会显示交战、易手与外交变化。</div>') +
      moneyHtml + rejectedHtml + reviewHtml + '</div>';
  }
  function renderGuozhan() {
    var v = st.view; if (!v) return renderBoot();
    var head = '<div class="turn-banner mine">国战 · 第 ' + v.turn + ' 回合 · ' + esc((v.scenario && v.scenario.name) || '') + '</div>';
    var tools = '<div class="gz-map-tools"><button class="gz-tool" data-action="gz-zoom-out">−</button>' +
      '<span class="gz-zoom-label">' + (st.gzZoom || 1).toFixed(1) + 'x</span>' +
      '<button class="gz-tool" data-action="gz-zoom-in">＋</button>' +
      '<button class="gz-tool wide" data-action="gz-zoom-reset">适配</button></div>';
    appEl.innerHTML = '<div class="screen game gz-screen">' + head +
      '<div class="gz-layout"><div class="gz-map-wrap' + ((st.gzZoom || 1) > 1 ? ' zoomed' : '') + '">' + tools + gzMapHtml(v) + '</div><div class="gz-side">' + gzPanelHtml(v) + '</div></div>' +
      chatBarHtml() + '</div>';
  }
  function renderGzOver() {
    var v = st.view;
    var winFaction = v.winnerFaction ? gzFactionName(v, v.winnerFaction) : '';
    var winPlayer = v.winnerSeat != null && v.players[v.winnerSeat] ? v.players[v.winnerSeat].name : (v.winnerName || '');
    var winText = winFaction
      ? winFaction + (winPlayer && winPlayer !== winFaction ? '（' + winPlayer + '）' : '') + ' 胜'
      : (winPlayer ? winPlayer + ' 胜' : '未分胜负');
    var reason = { conquest: '征服胜利', turn_limit: '回合上限，按综合评分判定', resignation: '认输', draw: '和局' }[v.endReason] || v.endReason || '';
    var scores = v.endScores || {};
    var rows = Object.keys(scores).sort(function (a, b) {
      var ra = (scores[a] && scores[a].regions) || 0, rb = (scores[b] && scores[b].regions) || 0;
      return rb - ra || ((scores[b] && scores[b].troops) || 0) - ((scores[a] && scores[a].troops) || 0);
    }).map(function (fid) {
      var s = scores[fid] || {};
      return '<div class="rank-row"><span>' + esc(gzFactionName(v, fid)) + '</span><span>' + (s.regions || 0) + ' 区 · 兵 ' + gzCompact(s.troops) + ' · 民心 ' + (s.morale || 0) + '</span></div>';
    }).join('');
    var isOwner = st.owner || st.role === 'host' || st.role === 'demo';
    var btn = isOwner ? '<button class="btn" data-action="again">再来一局</button>' : '<p class="hint">等待房主开始下一局…</p>';
    appEl.innerHTML = '<div class="screen"><div class="modal"><h2>国战结束</h2>' +
      '<div class="winner-name">' + esc(winText) + '</div>' +
      '<p class="hint">' + esc(reason) + '</p>' + rows + scoreSummaryHtml() +
      '<div class="btn-row" style="margin-top:18px;justify-content:center">' + btn + '</div></div></div>';
  }

  // ---- 大富翁 ----
  var MONO_COLORS = ['#e06c5e', '#6fb1d8', '#7fc7a0', '#e0b95e'];
  var MONO_KIND = { go: '起点', property: '地产', chance: '机会', tax: '税关', jail: '监狱', free: '停车', gojail: '入狱' };
  function monoCoord(i) {
    if (i <= 6) return { c: i, r: 0 };
    if (i <= 12) return { c: 6, r: i - 6 };
    if (i <= 18) return { c: 6 - (i - 12), r: 6 };
    return { c: 0, r: 6 - (i - 18) };
  }
  function monoMoney(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  function monoPlayerName(v, id) {
    const p = (v.players || []).find((x) => x.id === id);
    return p ? p.name : '—';
  }
  var MONO_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function monoDieHtml(n) {
    var on = MONO_PIPS[n] || [];
    var cells = '';
    for (var i = 0; i < 9; i++) cells += '<i' + (on.indexOf(i) >= 0 ? ' class="on"' : '') + '></i>';
    return '<span class="die" data-face="' + n + '">' + cells + '</span>';
  }
  function monoTileRect(i) {
    var el = appEl.querySelector('.mono-tile[data-tile="' + i + '"]');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }
  /** 掷骰/走格/收租的表现层动画：纯视觉，不改变任何规则状态。 */
  function animateMonopoly(v) {
    var board = appEl.querySelector('.mono-board');
    if (!board) return;

    // 1) 骰子翻滚：点数或回合变了才重放，避免每次重渲染都抖
    var rollKey = v.roll ? (v.roll.a + '-' + v.roll.b + '-T' + v.turnCount) : '';
    var diceEl = appEl.querySelector('.mono-dice');
    if (diceEl && rollKey && rollKey !== st._monoRollKey) {
      diceEl.classList.remove('rolling');
      void diceEl.offsetWidth; // 强制重排，让动画能连续触发
      diceEl.classList.add('rolling');
      if (st._monoRollTimer) clearTimeout(st._monoRollTimer);
      st._monoRollTimer = setTimeout(function () { diceEl.classList.remove('rolling'); }, 900);
    }
    st._monoRollKey = rollKey;

    // 2) 棋子按点数逐格移动（含过起点绕圈）
    // 棋子原本在格子内，而格子是 overflow:hidden —— 所以沿路画一个浮层棋子，
    // 真棋子先隐藏，走到终点再显示，避免被格边裁掉。
    var prev = st._monoPrevPos || null;
    var next = {};
    (v.players || []).forEach(function (p) { next[p.id] = p.pos; });
    if (prev) {
      (v.players || []).forEach(function (p) {
        if (p.bankrupt) return;
        var from = prev[p.id];
        if (from == null || from === p.pos) return;
        var token = appEl.querySelector('.mono-token[data-seat="' + p.id + '"]');
        var start = monoTileRect(from);
        var end = monoTileRect(p.pos);
        if (!token || !start || !end || !board.animate) return;
        var steps = (p.pos - from + 24) % 24;
        if (steps === 0) steps = 24;
        var boardRect = board.getBoundingClientRect();
        var fly = document.createElement('span');
        fly.className = 'mono-token mono-token-fly';
        fly.style.background = token.style.background || '';
        fly.textContent = token.textContent;
        fly.style.left = (start.x - boardRect.left) + 'px';
        fly.style.top = (start.y - boardRect.top) + 'px';
        board.appendChild(fly);
        token.style.visibility = 'hidden';
        var frames = [];
        for (var s = 1; s <= steps; s++) {
          var r = monoTileRect((from + s) % 24);
          if (!r) continue;
          frames.push({ left: (r.x - boardRect.left) + 'px', top: (r.y - boardRect.top) + 'px' });
        }
        frames.push({ left: (end.x - boardRect.left) + 'px', top: (end.y - boardRect.top) + 'px' });
        var anim = fly.animate(frames, {
          duration: Math.min(1600, 130 * steps + 200),
          easing: 'ease-in-out',
        });
        anim.onfinish = function () {
          if (fly.parentNode) fly.parentNode.removeChild(fly);
          token.style.visibility = '';
        };
      });
    }
    st._monoPrevPos = next;

    // 3) 租金/罚金飘字：从日志里捞出本次新增的扣款条目
    var logs = v.log || [];
    var lastSeen = st._monoLogSeen || 0;
    var fresh = logs.slice(Math.max(0, logs.length - 12));
    var newLines = fresh.filter(function (line, idx) {
      return idx >= fresh.length - Math.max(0, logs.length - lastSeen) && /支付租金|缴纳「/.test(line);
    });
    st._monoLogSeen = logs.length;
    newLines.slice(-2).forEach(function (line) {
      var m = /^(.+?) (?:踩中|缴纳)/.exec(line);
      var who = m && m[1];
      var payer = (v.players || []).find(function (p) { return p.name === who; });
      if (!payer) return;
      var at = monoTileRect(payer.pos);
      if (!at) return;
      var boardRect = board.getBoundingClientRect();
      var amount = /(\d+)\s*金/.exec(line);
      var floater = document.createElement('div');
      floater.className = 'mono-float';
      floater.textContent = (amount ? '-' + amount[1] : '付租') + ' 金';
      floater.style.left = (at.x - boardRect.left) + 'px';
      floater.style.top = (at.y - boardRect.top) + 'px';
      board.appendChild(floater);
      setTimeout(function () { if (floater.parentNode) floater.parentNode.removeChild(floater); }, 1200);
    });
  }
  function renderMonopoly() {
    var v = st.view; if (!v) return renderBoot();
    if (st._monoGame !== st.game) { st._monoGame = st.game; st._monoPrevPos = null; st._monoLogSeen = 0; st._monoRollKey = ''; }
    var me = v.you;
    var board = (v.board || []).slice().sort((a, b) => a.i - b.i);
    var tiles = board.map(function (t) {
      var pos = monoCoord(t.i);
      var owner = t.ownerId != null ? MONO_COLORS[t.ownerId % MONO_COLORS.length] : null;
      var tokens = (v.players || []).filter(function (p) { return !p.bankrupt && p.pos === t.i; })
        .map(function (p) { return '<span class="mono-token" data-seat="' + p.id + '" style="background:' + MONO_COLORS[p.id % MONO_COLORS.length] + '">' + (p.id + 1) + '</span>'; }).join('');
      var detail = t.kind === 'property' ? '<span class="mono-price">' + monoMoney(t.price) + '</span>' + (t.houses ? '<span class="mono-houses">' + '▮'.repeat(t.houses) + '</span>' : '') : '<span class="mono-price">' + (MONO_KIND[t.kind] || '') + '</span>';
      return '<div class="mono-tile mono-' + esc(t.kind) + (v.current != null && v.players[v.current] && t.i === v.players[v.current].pos ? ' here' : '') + '" data-tile="' + t.i + '" style="grid-column:' + (pos.c + 1) + ';grid-row:' + (pos.r + 1) + ';' + (owner ? '--mono-owner:' + owner + ';' : '') + '">' +
        '<div class="mono-name">' + esc(t.name) + '</div>' + detail + (owner ? '<div class="mono-owner"></div>' : '') + '<div class="mono-tokens">' + tokens + '</div></div>';
    }).join('');
    var cur = v.players[v.current] || {};
    var own = v.players[me] || {};
    var actions = (v.actions || []).map(function (a) {
      return '<button class="btn small ' + (a.kind === 'roll' || a.kind === 'buy' ? '' : 'secondary') + '" data-mono="' + esc(a.kind) + '">' + esc(a.label) + '</button>';
    }).join(' ');
    var logs = (v.log || []).slice(-10).reverse().map(function (x) { return '<div class="mono-log-line">' + esc(x) + '</div>'; }).join('');
    var players = (v.players || []).map(function (p) {
      return '<div class="mono-player' + (p.id === me ? ' me' : '') + (p.bankrupt ? ' out' : '') + (p.id === v.current ? ' turn' : '') + '">' +
        '<span class="mono-dot" style="background:' + MONO_COLORS[p.id % MONO_COLORS.length] + '"></span>' +
        '<b>' + esc(p.name) + '</b><span>' + monoMoney(p.cash) + ' 金</span><span>净值 ' + monoMoney(p.netWorth) + '</span>' +
        (p.inJail ? '<span class="tag">狱</span>' : '') + (p.bankrupt ? '<span class="tag off">破产</span>' : '') + '</div>';
    }).join('');
    var center = '<div class="mono-center"><div class="mono-turn">' + (cur.id === me ? '轮到你' : '等待 ' + esc(cur.name || '—') + '…') + ' · 第 ' + v.turnCount + ' 回合</div>' +
      (v.roll ? '<div class="mono-dice">' + monoDieHtml(v.roll.a) + monoDieHtml(v.roll.b) + '<span class="mono-dice-sum">' + (v.roll.doubles ? '双数 · 再走一次' : '') + ' = <b>' + v.roll.total + '</b></span></div>' : '') +
      '<div class="mono-cash">金 ' + monoMoney(own.cash) + ' · 净值 ' + monoMoney(own.netWorth) + '</div>' +
      (v.pending ? '<div class="mono-pending">当前地块：' + esc((v.board.find(function (t) { return t.i === v.pending.tile; }) || {}).name || '') + '</div>' : '') +
      '<div class="btn-row" style="justify-content:center">' + (actions || '<span class="hint">等待其他玩家</span>') + '</div>' +
      '<div class="mono-log">' + (logs || '<div class="mono-log-line">尚无记录</div>') + '</div></div>';
    appEl.innerHTML = '<div class="screen game mono-screen"><div class="turn-banner ' + (cur.id === me ? 'mine' : '') + '">大富翁 · 第 ' + v.turnCount + ' 回合 · ' + esc(cur.name || '') + '</div>' +
      '<div class="mono-layout"><div class="mono-board">' + tiles + center + '</div><div class="mono-side">' + players + '</div></div>' + chatBarHtml() + '</div>';
    animateMonopoly(v);
  }
  function renderMonoOver() {
    var v = st.view;
    var winner = v.players[v.winner];
    var rows = v.players.slice().sort(function (a, b) { return (b.netWorth || 0) - (a.netWorth || 0); }).map(function (p) {
      return '<div class="rank-row"><span>' + (p.id + 1) + '. ' + esc(p.name) + (p.bankrupt ? '（破产）' : '') + '</span><span>净值 ' + monoMoney(p.netWorth) + '</span></div>';
    }).join('');
    var isOwner = st.owner || st.role === 'host' || st.role === 'demo';
    appEl.innerHTML = '<div class="screen"><div class="modal"><h2>大富翁结束</h2>' +
      '<div class="winner-name">' + (winner ? esc(winner.name) + ' 胜' : '无人胜出') + '</div>' +
      '<p class="hint">' + (v.endReason === 'turn_limit' ? '达到回合上限，按净资产判定' : '其他玩家破产') + '</p>' + rows + scoreSummaryHtml() +
      '<div class="btn-row" style="margin-top:18px;justify-content:center">' + (isOwner ? '<button class="btn" data-action="again">再来一局</button>' : '') + '</div></div></div>';
  }

  // ---- 狼人杀 ----
  var WW_STAGE = { night: '夜晚', day_speech: '白天 · 发言', day_vote: '白天 · 投票', roundEnd: '结束' };
  function wwPlayerName(v, id) {
    var p = (v.players || []).find((x) => x.id === id);
    return p ? p.name : '—';
  }
  function renderWerewolf() {
    var v = st.view; if (!v) return renderBoot();
    var me = v.you;
    var self = v.players[me] || {};
    var stage = v.stage === 'night' ? '第 ' + v.nightCount + ' 夜' : v.stage === 'roundEnd' ? '结束' : '第 ' + v.dayCount + ' 天';
    var players = (v.players || []).map(function (p) {
      var reveal = p.roleName && (p.alive === false || p.id === me || v.phase === 'roundEnd');
      return '<div class="ww-player' + (p.id === me ? ' me' : '') + (p.alive ? '' : ' dead') + (p.id === v.current ? ' turn' : '') + '">' +
        '<b>' + (p.id + 1) + '. ' + esc(p.name) + '</b>' +
        (p.id === me ? '<span class="tag">你</span>' : '') +
        (!p.alive ? '<span class="tag off">出局</span>' : '') +
        (reveal ? '<span class="tag role">' + esc(p.roleName) + '</span>' : '') + '</div>';
    }).join('');
    var rolePanel = '<div class="ww-role-card"><div class="ww-role-name">' + esc(v.roleName || '—') + '</div><div class="ww-role-desc">' + esc(v.roleDesc || '') + '</div>' +
      ((v.teammates || []).length ? '<div class="ww-note">狼队友：' + v.teammates.map(function (t) { return esc(t.name); }).join('、') + '</div>' : '') +
      (v.role === 'seer' && Object.keys(v.seerKnowledge || {}).length ? '<div class="ww-note">验人记录：' + Object.keys(v.seerKnowledge).map(function (id) { return esc(wwPlayerName(v, Number(id))) + '=' + esc(v.seerKnowledge[id]); }).join('、') + '</div>' : '') +
      (v.role === 'witch' ? '<div class="ww-note">解药 ' + (v.witch && v.witch.saveUsed ? '已用' : '可用') + ' · 毒药 ' + (v.witch && v.witch.poisonUsed ? '已用' : '可用') + (v.witch && v.witch.victim != null ? ' · 今晚刀口 ' + esc(wwPlayerName(v, v.witch.victim)) : '') + '</div>' : '') +
      '</div>';
    var actions = '';
    if (v.phase === 'playing' && v.current === me && (v.actions || []).length) {
      var hasSay = v.actions.some(function (a) { return a.kind === 'say'; });
      var buttons = v.actions.map(function (a) {
        if (a.kind === 'say') return '';
        var attr = 'data-ww-kind="' + esc(a.kind) + '"' + (a.targetSeat != null ? ' data-ww-target="' + a.targetSeat + '"' : '') + (a.action ? ' data-ww-action="' + esc(a.action) + '"' : '');
        return '<button class="btn small ' + (a.kind === 'pass' || a.kind === 'abstain' || a.action === 'none' ? 'secondary' : '') + '" ' + attr + '>' + esc(a.label) + '</button>';
      }).join(' ');
      actions = '<div class="ww-actions">' + (hasSay ? '<div class="ww-speech-row"><input id="wwSpeech" class="chat-input" maxlength="300" placeholder="说一句话…" /><button class="btn small" data-ww-kind="say">发言</button></div>' : '') +
        '<div class="btn-row" style="justify-content:center">' + buttons + '</div></div>';
    } else if (v.phase === 'playing') {
      actions = '<div class="ww-wait">' + (self.alive === false ? '你已出局，观战中。' : '等待 ' + esc(wwPlayerName(v, v.current)) + ' 行动…') + '</div>';
    }
    var logs = (v.log || []).slice(-14).reverse().map(function (x) { return '<div class="ww-log-line">' + esc(x) + '</div>'; }).join('');
    var speeches = (v.speeches || []).slice(-8).map(function (s) { return '<div class="ww-speech"><b>' + esc(wwPlayerName(v, s.seat)) + '：</b>' + esc(s.text) + '</div>'; }).join('');
    appEl.innerHTML = '<div class="screen game ww-screen"><div class="turn-banner ' + (v.current === me && v.phase === 'playing' ? 'mine' : '') + '">狼人杀 · ' + stage + ' · ' + esc(WW_STAGE[v.stage] || v.stage) + '</div>' +
      '<div class="ww-layout"><div class="ww-main"><div class="ww-players">' + players + '</div>' + rolePanel + '<div class="ww-card"><div class="gz-subtitle">公开发言</div>' + (speeches || '<div class="gz-empty">还没有发言</div>') + '</div>' + actions + '</div>' +
      '<div class="ww-card ww-log"><div class="gz-subtitle">日志</div>' + (logs || '<div class="gz-empty">等待开始…</div>') + '</div></div>' + chatBarHtml() + '</div>';
  }
  function renderWwOver() {
    var v = st.view;
    var winnerTeam = v.winnerTeam === 'wolves' ? '狼人阵营' : '好人阵营';
    var rows = (v.players || []).map(function (p) { return '<div class="rank-row"><span>' + (p.id + 1) + '. ' + esc(p.name) + '</span><span>' + esc(p.roleName || '?') + (p.alive ? ' · 存活' : ' · 出局') + '</span></div>'; }).join('');
    var isOwner = st.owner || st.role === 'host' || st.role === 'demo';
    appEl.innerHTML = '<div class="screen"><div class="modal"><h2>狼人杀结束</h2><div class="winner-name">' + winnerTeam + ' 胜</div><p class="hint">' + esc(v.endReason === 'wolves' ? '狼人达到人数优势' : '狼人全部出局') + '</p>' + rows + scoreSummaryHtml() +
      '<div class="btn-row" style="margin-top:18px;justify-content:center">' + (isOwner ? '<button class="btn" data-action="again">再来一局</button>' : '') + '</div></div></div>';
  }

  // ---- UNO card rendering ----
  function cardHtml(card, opts) {
    opts = opts || {};
    var cls = ['card']; cls.push(card.color || 'wild');
    if (opts.highlight) cls.push('highlight');
    if (opts.blocked) cls.push('blocked');
    if (opts.dim) cls.push('dim');
    var sym = symFor(card);
    var inner = card.kind === 'number' ? '<div class="num">' + card.value + '</div>' : '<div class="sym">' + sym + '</div>';
    var corner = (card.kind === 'number' || card.kind === 'skip' || card.kind === 'reverse' || card.kind === 'draw2') ? '<div class="corner">' + sym + '</div>' : '';
    return '<div class="' + cls.join(' ') + '" data-id="' + esc(card.id) + '">' + corner + inner + '</div>';
  }
  function symFor(card) {
    switch (card.kind) {
      case 'skip': return '⊘';
      case 'reverse': return '⇄';
      case 'draw2': return '+2';
      case 'wild': return '★';
      case 'wild4': return '+4';
      default: return String(card.value);
    }
  }

  // ---- actions ----
  function doSendClient(msg) {
    if (client) client.send({ t: 'act', ...msg });
    else if (host) host.act(msg);
  }
  function copyRoom() {
    var txt = st.wsUrl || '';
    var done = function () { toast('房间地址已复制'); };
    var fallback = function () { prompt('房间地址（长按/复制）：', txt); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else { fallback(); }
  }
  function showTargetPicker(onPick) {
    var view = st.view, me = st.you;
    var targets = view.players.map(function (p, i) { return { i: i, name: p.name, alive: p.alive, hand: p.handCount }; })
      .filter(function (t) { return t.i !== me && t.alive && t.hand > 0; });
    var rows = targets.map(function (t) { return '<button class="btn secondary" data-target="' + t.i + '">' + esc(t.name) + '</button>'; }).join('');
    var modal = document.createElement('div'); modal.className = 'overlay'; modal.id = 'targetPicker';
    modal.innerHTML = '<div class="modal"><h2>选择对象</h2><div class="color-row">' + rows + '</div></div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { modal.remove(); return; }
      var b = e.target.closest('button[data-target]');
      if (b) { var idx = Number(b.getAttribute('data-target')); modal.remove(); onPick(idx); }
    });
    document.body.appendChild(modal);
  }
  // 骗子酒馆专用：出完牌后指定任意一名存活的其他玩家开枪（无「手牌数>0」限制）。
  function showLiarTargetPicker(onPick) {
    var view = st.view, me = st.you;
    var targets = view.players.map(function (p, i) { return { i: i, name: p.name, alive: p.alive, shots: p.shots }; })
      .filter(function (t) { return t.i !== me && t.alive; });
    var rows = targets.map(function (t) { return '<button class="btn secondary" data-target="' + t.i + '">' + esc(t.name) + ' <span style="opacity:.7;font-size:12px">🔫' + (t.shots || 0) + '</span></button>'; }).join('');
    var modal = document.createElement('div'); modal.className = 'overlay'; modal.id = 'liarTargetPicker';
    modal.innerHTML = '<div class="modal"><h2>指定谁开枪</h2><div class="color-row">' + rows + '</div></div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { modal.remove(); return; }
      var b = e.target.closest('button[data-target]');
      if (b) { var idx = Number(b.getAttribute('data-target')); modal.remove(); onPick(idx); }
    });
    document.body.appendChild(modal);
  }
  function startActionPayload() {
    var out = { kind: 'start' };
    if (st.game === 'guozhan') {
      var seedEl = document.getElementById('gzSeed');
      if (seedEl) st.gzSeed = seedEl.value;
      out.seed = st.gzSeed || '';
      out.scenario = st.gzScenario || 'random-front-v2';
      out.unlimitedTurns = st.gzUnlimited !== false;
    }
    return out;
  }
  function onAction(action) {
    // 群星君主是纯本地界面，所有 civ-* 动作由 civ-ui.js 自包含处理。
    if (CIVUI && action && action.indexOf('civ-') === 0) { CIVUI.onAction(action); return; }
    if (action === 'start') {
      var p = startActionPayload();
      if (host) {
        var r = host.execute(host.hostSeat, { t: 'act', ...p });
        if (r && r.ok) botLoop();
      } else if (client) client.send({ t: 'act', ...p });
    }
    else if (action === 'draw') doSendClient({ kind: 'draw' });
    else if (action === 'pass') doSendClient({ kind: 'pass' });
    else if (action === 'uno') doSendClient({ kind: 'uno' });
    else if (action === 'again') {
      demoStop = false;
      var p2 = startActionPayload();
      if (host) { host.resetRound(); var r2 = host.execute(host.hostSeat, { t: 'act', ...p2 }); if (r2 && r2.ok) botLoop(); }
      else if (client) client.send({ t: 'act', ...p2 });
    }
    else if (action === 'ai-plus') { st.aiCount += 1; syncAi(); }
    else if (action === 'ai-minus') { st.aiCount -= 1; syncAi(); }
    else if (action === 'llm-plus') syncLlm(1);
    else if (action === 'llm-minus') syncLlm(-1);
    else if (action === 'llm-settings') showLlmSettings();
    else if (action === 'gz-llm-country') {
      if (!st.llmAvailable) { toast('服务器未配置 LLM，或本机尚未配置模型'); return; }
      if (st.llmCount >= maxLlmForGame()) { toast('LLM 席位已满'); return; }
      syncLlm(1);
      toast('LLM 将作为独立国家占用下一个未认领势力');
    }
    else if (action.indexOf('bid:') === 0) doSendClient({ kind: 'bid', score: Number(action.slice(4)) });
    else if (action.indexOf('gz-pick:') === 0) { st.gzScenario = action.slice(8); st.aiCount = Math.min(st.aiCount, maxAiForGame()); render(); }
    else if (action === 'gz-zoom-in') { st.gzZoom = Math.min(3, Math.round(((st.gzZoom || 1) + 0.25) * 100) / 100); render(); }
    else if (action === 'gz-zoom-out') { st.gzZoom = Math.max(0.6, Math.round(((st.gzZoom || 1) - 0.25) * 100) / 100); render(); }
    else if (action === 'gz-zoom-reset') { st.gzZoom = 1; render(); }
    else if (action === 'gz-lock') doSendClient({ kind: 'gz_lock' });
    else if (action === 'gz-clear') doSendClient({ kind: 'gz_clear' });
    else if (action === 'ddz-pass') doSendClient({ kind: 'pass' });
    else if (action === 'ddz-play') { var sel = st.selectedDdz || []; if (sel.length) doSendClient({ kind: 'play', cardIds: sel }); else toast('请先选中要出的牌'); }
    else if (action === 'ek-draw') doSendClient({ kind: 'draw' });
    else if (action === 'ek-defuse') { var inp = document.getElementById('ekPos'); doSendClient({ kind: 'defuse', position: Number(inp && inp.value) || 1 }); }
    else if (action === 'ek-cats') { var ids = (st.ekSelected || []).slice(); if (ids.length < 2) { toast('先选 2/3 张相同的猫牌'); return; } showTargetPicker(function (t) { doSendClient({ kind: 'cats', cardIds: ids, targetSeat: t }); st.ekSelected = []; }); }
    else if (action === 'ek-favor') { var fc = st.ekFavorCard; if (!fc) { toast('先选一张恩惠牌'); return; } showTargetPicker(function (t) { doSendClient({ kind: 'favor', cardId: fc, targetSeat: t }); st.ekFavorCard = null; }); }
    else if (action === 'ek-attack') { var ac = st.ekAttackCard; if (!ac) { toast('先选一张攻击牌'); return; } showTargetPicker(function (t) { doSendClient({ kind: 'attack', cardId: ac, targetSeat: t }); st.ekAttackCard = null; }); }
    else if (action === 'ek-shuffle') { var ss = st.ekShuffleSel || []; if (!ss.length) { toast('先选一张洗混牌'); return; } doSendClient({ kind: 'play', cardId: ss[0] }); st.ekShuffleSel = []; }
    else if (action === 'ek-shuffle2') { var s2 = (st.ekShuffleSel || []).slice(); if (s2.length !== 2) { toast('需要两张洗混牌'); return; } doSendClient({ kind: 'shuffle2', cardIds: s2 }); st.ekShuffleSel = []; }
    else if (action === 'lb-call') doSendClient({ kind: 'call' });
    else if (action === 'lb-play') { var lpIds = (st.liarSelected || []).slice(); if (!lpIds.length) { toast('请先选中要出的牌'); return; } doSendClient({ kind: 'claim', cardIds: lpIds }); st.liarSelected = []; }
    else if (action === 'lb-designate') { showLiarTargetPicker(function (t) { doSendClient({ kind: 'designate', targetSeat: t }); }); }
    else if (action === 'lb-fire') doSendClient({ kind: 'fire' });
    else if (action === 'copy-room') copyRoom();
    else if (action === 'ping') { st._manualPing = true; if (client) client.send({ t: 'ping' }); else if (host) host.act({ kind: 'ping' }); toast('正在 ping 服务器…'); }
    else if (action === 'send') sendChat((document.getElementById('chatInput') || {}).value || '');
    else if (action === 'emoji') toggleEmoji();
    else if (action.indexOf('emoji:') === 0) { sendChat(action.slice(6)); var bar = document.getElementById('emojiBar'); if (bar) bar.classList.add('hidden'); }
    else if (action.indexOf('select:') === 0) pickGame(action.slice(7));
    else if (action.indexOf('help:') === 0) showHelp(action.slice(5));
    else if (action === 'mods') showModManager();
    else if (action === 'leaderboard') showLeaderboard();
    else if (action === 'local') {
      if (st.game === 'civmonarchs') {
        if (CIVUI && CIVUI.hasCore()) CIVUI.enter();
        else toast('群星君主核心未加载：APK 缺少 civ-core.bundle.js');
        return;
      }
      if (st.mods && st.mods.some(function (m) { return m.key === st.game; })) { toast('该游戏是服务器 Mod：请点「加入房间」连服务器游玩（本地对战仅含内置游戏）'); return; }
      demoStop = false; bootDemo(st.game || 'uno');
    }
    else if (action === 'join') { var inp = document.getElementById('roomUrl'); var u = parseJoin((inp && inp.value) || st.wsUrl); if (!u) { toast('请先填入加入链接或地址'); return; } connectRoom(u, (prompt('你的登录昵称', st.name) || '玩家')); }
    else if (action === 'join-clip') {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) { var u = parseJoin(t); if (!u) { toast('剪贴板里没有识别到加入链接'); return; } connectRoom(u, (prompt('你的登录昵称', st.name) || '玩家')); }, function () { toast('无法读取剪贴板'); });
      } else { toast('此环境不支持读取剪贴板'); }
    }
    else if (action === 'back') { saveLocalGame(); st.screen = 'home'; render(); }
    else if (action === 'resume-save') resumeLocalSave();
    else if (action === 'discard-save') { clearLocalSave(); toast('已放弃上一局'); render(); }
    else if (action === 'find') doFind();
  }
  function doFind() { if (st.role === 'guest') { st.guestState = 'connecting'; if (st.screen === 'guest-home') render(); } if (bridge && bridge.findAndConnect) bridge.findAndConnect(); }

  // ---- card taps / selection ----
  function onCardTap(el, view) {
    if (!view) return;
    var id = el.dataset.id;
    if (st.game === 'doudizhu') {
      if (view.phase !== 'playing' || view.current !== st.you) return;
      st.selectedDdz = st.selectedDdz || [];
      var i = st.selectedDdz.indexOf(id);
      if (i >= 0) { st.selectedDdz.splice(i, 1); el.classList.remove('sel'); } else { st.selectedDdz.push(id); el.classList.add('sel'); }
      return;
    }
    if (st.game === 'exploding') {
      if (view.phase !== 'playing' || view.current !== st.you) return;
      if (view.pendingFavor && view.pendingFavor.target === st.you) { doSendClient({ kind: 'give', cardId: id }); return; }
      if (view.pendingDefuse) { toast('请先选择放回炸弹'); return; }
      var card = view.hand.find(function (c) { return c.id === id; });
      if (!card) return;
      if (card.kind === 'cat') {
        var sub = card.cat;
        var hasOther = st.ekSelected.some(function (cid) { var cd = view.hand.find(function (x) { return x.id === cid; }); return cd && cd.kind === 'cat' && cd.cat !== sub; });
        if (hasOther) st.ekSelected = []; // switching to a different cat colour
        var idx = st.ekSelected.indexOf(id);
        if (idx >= 0) st.ekSelected.splice(idx, 1);
        else if (st.ekSelected.length >= 3) { toast('最多用 3 张猫牌'); return; }
        else st.ekSelected.push(id);
        render(); return;
      }
      if (card.kind === 'favor') { st.ekFavorCard = (st.ekFavorCard === id ? null : id); render(); return; }
      if (card.kind === 'attack') { st.ekAttackCard = (st.ekAttackCard === id ? null : id); render(); return; }
      if (card.kind === 'shuffle') {
        var si = st.ekShuffleSel.indexOf(id);
        if (si >= 0) st.ekShuffleSel.splice(si, 1);
        else if (st.ekShuffleSel.length >= 2) { toast('最多选 2 张洗混牌'); return; }
        else st.ekShuffleSel.push(id);
        render(); return;
      }
      if (card.kind === 'skip' || card.kind === 'see') doSendClient({ kind: 'play', cardId: id });
      else toast(ekLabel(card) + ' 不能主动打出');
      return;
    }
    if (st.game === 'liarsbar') {
      if (view.phase !== 'playing' || view.current !== st.you) return;
      var card = view.hand.find(function (c) { return c.id === id; });
      if (!card) return;
      st.liarSelected = st.liarSelected || [];
      var li = st.liarSelected.indexOf(id);
      if (li >= 0) { st.liarSelected.splice(li, 1); }
      else { st.liarSelected.push(id); }
      render();
      return;
    }
    if (!view || view.phase !== 'playing') return;
    if (view.current !== st.you) return;
    if (view.turnState === 'drawn' && id !== st.drawnId) { toast('只能出刚摸到的那张牌'); return; }
    var card = view.hand.find(function (c) { return c.id === id; });
    if (!card) return;
    if (card.kind === 'wild' || card.kind === 'wild4') { st.pendingWildId = id; showColorPicker(card.kind); }
    else doSendClient({ kind: 'play', cardId: id });
  }
  function showColorPicker(kind) {
    var colors = ['red', 'yellow', 'green', 'blue']; var labels = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
    var rows = colors.map(function (c) { return '<button class="color-btn" style="background:var(--' + c + ')" data-action="pick:' + c + '">' + labels[c] + '</button>'; }).join('');
    var modal = document.createElement('div'); modal.className = 'overlay'; modal.id = 'colorPicker';
    modal.innerHTML = '<div class="modal"><h2>选择颜色</h2><div class="color-row">' + rows + '</div></div>';
    document.body.appendChild(modal);
  }
  function closeColorPicker() { var el = document.getElementById('colorPicker'); if (el) el.remove(); }
  function onColorPick(color) { if (st.pendingWildId) doSendClient({ kind: 'play', cardId: st.pendingWildId, color: color }); st.pendingWildId = null; closeColorPicker(); }

  // ---- event delegation ----
  var drag = null;
  var dragSeen = {}; // per-gesture: cardId already toggled, so each card flips once
  function ddzHit(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el.closest ? el.closest('.ddz-card[data-id]') : null;
  }
  appEl.addEventListener('pointerdown', function (e) {
    if (st.game !== 'doudizhu' || !st.view || st.view.phase !== 'playing') return;
    if (e.button != null && e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, moved: false };
  });
  appEl.addEventListener('pointermove', function (e) {
    if (!drag || st.game !== 'doudizhu') return;
    var moved = Math.abs(e.clientX - drag.x) > 8 || Math.abs(e.clientY - drag.y) > 8;
    if (!drag.moved && moved) { drag.moved = true; dragSeen = {}; st.dragSelect = true; }
    if (!drag.moved) return;
    var card = ddzHit(e);
    if (card && card.dataset.id) {
      var id = card.dataset.id;
      if (!dragSeen[id]) {
        dragSeen[id] = true; // flip this card once this swipe
        var idx = st.selectedDdz.indexOf(id);
        if (idx === -1) { st.selectedDdz.push(id); card.classList.add('sel'); }
        else { st.selectedDdz.splice(idx, 1); card.classList.remove('sel'); }
      }
    }
  });
  var endDrag = function () {
    if (drag && drag.moved) { st._suppressClick = true; setTimeout(function () { st._suppressClick = false; }, 0); }
    drag = null; dragSeen = {}; st.dragSelect = false;
  };
  appEl.addEventListener('pointerup', endDrag);
  appEl.addEventListener('pointercancel', endDrag);
  appEl.addEventListener('click', function (e) {
    if (st._suppressClick) { st._suppressClick = false; return; }
    var mono = e.target.closest('[data-mono]');
    if (mono) { doSendClient({ kind: mono.getAttribute('data-mono') }); return; }
    var ww = e.target.closest('[data-ww-kind]');
    if (ww) {
      var kind = ww.getAttribute('data-ww-kind');
      if (kind === 'say') {
        var input = document.getElementById('wwSpeech');
        var text = input ? input.value : '';
        if (!text.trim()) { toast('请先输入发言'); return; }
        doSendClient({ kind: 'say', text: text });
        return;
      }
      var msg = { kind: kind };
      var target = ww.getAttribute('data-ww-target');
      if (target != null) msg.targetSeat = Number(target);
      var wwAction = ww.getAttribute('data-ww-action');
      if (wwAction != null) msg.action = wwAction;
      doSendClient(msg);
      return;
    }
    var gzAct = e.target.closest('[data-gz-act]');
    if (gzAct) { doSendClient({ kind: 'gz_order', actionId: gzAct.getAttribute('data-gz-act') }); return; }
    var gzRegion = e.target.closest('[data-gz-region]');
    if (gzRegion) {
      var rid = gzRegion.getAttribute('data-gz-region');
      st.gzSelected = st.gzSelected === rid ? null : rid;
      render();
      return;
    }
    var cardEl = e.target.closest('.card[data-id]');
    if (cardEl) { onCardTap(cardEl, st.view); return; }
    var ek = e.target.closest('.ek-card[data-id]');
    if (ek) { onCardTap(ek, st.view); return; }
    var lb = e.target.closest('.lb-card[data-id]');
    if (lb) { onCardTap(lb, st.view); return; }
    var ddz = e.target.closest('.ddz-card[data-id]');
    if (ddz) { onCardTap(ddz, st.view); return; }
    var btn = e.target.closest('button[data-action], .game-card[data-action]');
    if (btn) { onAction(btn.dataset.action); }
  });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (btn && btn.dataset.action.indexOf('pick:') === 0) onColorPick(btn.dataset.action.slice(5));
  });

  // ---- 地图缩放：鼠标滚轮 / 双指捏合 ----
  function gzZoomApply(z) {
    st.gzZoom = Math.max(0.6, Math.min(3, Math.round(z * 100) / 100));
    var svg = document.querySelector('.gz-map-wrap .gz-map');
    if (svg) svg.style.width = Math.round(st.gzZoom * 100) + '%';
    var label = document.querySelector('.gz-zoom-label');
    if (label) label.textContent = st.gzZoom.toFixed(1) + 'x';
    var wrap = document.querySelector('.gz-map-wrap');
    if (wrap) wrap.classList.toggle('zoomed', st.gzZoom > 1);
  }
  function gzZoomTarget(e) {
    return st.screen === 'game' && st.game === 'guozhan' && e.target && e.target.closest && e.target.closest('.gz-map-wrap');
  }
  document.addEventListener('wheel', function (e) {
    if (!gzZoomTarget(e)) return;
    e.preventDefault();
    gzZoomApply((st.gzZoom || 1) * (e.deltaY < 0 ? 1.12 : 0.89));
  }, { passive: false });
  var gzPinch = null;
  function gzTouchDist(e) {
    var a = e.touches[0];
    var b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
  document.addEventListener('touchstart', function (e) {
    if (!gzZoomTarget(e) || e.touches.length !== 2) return;
    gzPinch = { dist: gzTouchDist(e), zoom: st.gzZoom || 1 };
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!gzPinch || e.touches.length !== 2 || !gzZoomTarget(e)) return;
    e.preventDefault();
    if (gzPinch.dist > 0) gzZoomApply(gzPinch.zoom * (gzTouchDist(e) / gzPinch.dist));
  }, { passive: false });
  document.addEventListener('touchend', function (e) {
    if (!e.touches || e.touches.length < 2) gzPinch = null;
  });

  // 切后台 / 关页 / 返回桌面都要落一份存档（WebView 里 pagehide 不一定触发，所以两个都挂）
  window.addEventListener('pagehide', function () { saveLocalGame(); if (CIVUI) CIVUI.saveNow(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { saveLocalGame(); if (CIVUI) CIVUI.saveNow(); } });

  // 群星君主：把 app.js 的渲染 / 提示 / 切屏能力注入自包含的离线界面层
  if (CIVUI) CIVUI.init({
    appEl: appEl, toast: toast, setStatus: setStatus,
    rerender: render, showHelp: showHelp,
    setScreen: function (n) { st.screen = n; },
  });

  function boot() {
    // The user's chosen game comes from the native bridge (HomeActivity picked it).
    // Make sure remote-room mode also uses it, so the room is created with the
    // game they selected instead of always falling back to UNO.
    if (bridge && bridge.getGame) st.game = bridge.getGame() || st.game || 'uno';
    // 原生首屏选中「群星君主 · 单机」时直接进离线界面，跳过蓝牙 / 房间 / UNOKU Host。
    if (st.game === 'civmonarchs' && CIVUI && CIVUI.hasCore()) {
      st.gameName = '群星君主';
      CIVUI.enter();
      return;
    }
    var room = getRoomUrl();
    if (room) connectRoom(room);
    else if (bridge) bootDevice();
    else bootWeb();
  }
  // A room URL can come from the native bridge (Android "join remote room")
  // or the URL's ?room= query (browser direct-share link).
  function getRoomUrl() {
    if (bridge && bridge.getRoomUrl) { var u = bridge.getRoomUrl(); if (u) return u; }
    var p = new URLSearchParams(location.search); return p.get('room') || '';
  }
  // Best-effort turn of a shared join text into a ws:// URL, so novices can just
  // paste/copy a link instead of typing the raw ws:// address.
  function parseJoin(text) {
    text = (text || '').trim();
    if (!text) return '';
    if (/^wss?:\/\//i.test(text)) return text;
    var m = text.match(/[?&]room=([^&\s]+)/); // an already-shared ?room= link
    if (m) return decodeURIComponent(m[1]);
    var u = text.match(/^(https?):\/\/([^\/]+)/i);
    if (u) { var proto = u[1] === 'https' ? 'wss' : 'ws'; return proto + '://' + u[2] + '/ws'; }
    var hp = text.match(/^([0-9A-Za-z.\-]+):(\d{1,5})$/); // plain host:port
    if (hp) return 'ws://' + hp[1] + ':' + hp[2] + '/ws';
    return text;
  }
  // Heart-beat: keep an idle WS/tunnel connection alive (some tunnels drop silent
  // connections after ~1min). Send a ping every 25s while connected.
  setInterval(function () {
    var t = client && client.transport;
    if (t && t.ws && t.ws.readyState === 1) client.send({ t: 'ping' });
  }, 25000);
  boot();
})();
