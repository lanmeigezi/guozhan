// guozhan.js — uno-bt adapter for the guozhan deterministic war game.
//
// The heavy lifting lives in ./guozhan/engine.bundle.js (generated from
// D:\酒馆游戏 without any LLM/network layer). This file only adapts the
// generic Game interface used by Host:
//   addPlayer(name) / applyAction(seat, action) / snapshot() / viewFor(seat)
//
// Turn model: simultaneous orders. Players queue legal action ids, press
// "lock", and the engine resolves every faction at once. Unclaimed factions
// (when fewer than 12 seats are used) are driven by the heuristic AI inside the
// bundle. Bot seats added by Host are driven through aiGuozhan() below.

import { GameError } from './game-error.js';
import { GuozhanSession, SCENARIOS, scenarioById } from './guozhan/engine.bundle.js';

export const GZ_SCENARIOS = SCENARIOS;

const DEFAULT_SCENARIO = 'random-front-v2';
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;

function wrap(err) {
  if (err instanceof GameError) throw err;
  if (err && typeof err.code === 'string' && typeof err.message === 'string') {
    throw new GameError(err.code, err.message);
  }
  throw err;
}

function makeSeed() {
  return 'gz-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class GuozhanGame {
  constructor({ playerNames = [], options = {} } = {}) {
    this.players = playerNames.map((name, i) => ({ id: i, name }));
    this.options = options || {};
    this.scenarioId = scenarioById(this.options.scenario) ? this.options.scenario : DEFAULT_SCENARIO;
    this.seed = typeof this.options.seed === 'string' ? this.options.seed : '';
    this.session = null;
    this.phase = 'lobby'; // 'lobby' | 'playing' | 'roundEnd'
    this.current = 0;
    this.winner = null;
    this.last = null;
    // Only Host's ai() path receives this; a human cannot forge a bot batch.
    this.botToken = 'bot_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.minPlayers = MIN_PLAYERS;
    this.maxPlayers = MAX_PLAYERS;
  }

  get n() {
    return this.players.length;
  }

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '对局已经开始');
    if (this.players.length >= this.maxPlayers) {
      throw new GameError('ROOM_FULL', `国战最多 ${this.maxPlayers} 名玩家（其余势力由 AI 接管）`);
    }
    this.players.push({ id: this.players.length, name: String(name || '玩家').slice(0, 20) });
    return this.players.length - 1;
  }

  /** Host's bot-loop key uses counts; keep it as "queued orders per seat". */
  get counts() {
    if (!this.session) return this.players.map(() => 0);
    const bindings = this.session.bindingsList();
    return this.players.map((_, seat) => {
      const b = bindings.find((x) => x.seat === seat);
      return b ? this.session.ordersFor(b.factionId).length : 0;
    });
  }

  start(action = {}) {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '对局已经开始');
    if (this.players.length < MIN_PLAYERS) {
      throw new GameError('NOT_ENOUGH', `国战至少需要 ${MIN_PLAYERS} 名玩家`);
    }
    const scenarioId = scenarioById(action.scenario) ? action.scenario : this.scenarioId;
    const seed = String(action.seed || this.seed || makeSeed()).trim().slice(0, 64) || makeSeed();
    try {
      const unlimitedTurns = action.unlimitedTurns === true || action.maxTurns === 0;
      const session = new GuozhanSession({ scenarioId, rootSeed: seed, ...(unlimitedTurns ? { maxTurns: 0 } : {}) });
      const aiSeats = new Set(Array.isArray(action.aiSeats) ? action.aiSeats.map(Number) : []);
      session.start(this.players.map((p, seat) => ({
        seat, name: p.name, ...(aiSeats.has(seat) ? { isAi: true } : {}),
      })));
      this.session = session;
      this.scenarioId = scenarioId;
      this.seed = seed;
      this.phase = 'playing';
      this.winner = null;
      this.last = {
        kind: 'start',
        turn: session.turn,
        scenario: session.scenario.name,
        scenarioId,
        seed,
      };
      this._refresh();
    } catch (err) {
      wrap(err);
    }
    return this.snapshot();
  }

  applyAction(seat, action) {
    const act = action || {};
    if (act.kind === 'start') {
      this.start(act);
      return this.snapshot();
    }
    if (!this.session) throw new GameError('NOT_PLAYING', '对局尚未开始');
    if (this.phase === 'roundEnd') throw new GameError('MATCH_FINISHED', '对局已结束');
    const binding = this.session.bindingsList().find((b) => b.seat === seat);
    if (!binding) throw new GameError('NOT_YOUR_TURN', '该座位没有对应势力');
    const fid = binding.factionId;
    try {
      switch (act.kind) {
        case 'gz_order': {
          this.session.submitAction(fid, String(act.actionId || ''));
          break;
        }
        case 'gz_clear': {
          this.session.clearOrders(fid);
          break;
        }
        case 'gz_lock': {
          if (this.session.lock(fid).resolved) this._afterResolve();
          break;
        }
        case 'gz_bot': {
          if (act.token !== this.botToken) throw new GameError('NOT_AUTHORIZED', '机器人指令来源不合法');
          if (this.session.applyBotCommands(fid, Array.isArray(act.commands) ? act.commands : []).resolved) {
            this._afterResolve();
          }
          break;
        }
        default:
          throw new GameError('UNKNOWN_ACT', '未知国战操作');
      }
      this._refresh();
    } catch (err) {
      wrap(err);
    }
    return this.snapshot();
  }

  _afterResolve() {
    this.last = this.session.reportData;
    this._refresh();
  }

  _refresh() {
    if (!this.session) return;
    this.phase = this.session.endedAt ? 'roundEnd' : 'playing';
    this.current = this.session.nextSeat();
    this.winner = this.session.winnerSeat;
  }

  snapshot() {
    if (!this.session) {
      return {
        phase: this.phase,
        current: this.current,
        winner: null,
        players: this.players.map((p) => ({ id: p.id, name: p.name })),
        counts: this.players.map(() => 0),
      };
    }
    return {
      phase: this.phase,
      current: this.current,
      winner: this.winner,
      turn: this.session.turn,
      maxTurns: this.session.maxTurns,
      scenario: this.session.scenario.id,
      seed: this.seed,
      players: this.players.map((p) => ({ id: p.id, name: p.name })),
      counts: this.counts,
    };
  }

  viewFor(seat) {
    if (!this.session) throw new GameError('NOT_PLAYING', '对局尚未开始');
    const binding = this.session.bindingsList().find((b) => b.seat === seat);
    if (!binding) throw new GameError('NOT_YOUR_TURN', '该座位没有对应势力');
    try {
      return this.session.viewFor(seat, binding.factionId);
    } catch (err) {
      wrap(err);
    }
  }
}

/** Host AI hook: produce and lock one bot seat's orders in a single action. */
export function aiGuozhan(game, seat) {
  if (!game || !game.session || game.phase !== 'playing') return null;
  const binding = game.session.bindingsList().find((b) => b.seat === seat);
  if (!binding) return null;
  const action = game.session.aiAction(binding.factionId);
  if (!action) return null;
  return { ...action, token: game.botToken };
}
