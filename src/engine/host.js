// host.js — the authoritative room. The host owns ONE game instance (any game
// from the registry) and is the single authority: it validates every action
// (its own and each guest's), applies it, and broadcasts a personalized state
// view to every player. This makes it impossible to cheat or desync.

import { GameError } from './game-error.js';
import { GAMES, getGame } from './games.js';
import { FrameDecoder, encodeMessage, M, SM } from './protocol.js';

export class Host {
  constructor({ game = 'uno', playerName = null, options = {}, random, remote = false } = {}) {
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
    this.onLocalUpdate = null; // fn(payload) for the host UI
    this.onChat = null; // fn({from, text}) for chat (host includes itself)
    this.onLog = null; // fn(line) server-side logging hook
    this._botTimer = null; // server-side bot-drive timer (remote mode)
    this._botStall = { key: '', count: 0 };
    // Idle timeout: free guests whose connection is dead/hung (no messages for a
    // while). Active players are kept alive by the client's heartbeat ping, so
    // this only reclaims truly-abandoned connections and frees server resources.
    this.idleTimeoutMs = remote ? 3 * 60 * 1000 : 0;
    this._idleTimer = remote ? setInterval(() => this._reapIdle(), 20000) : null;
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
    count = Math.max(0, Math.min(7, count | 0));
    while (this.botSeats.size > count) this.removeBot(Math.max(...this.botSeats));
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    while (this.botSeats.size < count) this.addBot('机器人' + labels[this.botSeats.size]);
  }

  isBotSeat(seat) {
    return this.botSeats.has(seat);
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
        this.broadcastChat(rec.name, msg.text);
        break;
      case M.BOT:
        if (rec.seat == null || rec.seat !== this.hostSeat) break; // owner only
        this.setBotCount(msg.count || 0);
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
      this.sendToGuest(id, { t: SM.LOBBY, seats: this.seats(), you: null, hostSeat: this.hostSeat, game: this.gameKey, gameName: this.gameInfo.name, aiCount: this.botSeats.size, note: 'game-in-progress' });
      return;
    }
    const safeName = String(name || `Player ${id}`).slice(0, 20);
    const seat = this.game.addPlayer(safeName);
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
    // remap guest + bot + owner seats to the fresh compact seat indices
    const newSeat = new Map(keep.map((k, i) => [k.seat, i]));
    for (const [, g] of this.guests) if (g.seat != null) g.seat = newSeat.get(g.seat);
    this.botSeats = new Set([...this.botSeats].map((s) => newSeat.get(s)));
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
    this.gameKey = key;
    this.game = getGame(key).create({ playerNames: [], options: this.gameOpts, random: this.gameRandom });
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
      this.game.applyAction(seat, act);
      this.broadcastGame();
      if (this.remote && this.botSeats.size > 0 && (this.game.phase === 'playing' || this.game.phase === 'bidding')) this.startBotLoop();
      return { ok: true };
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      this._log(`action rejected seat ${seat}: ${err.code} ${err.message}`);
      this.signalError(seat, err.code, err.message);
      return { ok: false, code: err.code, message: err.message };
    }
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
    for (const [, g] of this.guests) {
      if (g.seat == null) continue;
      this.sendToGuest(g.id, { t: SM.LOBBY, seats, you: g.seat, hostSeat, game: this.gameKey, gameName: this.gameInfo.name, aiCount, idleTimeout });
    }
    if (this.onLocalUpdate && this.localSeat != null) {
      this.onLocalUpdate({ t: SM.LOBBY, seats, you: this.localSeat, hostSeat, game: this.gameKey, gameName: this.gameInfo.name, aiCount, idleTimeout });
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
    for (const [, g] of this.guests) {
      if (g.seat == null) continue;
      this.sendToGuest(g.id, { t: SM.CHAT, from, text });
    }
    if (this.onLocalUpdate && this.localSeat != null) this.onLocalUpdate({ t: SM.CHAT, from, text });
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
    const g = this.game;
    if (!g || (g.phase !== 'playing' && g.phase !== 'bidding')) return;
    // a bot must resolve a pending action first (roulette fire / favor give / defuse)
    if (g.pendingRoulette && this.isBotSeat(g.pendingRoulette.seat)) { this.execute(g.pendingRoulette.seat, { t: M.ACT, kind: 'fire' }); return; }
    if (g.pendingFavor && this.isBotSeat(g.pendingFavor.target)) { const a = this.ai(g.pendingFavor.target); if (a) this.execute(g.pendingFavor.target, { t: M.ACT, kind: a.kind, ...a }); return; }
    if (g.pendingDefuse && this.isBotSeat(g.pendingDefuse.seat)) { const a = this.ai(g.pendingDefuse.seat); if (a) this.execute(g.pendingDefuse.seat, { t: M.ACT, kind: a.kind, ...a }); return; }
    const seat = g.current;
    if (seat == null || !this.isBotSeat(seat)) return;
    const before = this._botKey(g);
    const a = this.ai(seat);
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
    if (this.gameKey === 'uno' || this.gameKey === 'exploding') return { kind: 'draw' };
    if (this.gameKey === 'doudizhu') return { kind: 'pass' };
    return { kind: 'call' };
  }
}
