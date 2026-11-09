// host.js — the authoritative room. The host owns ONE game instance (any game
// from the registry) and is the single authority: it validates every action
// (its own and each guest's), applies it, and broadcasts a personalized state
// view to every player. This makes it impossible to cheat or desync.

import { GameError } from './game-error.js';
import { GAMES, getGame } from './games.js';
import { FrameDecoder, encodeMessage, M, SM } from './protocol.js';
import { scoreMatch } from './scoreboard.js';

// LLM 发言节流：不限每局次数，但要有真实的最小间隔，避免像弹幕
const LLM_SPEAK_GAP_MS = 20000;      // 公共频道：任意两次 LLM 发言
const LLM_CHAT_REPLY_GAP_MS = 12000; // 公共频道：人类发言触发的回复
const PUBLIC_CHAT_GAP_MS = 1500;     // 公共频道：每人最小发言间隔（私聊不受限）
const LLM_PRIVATE_REPLY_GAP_MS = 1200; // 私聊只防连发，不套公共 20 秒
import { captureRoom, restoreRoom } from './save-state.js';

export class Host {
  constructor({ game = 'uno', playerName = null, options = {}, random, remote = false, llm = null } = {}) {
    this.gameKey = game && GAMES[game] ? game : 'uno';
    this.playerName = playerName;
    this.gameOpts = options;
    this.gameRandom = random;
    this.remote = remote; // true = pure room server: every seat is a network client
    this.game = getGame(this.gameKey).create({ playerNames: playerName ? [playerName] : [], options, random });
    this.localSeat = playerName ? 0 : null; // the on-device host is seat 0 (if any)
    this.ownerSeat = null; // first remote client to join owns the room
    this.nextGuestId = 1;
    this.guests = new Map(); // guestId -> {id, name, seat, transport, decoder}
    this.botSeats = new Set(); // seat indices of local AI players (no transport)
    this.llmSeats = new Set(); // seat indices driven by a server-side LLM
    this.llm = llm; // { model, decide({gameKey,game,seat,view}) => action|action[] } | null
    this._llmTimer = null;
    this._llmBusy = false;
    this._llmLastKey = '';
    this._actionSeq = 0;
    this._llmFailStreak = 0;
    this._llmCooldownUntil = 0;
    this._llmChatCooldownUntil = 0; // 人类说话触发的回复节流（避免刷屏/烧额度）
    this._llmLastSpokeAt = 0; // 上一次 LLM 公共发言（say 或回复）的时间戳
    this._llmPrivateCooldownUntil = 0; // 私聊回复冷却（只防连发）
    this._lastScenario = null; // 最近一次开局选中的剧本：房间重建时必须沿用，否则会悄悄回到默认图
    this._llmChatTask = null;
    this.onLocalUpdate = null; // fn(payload) for the host UI
    this.onChat = null; // fn({from, text}) for chat (host includes itself)
    this.chatLog = []; // recent chat lines, fed to LLM seats for natural replies
    this.chatBudget = new Map(); // LLM 席位发言额度（Infinity = 每局不限，仅靠冷却节流）
    this.onLog = null; // fn(line) server-side logging hook
    this._botTimer = null; // server-side bot-drive timer (remote mode)
    this._botStall = { key: '', count: 0 };
    this.onMatchEnd = null; // fn(result) after a finished round (server persists scores)
    this._matchStartedAt = 0;
    this._matchResultSent = false;
    this._matchId = null;
    // Idle timeout: free guests whose connection is dead/hung (no messages for a
    // while). Active players are kept alive by the client's heartbeat ping, so
    // this only reclaims truly-abandoned connections and frees server resources.
    this.idleTimeoutMs = remote ? 3 * 60 * 1000 : 0;
    this._idleTimer = remote ? setInterval(() => this._reapIdle(), 20000) : null;
    if (this.llm) this.startLlmLoop();
  }

  _log(line) {
    if (this.onLog) this.onLog(line);
  }

  get gameInfo() {
    return getGame(this.gameKey);
  }

  // The seat that owns the room (for starting the game).
  get hostSeat() {
    return this.localSeat != null ? this.localSeat : this.ownerSeat;
  }

  // Register a freshly-connected guest transport. The guest must follow up with
  // a {t:'join', name} message; the seat is assigned at join time.
  addTransport(transport) {
    const id = this.nextGuestId++;
    const rec = { id, name: null, seat: null, transport, decoder: new FrameDecoder(), idleUntil: Date.now() + this.idleTimeoutMs };
    this.guests.set(id, rec);
    transport.onMessage = (bytes) => this.handleGuestBytes(id, bytes);
    transport.onDisconnect = () => this.disconnectGuest(id);
    this._log(`client ${id} connected`);
    return id;
  }

  seats() {
    return this.game.players.map((p, i) => ({ seat: i, name: p.name }));
  }

  // ---- local AI players (offline battle mode) ----
  // Bots are authoritative-local seats: they live in the game but use no
  // transport. The host UI drives their moves directly via execute().
  addBot(name) {
    if (this.game.phase !== 'lobby') return null;
    const safeName = String(name || 'AI').slice(0, 20);
    const seat = this.game.addPlayer(safeName);
    this.botSeats.add(seat);
    this.broadcastLobby();
    return seat;
  }

  removeBot(seat) {
    if (this.game.phase !== 'lobby') return false;
    if (!this.botSeats.has(seat)) return false;
    this.botSeats.delete(seat);
    this.rebuildPlayersAfterLeave(seat);
    this.broadcastLobby();
    return true;
  }

  clearBots() {
    for (const seat of [...this.botSeats]) this.removeBot(seat);
  }

  /** Reconcile the number of AI bots to `count` (lobby only). */
  setBotCount(count) {
    if (this.game.phase !== 'lobby') return;
    count = Math.max(0, Math.min(11, count | 0));
    const maxPlayers = this.gameInfo.max || 8;
    const humanSeats = this.game.players.length - this.botSeats.size;
    const cap = Math.max(0, maxPlayers - humanSeats);
    count = Math.min(count, cap);
    while (this.botSeats.size > count) this.removeBot(Math.max(...this.botSeats));
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
    while (this.botSeats.size < count) this.addBot('机器人' + labels[this.botSeats.size]);
  }

  isBotSeat(seat) {
    return this.botSeats.has(seat);
  }

  // ---- server-side LLM player seats ----
  // An LLM seat is a normal player seat with no transport. The server calls the
  // model with the seat's personalized view, then applies the returned action(s)
  // through the same execute() path as a human.
  get llmAvailable() {
    return !!this.llm && this.llm.available !== false && !!this.gameInfo.ai;
  }

  get llmModel() {
    return this.llm && this.llm.available !== false ? (this.llm.model || 'llm') : null;
  }

  addLlm(name) {
    if (!this.llm || this.llm.available === false || !this.gameInfo.ai) return null;
    if (this.game.phase !== 'lobby') return null;
    if (this.game.players.length >= (this.gameInfo.max || 8)) return null;
    const safeName = String(name || 'LLM').slice(0, 20);
    const seat = this.game.addPlayer(safeName);
    this.llmSeats.add(seat);
    this.chatBudget.set(seat, Infinity);
    this._llmLastKey = '';
    this.broadcastLobby();
    return seat;
  }

  removeLlm(seat) {
    if (this.game.phase !== 'lobby') return false;
    if (!this.llmSeats.has(seat)) return false;
    this.llmSeats.delete(seat);
    this.chatBudget.delete(seat);
    this._llmLastKey = '';
    this.rebuildPlayersAfterLeave(seat);
    this.broadcastLobby();
    return true;
  }

  clearLlm() {
    for (const seat of [...this.llmSeats]) this.removeLlm(seat);
  }

  /** Reconcile LLM seats (lobby only). The server's model is the only writer. */
  setLlmCount(count) {
    if (!this.llm || this.llm.available === false || this.game.phase !== 'lobby') return;
    count = Math.max(0, Math.min(11, count | 0));
    const maxPlayers = this.gameInfo.max || 8;
    const fixedPlayers = this.game.players.length - this.llmSeats.size;
    const cap = Math.max(0, maxPlayers - fixedPlayers);
    count = Math.min(count, cap);
    while (this.llmSeats.size > count) this.removeLlm(Math.max(...this.llmSeats));
    while (this.llmSeats.size < count) {
      const n = this.llmSeats.size + 1;
      if (this.addLlm(`LLM#${n}`) == null) break;
    }
    this._llmLastKey = '';
  }

  isLlmSeat(seat) {
    return this.llmSeats.has(seat);
  }

  seatKind(seat) {
    if (this.botSeats.has(seat)) return 'bot';
    if (this.llmSeats.has(seat)) return 'llm';
    return 'human';
  }

  seatDeviceId(seat) {
    for (const g of this.guests.values()) if (g.seat === seat) return g.deviceId || null;
    return null;
  }

  // The seat that must act right now (pending favors / roulette / volleys included).
  activeSeat() {
    const g = this.game;
    if (!g) return null;
    if (g.pendingShots && g.pendingShots.length) return g.pendingShots[0].seat;
    if (g.pendingRoulette) return g.pendingRoulette.seat;
    if (g.pendingDefuse) return g.pendingDefuse.seat;
    if (g.pendingFavor) return g.pendingFavor.target;
    if (g.pendingDesignate != null) return g.pendingDesignate;
    return g.current;
  }

  startLlmLoop() {
    if (!this.llm || this._llmTimer) return;
    const step = () => {
      this._llmTimer = setTimeout(step, 1200);
      void this._driveLlm();
    };
    this._llmTimer = setTimeout(step, 900);
  }

  stopLlmLoop() {
    if (this._llmTimer) clearTimeout(this._llmTimer);
    this._llmTimer = null;
  }

  _llmKey(g, seat) {
    return [
      this._actionSeq,
      g.phase,
      g.turn == null ? '' : g.turn,
      seat,
      g.current == null ? '' : g.current,
      (g.counts || []).join(','),
      g.pendingDefuse ? 1 : 0,
      g.pendingFavor ? 1 : 0,
      g.pendingRoulette ? 1 : 0,
      g.pendingShots && g.pendingShots.length ? g.pendingShots.length : 0,
      g.pendingDesignate == null ? '' : g.pendingDesignate,
    ].join('|');
  }

  /**
   * One asynchronous LLM decision. Never re-entrant; if the model fails or
   * returns an illegal batch, fall back to the game's deterministic AI so a
   * network hiccup can never freeze the room.
   */
  async _driveLlm() {
    if (!this.llm || this.llm.available === false || this._llmBusy) return;
    if (Date.now() < this._llmCooldownUntil) return;
    const g = this.game;
    if (!g || (g.phase !== 'playing' && g.phase !== 'bidding')) return;
    const seat = this.activeSeat();
    if (seat == null || !this.isLlmSeat(seat)) return;
    const key = this._llmKey(g, seat);
    if (key === this._llmLastKey) return;
    this._llmBusy = true;
    this._llmLastKey = key;
    try {
      const view = g.viewFor(seat);
      const raw = await this.llm.decide({
        gameKey: this.gameKey,
        game: g,
        seat,
        view,
        players: this.seats(),
        chat: this.chatLog.slice(-6),
        chatBudget: this.chatBudget.get(seat) ?? Infinity,
      });
      // A human may have changed the room while the model was thinking.
      if (this.game !== g || this._llmKey(g, seat) !== key) {
        this._llmLastKey = '';
        return;
      }
      const reply = raw && !Array.isArray(raw) && typeof raw === 'object' ? raw : null;
      const actions = Array.isArray(raw) ? raw : (reply && Array.isArray(reply.actions) ? reply.actions : (raw ? [raw] : []));
      const say = reply && typeof reply.say === 'string' ? reply.say.trim().slice(0, 120) : '';
      if (say) this._llmSpeak(this.game.players[seat] ? this.game.players[seat].name : 'LLM', say);
      let acted = false;
      let locked = false;
      for (const action of actions) {
        if (!action || typeof action !== 'object') continue;
        const result = this.execute(seat, { t: M.ACT, ...action });
        if (!result || result.ok !== true) break;
        acted = true;
        if (action.kind === 'gz_lock') locked = true;
      }
      // In guozhan a batch may stop on one rejected order; still lock so the
      // simultaneous turn can resolve instead of asking the model forever.
      if (this.gameKey === 'guozhan' && !locked && this.game === g && g.phase === 'playing' && this.activeSeat() === seat) {
        const lock = this.execute(seat, { t: M.ACT, kind: 'gz_lock' });
        if (lock && lock.ok) acted = true;
      }
      if (!acted) {
        this._llmLastKey = '';
        this._llmFailStreak += 1;
        this._llmCooldownUntil = Date.now() + Math.min(30000, 2000 * this._llmFailStreak);
        this._llmFallback(seat, 'empty/invalid decision');
      } else {
        this._llmFailStreak = 0;
        this._llmCooldownUntil = 0;
        this._log(`LLM seat ${seat} -> ${actions.map((a) => String(a && a.kind)).join('+')}`);
      }
    } catch (err) {
      this._llmFailStreak += 1;
      this._llmCooldownUntil = Date.now() + Math.min(60000, 3000 * this._llmFailStreak);
      this._log(`LLM seat ${seat} failed: ${err && err.message ? err.message : String(err)} — using heuristic fallback`);
      this._llmLastKey = '';
      this._llmFallback(seat, 'model error');
    } finally {
      this._llmBusy = false;
    }
  }

  _llmFallback(seat, reason) {
    const action = this.ai(seat);
    if (!action) {
      this._log(`LLM seat ${seat} fallback skipped (${reason})`);
      return;
    }
    const result = this.execute(seat, { t: M.ACT, kind: action.kind, ...action });
    this._log(`LLM seat ${seat} fallback -> ${action.kind} (${reason}) ${result && result.ok ? 'ok' : 'rejected'}`);
  }

  // ---- inbound handling ----
  handleGuestBytes(id, bytes) {
    const rec = this.guests.get(id);
    if (!rec) return;
    rec.idleUntil = Date.now() + this.idleTimeoutMs;
    for (const msg of rec.decoder.push(bytes)) this.handleGuestMessage(id, msg);
  }

  handleGuestMessage(id, msg) {
    const rec = this.guests.get(id);
    if (!rec) return;
    switch (msg.t) {
      case M.JOIN:
        this.doJoin(id, msg.name, msg.deviceId, msg.game);
        break;
      case M.ACT:
        if (rec.seat == null) break;
        this.execute(rec.seat, msg);
        break;
      case M.CHAT:
        this._handleChat(rec, msg);
        break;
      case M.BOT:
        if (rec.seat == null || rec.seat !== this.hostSeat) break; // owner only
        this.setBotCount(msg.count || 0);
        break;
      case M.LLM:
        if (rec.seat == null || rec.seat !== this.hostSeat) break; // owner only
        this.setLlmCount(msg.count || 0);
        break;
      case M.PING:
        // heart-beat: echo back so an idle tunnel/connection is kept alive and dead
        // clients are detected instead of silently going stale.
        this.sendToGuest(id, { t: SM.PING });
        break;
      default:
        break; // leave ignored or handled elsewhere
    }
  }

  doJoin(id, name, deviceId, game) {
    const rec = this.guests.get(id);
    if (!rec) return;
    // Bind the player to a device id and drop any stale connection from the SAME
    // device (any phase) so a lingering half-open connection can never leave a
    // phantom seat or block a new game/round.
    if (deviceId) {
      rec.deviceId = deviceId;
      for (const [oldId, gr] of this.guests) {
        if (oldId !== id && gr.deviceId === deviceId) this.disconnectGuest(oldId);
      }
    }
    // Roll an ended/aborted round back to a fresh lobby FIRST, so adoptGame below
    // sees an empty lobby and can adopt the new joiner's game (otherwise an
    // aborted game keeps its old game forever).
    if (this.game.phase === 'roundEnd' || this.game.phase === 'aborted') this.resetRound();
    // Respect the game the first joiner picked (empty room) so the app's choice
    // is used instead of always falling back to UNO.
    this.adoptGame(game);
    if (this.game.phase !== 'lobby') {
      // A game is mid-play: never leave the newcomer hanging — send a lobby so
      // the UI shows a real screen instead of an infinite spinner.
      this.sendToGuest(id, { t: SM.LOBBY, seats: this.seats(), you: null, hostSeat: this.hostSeat, game: this.gameKey, gameName: this.gameInfo.name, aiCount: this.botSeats.size, llmCount: this.llmSeats.size, llmSeats: [...this.llmSeats], llmAvailable: this.llmAvailable, llmModel: this.llmModel, note: 'game-in-progress' });
      return;
    }
    const safeName = String(name || `Player ${id}`).slice(0, 20);
    let seat;
    try {
      seat = this.game.addPlayer(safeName);
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      // A full room (e.g. guozhan is capped at 4) must reject the joiner
      // gracefully instead of throwing out of the socket message handler.
      this._log(`join rejected guest ${id}: ${err.code} ${err.message}`);
      this.sendToGuest(id, { t: SM.ERROR, code: err.code, message: err.message });
      return;
    }
    rec.name = safeName;
    rec.seat = seat;
    if (this.remote && this.ownerSeat == null) this.ownerSeat = seat;
    this._log(`player '${safeName}' joined seat ${seat} (guest ${id}, game '${this.gameKey}')`);
    this.broadcastLobby();
  }

  // ---- host-local actions ----
  getLocalView() {
    return this.game.viewFor(this.localSeat);
  }

  startGame() {
    if (this.game.phase !== 'lobby') return false;
    const ok = this.execute(this.localSeat, { t: M.ACT, kind: 'start' });
    return ok;
  }

  // Rebuild a fresh game from the players who are actually still here, so a seat
  // left behind by someone who disconnected mid-game ("ghost") never survives
  // into the next round.
  resetRound() {
    const keep = [];
    for (const [, g] of this.guests) if (g.seat != null) keep.push({ seat: g.seat, name: g.name });
    for (const s of this.botSeats) keep.push({ seat: s, name: this.game.players[s] ? this.game.players[s].name : 'AI' });
    for (const s of this.llmSeats) keep.push({ seat: s, name: this.game.players[s] ? this.game.players[s].name : 'LLM' });
    // keep the local (host-machine) player, whose seat is the localSeat
    const localSeat = this.localSeat;
    // Defensive dedup: if some other entity already occupies the same old seat
    // as localSeat (shouldn't happen normally), keep the host's entry only once
    // so the rebuilt game never gets a duplicate seat for the local player.
    if (localSeat != null && this.game.players[localSeat] && !keep.some((k) => k.seat === localSeat)) {
      keep.push({ seat: localSeat, name: this.game.players[localSeat].name });
    }
    keep.sort((a, b) => a.seat - b.seat);
    const names = keep.map((k) => k.name);
    this.game = getGame(this.gameKey).create({ playerNames: names, options: this.gameOpts, random: this.gameRandom });
    this._llmLastKey = '';
    for (const s of this.llmSeats) this.chatBudget.set(s, Infinity);
    // remap guest + bot + owner seats to the fresh compact seat indices
    const newSeat = new Map(keep.map((k, i) => [k.seat, i]));
    for (const [, g] of this.guests) if (g.seat != null) g.seat = newSeat.get(g.seat);
    this.botSeats = new Set([...this.botSeats].map((s) => newSeat.get(s)).filter((s) => s != null));
    this.llmSeats = new Set([...this.llmSeats].map((s) => newSeat.get(s)).filter((s) => s != null));
    if (this.ownerSeat != null && newSeat.has(this.ownerSeat)) this.ownerSeat = newSeat.get(this.ownerSeat);
    else this.ownerSeat = null;
    if (this.localSeat != null && newSeat.has(this.localSeat)) this.localSeat = newSeat.get(this.localSeat);
    this._log(`room reset -> game '${this.gameKey}' (${names.length} players)`);
    this.broadcastLobby();
  }

  /** Adopt the game the first joiner picked (room has no real players yet). */
  adoptGame(game) {
    if (this.game.phase !== 'lobby') return false;
    const key = game && GAMES[game] ? game : this.gameKey;
    if (key === this.gameKey) return false;
    // Only switch if no real (connected) player is still here. Stale bots from a
    // previous session are dropped so the room can be rebuilt fresh with the
    // newly chosen game.
    const realPlayers = [...this.guests.values()].some((g) => g.seat != null);
    if (realPlayers) return false;
    this.clearBots();
    this.clearLlm();
    this.gameKey = key;
    this.game = getGame(key).create({ playerNames: [], options: this.gameOpts, random: this.gameRandom });
    this._llmLastKey = '';
    this._log(`adopted game '${key}'`);
    return true;
  }

  // Compute an AI action for a local bot seat (game-specific).
  ai(seat) {
    const def = getGame(this.gameKey);
    if (!def.ai) return null;
    return def.ai(this.game, seat);
  }

  play(cardId, color) {
    return this.execute(this.localSeat, { t: M.ACT, kind: 'play', cardId, color });
  }
  draw() {
    return this.execute(this.localSeat, { t: M.ACT, kind: 'draw' });
  }
  pass() {
    return this.execute(this.localSeat, { t: M.ACT, kind: 'pass' });
  }
  uno() {
    return this.execute(this.localSeat, { t: M.ACT, kind: 'uno' });
  }

  // Generic game-agnostic action for the host's local player (seat 0).
  act(action) {
    return this.execute(this.localSeat, { t: M.ACT, ...action });
  }

  // ---- core dispatch: validate + apply + broadcast ----
  // Returns {ok:true} on success (state broadcast), or {ok:false, code, message}
  // on an illegal move, signaling only the acting party.
  execute(seat, act) {
    try {
      if (act && act.kind === 'start' && seat != null && seat !== this.hostSeat) {
        throw new GameError('NOT_OWNER', '只有房主能开始游戏');
      }
      // Allow the owner to start a fresh round after the last one ended/aborted.
      if (act && act.kind === 'start' && (this.game.phase === 'roundEnd' || this.game.phase === 'aborted')) {
        this.resetRound();
      }
      const beforePhase = this.game.phase;
      // 国战需要在开局知道哪些座位是宿主 AI，才能给它们分配原型；
      // 其他游戏忽略这个附加字段。
      const gameAct = act && act.kind === 'start' ? { ...act, aiSeats: [...this.botSeats] } : act;
      this.game.applyAction(seat, gameAct);
      // 记住房主选的剧本：房间重建（有人进房/重开一局）时沿用，不能悄悄回到默认图
      if (act && act.kind === 'start' && typeof act.scenario === 'string' && act.scenario) {
        this._lastScenario = act.scenario;
        this.gameOpts = { ...this.gameOpts, scenario: act.scenario };
      }
      const phase = this.game.phase;
      if ((beforePhase === 'lobby' || beforePhase === 'roundEnd' || beforePhase === 'aborted') && (phase === 'playing' || phase === 'bidding')) {
        this._matchStartedAt = Date.now();
        this._matchResultSent = false;
        this._matchId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      }
      this._actionSeq += 1;
      this.broadcastGame();
      if (!this._matchResultSent && this._matchStartedAt && phase === 'roundEnd' && beforePhase !== 'roundEnd') this._finishMatch();
      if (this.remote && this.botSeats.size > 0 && (this.game.phase === 'playing' || this.game.phase === 'bidding')) this.startBotLoop();
      return { ok: true };
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      this._log(`action rejected seat ${seat}: ${err.code} ${err.message}`);
      this.signalError(seat, err.code, err.message);
      return { ok: false, code: err.code, message: err.message };
    }
  }

  _finishMatch() {
    if (this._matchResultSent) return;
    this._matchResultSent = true;
    const startedAt = this._matchStartedAt || Date.now();
    const endedAt = Date.now();
    let result;
    try {
      result = scoreMatch({
        gameKey: this.gameKey,
        game: this.game,
        startedAt,
        endedAt,
        matchId: this._matchId || `m-${endedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        players: this.game.players.map((p, seat) => ({ seat, name: p.name, kind: this.seatKind(seat), deviceId: this.seatDeviceId(seat) })),
        mode: this.remote ? 'online' : 'local',
      });
    } catch (err) {
      this._log(`score calculation failed: ${err && err.message ? err.message : String(err)}`);
      return;
    }
    if (!result) return;
    this._matchStartedAt = 0;
    for (const p of result.players) {
      if (p.kind !== 'human') continue;
      const score = {
        matchId: result.matchId, game: result.game, gameName: result.gameName, mode: result.mode,
        seat: p.seat, name: p.name, outcome: p.outcome, points: p.points, detail: p.detail,
        endedAt: result.endedAt, durationSec: result.durationSec, playerCount: result.playerCount,
        humanCount: result.humanCount, winnerSeats: result.winnerSeats, winnerNames: result.winnerNames,
      };
      const msg = { t: SM.SCORE, score };
      if (p.seat === this.localSeat) {
        if (this.onLocalUpdate) this.onLocalUpdate(msg);
      } else {
        const gid = this.seatToGuest(p.seat);
        if (gid != null) this.sendToGuest(gid, msg);
      }
    }
    if (this.onMatchEnd) {
      try { this.onMatchEnd(result); } catch (err) { this._log(`onMatchEnd failed: ${err && err.message ? err.message : String(err)}`); }
    }
    this._log(`match scored ${result.game} ${result.matchId} (${result.playerCount}p, ${result.durationSec}s)`);
  }

  signalError(seat, code, message) {
    if (seat === this.localSeat) {
      if (this.onLocalUpdate) this.onLocalUpdate({ t: SM.ERROR, code, message });
    } else {
      const gid = this.seatToGuest(seat);
      if (gid != null) this.sendToGuest(gid, { t: SM.ERROR, code, message });
    }
  }

  seatToGuest(seat) {
    for (const [id, g] of this.guests) if (g.seat === seat) return id;
    return null;
  }

  // ---- broadcast helpers ----
  broadcastGame() {
    for (const [, g] of this.guests) {
      if (g.seat == null) continue;
      this.sendToGuest(g.id, { t: SM.STATE, view: this.game.viewFor(g.seat), last: this.game.last, game: this.gameKey, gameName: this.gameInfo.name });
    }
    if (this.onLocalUpdate && this.localSeat != null) {
      this.onLocalUpdate({ t: SM.STATE, view: this.game.viewFor(this.localSeat), last: this.game.last, game: this.gameKey, gameName: this.gameInfo.name });
    }
  }

  broadcastLobby() {
    const seats = this.seats();
    const hostSeat = this.hostSeat;
    const aiCount = this.botSeats.size;
    const idleTimeout = this.idleTimeoutMs;
    const llmCount = this.llmSeats.size;
    const llmSeats = [...this.llmSeats].sort((a, b) => a - b);
    const llmAvailable = this.llmAvailable;
    const llmModel = this.llmModel;
    for (const [, g] of this.guests) {
      if (g.seat == null) continue;
      this.sendToGuest(g.id, { t: SM.LOBBY, seats, you: g.seat, hostSeat, game: this.gameKey, gameName: this.gameInfo.name, aiCount, idleTimeout, llmCount, llmSeats, llmAvailable, llmModel });
    }
    if (this.onLocalUpdate && this.localSeat != null) {
      this.onLocalUpdate({ t: SM.LOBBY, seats, you: this.localSeat, hostSeat, game: this.gameKey, gameName: this.gameInfo.name, aiCount, idleTimeout, llmCount, llmSeats, llmAvailable, llmModel });
    }
  }

  // Reap guests whose connection is dead/hung (no message for idleTimeoutMs).
  _reapIdle() {
    const now = Date.now();
    for (const [id, g] of this.guests) {
      if (g.idleUntil && now > g.idleUntil) this.disconnectGuest(id);
    }
  }

  broadcastChat(from, text) {
    this.chatLog.push({ from: String(from || '?'), text: String(text || '') });
    if (this.chatLog.length > 24) this.chatLog.shift();
    for (const [, g] of this.guests) {
      if (g.seat == null) continue;
      this.sendToGuest(g.id, { t: SM.CHAT, from, text });
    }
    if (this.onLocalUpdate && this.localSeat != null) this.onLocalUpdate({ t: SM.CHAT, from, text });
  }

  /**
   * 聊天分流：公共频道限频（每人 1.5 秒一条），私聊不限频且只投递给目标。
   * 私聊内容不进公共 chatLog，避免被其他人的 LLM 席位看到。
   */
  _handleChat(rec, msg) {
    const text = String(msg.text || '').trim().slice(0, 200);
    if (!text) return;
    const to = Number.isInteger(msg.to) ? msg.to : null;
    if (to == null) {
      const now = Date.now();
      if (rec.lastPublicChatAt && now - rec.lastPublicChatAt < PUBLIC_CHAT_GAP_MS) return;
      rec.lastPublicChatAt = now;
      this.broadcastChat(rec.name, text);
      this._scheduleLlmChatReply();
      return;
    }
    if (rec.seat == null) return;
    this._deliverPrivate(rec.seat, rec.name, to, text);
  }

  _deliverPrivate(fromSeat, fromName, toSeat, text) {
    if (!Number.isInteger(toSeat) || toSeat < 0 || toSeat >= this.game.players.length) return;
    if (fromSeat === toSeat) return;
    const msg = { t: SM.CHAT, from: fromName, text, to: toSeat };
    for (const [, g] of this.guests) {
      if (g.seat === toSeat || g.seat === fromSeat) this.sendToGuest(g.id, msg);
    }
    if (this.onLocalUpdate && this.localSeat != null && (this.localSeat === toSeat || this.localSeat === fromSeat)) {
      this.onLocalUpdate(msg);
    }
    // 私聊发给 LLM 席位：立刻回，且不套公共频道的 20 秒闸
    if (this.isLlmSeat(toSeat)) this._llmPrivateReply(fromSeat, fromName, text);
  }

  /** 私聊回复：只防连发（1.2 秒），不占公共发言冷却。 */
  _llmPrivateReply(fromSeat, fromName, text) {
    if (!this.llm || this.llm.available === false || typeof this.llm.talk !== 'function') return null;
    if (!Number.isInteger(fromSeat)) return null;
    const seat = [...this.llmSeats][0];
    if (seat == null) return null;
    const now = Date.now();
    if (now < (this._llmPrivateCooldownUntil || 0)) return null;
    this._llmPrivateCooldownUntil = now + LLM_PRIVATE_REPLY_GAP_MS;
    const name = this.game.players[seat] ? this.game.players[seat].name : 'LLM';
    this._llmChatTask = (async () => {
      try {
        const raw = await this.llm.talk({
          gameKey: this.gameKey,
          gameName: this.gameInfo ? this.gameInfo.name : this.gameKey,
          seat,
          seatName: name,
          chat: [{ from: fromName, text }],
          direct: true,
        });
        const line = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        if (line) this._deliverPrivate(seat, name, fromSeat, line);
      } catch (err) {
        this._llmPrivateCooldownUntil = Date.now() + 15000;
        this._log(`llm private reply failed: ${err && err.message ? err.message : String(err)}`);
      }
    })();
    return this._llmChatTask;
  }

  /**
   * LLM 说话的唯一出口：不限每局次数，但两次之间至少隔 LLM_SPEAK_GAP_MS，
   * 避免"每回合都点评"刷屏。
   */
  _llmSpeak(name, text) {
    const now = Date.now();
    if (now - this._llmLastSpokeAt < LLM_SPEAK_GAP_MS) return false;
    this._llmLastSpokeAt = now;
    this.broadcastChat(name, text);
    return true;
  }

  /**
   * 人类发言后，让 LLM 席位回一句（不用等它轮到自己）。
   * 发言每局不限（budget=Infinity），只用 3.5 秒冷却和失败退避节流。
   */
  _scheduleLlmChatReply() {
    if (!this.llm || this.llm.available === false || typeof this.llm.talk !== 'function') return null;
    if (this.llmSeats.size === 0) return null;
    const now = Date.now();
    if (now < this._llmChatCooldownUntil) return null;
    const seat = [...this.llmSeats][0];
    const budget = this.chatBudget.get(seat) ?? Infinity;
    if (budget <= 0) return null;
    this._llmChatCooldownUntil = now + LLM_CHAT_REPLY_GAP_MS;
    this.chatBudget.set(seat, budget - 1);
    const name = this.game && this.game.players[seat] ? this.game.players[seat].name : 'LLM';
    const ctx = {
      gameKey: this.gameKey,
      gameName: this.gameInfo ? this.gameInfo.name : this.gameKey,
      seat,
      seatName: name,
      chat: this.chatLog.slice(-6),
    };
    this._llmChatTask = (async () => {
      try {
        const raw = await this.llm.talk(ctx);
        const line = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        if (line) this._llmSpeak(name, line);
      } catch (err) {
        // 模型失败就静默跳过；把冷却拉长一点，别每句话都去撞墙
        this._llmChatCooldownUntil = Date.now() + 15000;
        this._log(`llm chat reply failed: ${err && err.message ? err.message : String(err)}`);
      }
    })();
    return this._llmChatTask;
  }

  sendToGuest(id, msg) {
    const g = this.guests.get(id);
    if (g) g.transport.send(encodeMessage(msg));
  }

  // ---- disconnect handling ----
  disconnectGuest(id) {
    const rec = this.guests.get(id);
    if (!rec) return;
    this._log(`guest ${id} disconnected${rec.seat != null ? ` (seat ${rec.seat})` : ''}`);
    this.guests.delete(id);
    if (rec.seat == null) return; // never joined; nothing to fix

    if (this.game.phase === 'lobby') {
      // drop the seat and renumber is tricky; simplest is to leave the seat and
      // just mark it. For MVP we rebuild players from remaining seats.
      this.rebuildPlayersAfterLeave(rec.seat);
      this.broadcastLobby();
    } else {
      // A player left mid-game: call the round off cleanly.
      this.game.phase = 'aborted';
      this.broadcastGame();
    }
  }

  rebuildPlayersAfterLeave(seat) {
    const kept = this.game.players.filter((_, i) => i !== seat);
    this.game.players = kept.map((p, i) => ({ ...p, id: i }));
    // remap guest seats (check == before decrement so a guest at seat+1 that shifts
    // down into the vacated seat is never wrongly nulled)
    for (const [, g] of this.guests) {
      if (g.seat === seat) g.seat = null;
      else if (g.seat > seat) g.seat -= 1;
    }
    // remap bot seats
    const remapped = new Set();
    for (const s of this.botSeats) {
      if (s === seat) continue;
      remapped.add(s > seat ? s - 1 : s);
    }
    this.botSeats = remapped;
    // remap LLM seats
    const llmRemapped = new Set();
    for (const s of this.llmSeats) {
      if (s === seat) continue;
      llmRemapped.add(s > seat ? s - 1 : s);
    }
    this.llmSeats = llmRemapped;
    // If the on-device host was the one who left, drop the local seat.
    if (this.localSeat != null && this.localSeat === seat) this.localSeat = null;
    // Remap the room owner; if the owner left, hand the room to the first
    // remaining connected guest so a fresh owner is always pickable.
    if (this.ownerSeat != null) {
      if (this.ownerSeat === seat) {
        const remaining = [...this.guests.values()].filter((g) => g.seat != null).map((g) => g.seat).sort((a, b) => a - b);
        this.ownerSeat = remaining.length ? remaining[0] : null;
      } else if (this.ownerSeat > seat) {
        this.ownerSeat -= 1;
      }
    }
  }

  // ---- server-side bot driver (remote rooms only) ----
  startBotLoop() {
    if (this._botTimer) return;
    const step = () => {
      this._botTimer = setTimeout(step, 800);
      this._driveBots();
    };
    this._botTimer = setTimeout(step, 800);
  }

  _driveBots() {
    // 兜底总闸：AI 决策或执行抛出任何非 GameError 异常时，绝不让定时器链断掉、对局冻结。
    try {
      this._driveBotsInner();
    } catch (err) {
      this._log(`bot driver error: ${err && err.message ? err.message : String(err)}`);
    }
  }

  /** 机器人决策：AI 抛错就降级成保守动作（pass/draw/lock），并留痕。 */
  botActionSafe(seat) {
    try {
      return this.ai(seat);
    } catch (err) {
      this._log(`bot seat ${seat} ai error: ${err && err.message ? err.message : String(err)} → fallback`);
      return this._botFallback(this.game);
    }
  }

  _driveBotsInner() {
    const g = this.game;
    if (!g || (g.phase !== 'playing' && g.phase !== 'bidding')) return;
    // a bot must resolve a pending action first (roulette fire / favor give / defuse)
    if (g.pendingRoulette && this.isBotSeat(g.pendingRoulette.seat)) { this.execute(g.pendingRoulette.seat, { t: M.ACT, kind: 'fire' }); return; }
    if (g.pendingFavor && this.isBotSeat(g.pendingFavor.target)) { const a = this.botActionSafe(g.pendingFavor.target); if (a) this.execute(g.pendingFavor.target, { t: M.ACT, kind: a.kind, ...a }); return; }
    if (g.pendingDefuse && this.isBotSeat(g.pendingDefuse.seat)) { const a = this.botActionSafe(g.pendingDefuse.seat); if (a) this.execute(g.pendingDefuse.seat, { t: M.ACT, kind: a.kind, ...a }); return; }
    const seat = g.current;
    if (seat == null || !this.isBotSeat(seat)) return;
    const before = this._botKey(g);
    const a = this.botActionSafe(seat);
    if (a) {
      this.execute(seat, { t: M.ACT, kind: a.kind, ...a });
      this._log(`bot seat ${seat} -> ${a.kind}`);
      this._botStall.count = (this._botKey(g) === before) ? this._botStall.count + 1 : 0;
      if (this._botStall.count > 4) { this.execute(seat, { t: M.ACT, ...this._botFallback(g) }); this._botStall.count = 0; }
    }
  }

  _botKey(g) {
    return g.phase + '|' + (g.current == null ? '' : g.current) + '|' +
      ((g.counts || []).join(',')) + '|' + (g.pendingDefuse ? 1 : 0) + (g.pendingFavor ? 1 : 0) + (g.pendingRoulette ? 1 : 0);
  }

  _botFallback(g) {
    if (this.gameKey === 'guozhan') return { kind: 'gz_lock' };
    if (this.gameKey === 'uno' || this.gameKey === 'exploding') return { kind: 'draw' };
    if (this.gameKey === 'doudizhu') return { kind: 'pass' };
    return { kind: 'call' };
  }

  // ---- 对局存档 / 恢复（引擎无关，详见 save-state.js） ----
  // ⚠️ 安全边界：返回值含所有玩家的手牌 / 身份 / 牌堆顺序，属「上帝视角」数据，
  //    只能写进本地存储；绝不上送服务端、绝不进 chatLog / onLog / 任何日志。
  // captureSave() 返回可直接 JSON.stringify 的纯数据快照；引擎状态无法通用序列化时
  // 抛 GameError（code='SAVE_UNSUPPORTED'，例如国战的 session 类实例），调用方捕获后
  // 跳过存档即可，不要吞掉后写一份空档。
  captureSave() {
    return captureRoom(this);
  }

  // restoreSave(payload) 把快照灌回**当前这个** Host（同 gameKey 的已存在实例）。
  // 校验（版本 / gameKey / 结构 / 座位越界 / 纯数据）全部通过后才落地，
  // 失败一定抛 GameError 且 Host 保持原状，不存在半恢复；
  // payload 里任何令牌样字段（token 等）都不会被写进 Host 或引擎。
  // 返回 {ok:true, gameKey, phase, seats, playerNames, capturedAt}。
  // 恢复不会重建 guests/传输、也不会启动 bot / llm / idle 定时器；UI 需要刷新时
  // 调用方自己再调一次 broadcastGame()。
  restoreSave(payload) {
    return restoreRoom(this, payload);
  }
}
