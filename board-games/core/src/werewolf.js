// werewolf.js — 6–8 人狼人杀（简化但完整：狼人/预言家/女巫/平民，夜间行动、公开发言、投票）。
// 私密视图由 viewFor(seat) 决定：村民看不到别人身份，预言家有自己的验人记录，女巫能看到今晚刀口。

import { GameError } from './game-error.js';

const ROLE_NAME = { wolf: '狼人', seer: '预言家', witch: '女巫', villager: '平民' };
const ROLE_DESC = {
  wolf: '每晚与狼队友共同猎杀一名玩家；白天伪装成好人。',
  seer: '每晚查验一名玩家的身份；白天用发言带领好人。',
  witch: '有一瓶解药和一瓶毒药；夜晚可救被刀者或毒杀一人。',
  villager: '没有夜间技能；白天通过发言和投票找出狼人。',
};

function shuffle(rng, items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class WerewolfGame {
  constructor({ playerNames = [], options = {}, random } = {}) {
    this.random = random || Math.random;
    this.players = playerNames.map((name, i) => ({
      id: i, name: String(name || `玩家${i}`).slice(0, 20), role: null, alive: true,
    }));
    this.phase = 'lobby';
    this.stage = 'lobby'; // night | day_speech | day_vote | roundEnd
    this.current = 0;
    this.nightCount = 0;
    this.dayCount = 0;
    this.winner = null;
    this.winnerTeam = null;
    this.endReason = null;
    this.last = null;
    this.log = [];
    this.speeches = [];
    this.seerKnowledge = {};
    this.witchSaveUsed = false;
    this.witchPoisonUsed = false;
    this.wolfVotes = {};
    this.votes = {};
    this.victim = null;
    this.witchSaved = false;
    this.witchPoison = null;
    this.nightQueue = [];
    this.nightIndex = 0;
    this.nightStage = null;
    this.dayQueue = [];
    this.dayIndex = 0;
  }

  get n() { return this.players.length; }

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '游戏已开始');
    if (this.n >= 8) throw new GameError('ROOM_FULL', '狼人杀最多 8 人');
    this.players.push({ id: this.players.length, name: String(name || '玩家').slice(0, 20), role: null, alive: true });
    return this.players.length - 1;
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '游戏已开始');
    if (this.n < 6) throw new GameError('NOT_ENOUGH', '狼人杀至少 6 人');
    if (this.n > 8) throw new GameError('TOO_MANY', '狼人杀最多 8 人');
    const wolfCount = this.n >= 8 ? 3 : 2;
    const roles = [
      ...Array.from({ length: wolfCount }, () => 'wolf'),
      'seer', 'witch',
      ...Array.from({ length: this.n - wolfCount - 2 }, () => 'villager'),
    ];
    const mixed = shuffle(this.random, roles);
    this.players.forEach((p, i) => { p.role = mixed[i]; p.alive = true; });
    this.phase = 'playing';
    this.stage = 'night';
    this.current = 0;
    this.nightCount = 1;
    this.dayCount = 0;
    this.winner = null;
    this.winnerTeam = null;
    this.endReason = null;
    this.log = [];
    this.speeches = [];
    this.seerKnowledge = {};
    this.witchSaveUsed = false;
    this.witchPoisonUsed = false;
    this.pushLog(`游戏开始：${this.n} 人（${wolfCount} 狼人 / 预言家 / 女巫 / ${this.n - wolfCount - 2} 平民）`);
    this.startNight();
    return this.snapshot();
  }

  applyAction(seat, action) {
    const act = action || {};
    switch (act.kind) {
      case 'start': return this.start();
      case 'kill': return this.kill(seat, Number(act.targetSeat));
      case 'inspect': return this.inspect(seat, Number(act.targetSeat));
      case 'witch': return this.witch(seat, String(act.action || ''), act.targetSeat == null ? null : Number(act.targetSeat));
      case 'say': return this.say(seat, String(act.text || ''));
      case 'pass': return this.pass(seat);
      case 'vote': return this.vote(seat, act.targetSeat == null ? null : Number(act.targetSeat));
      case 'abstain': return this.vote(seat, null);
      default: throw new GameError('UNKNOWN_ACT', '未知狼人杀操作');
    }
  }

  aliveSeats() { return this.players.filter((p) => p.alive).map((p) => p.id).sort((a, b) => a - b); }
  wolfSeats() { return this.players.filter((p) => p.alive && p.role === 'wolf').map((p) => p.id).sort((a, b) => a - b); }
  assertTurn(seat) {
    if (this.phase !== 'playing') throw new GameError('NOT_PLAYING', '对局未开始或已结束');
    if (!this.players[seat]?.alive) throw new GameError('ELIMINATED', '你已出局');
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你');
  }

  startNight() {
    if (this.phase !== 'playing') return;
    this.stage = 'night';
    this.nightStage = null;
    this.nightQueue = [...this.wolfSeats()];
    const seer = this.players.find((p) => p.alive && p.role === 'seer');
    const witch = this.players.find((p) => p.alive && p.role === 'witch');
    if (seer) this.nightQueue.push(seer.id);
    if (witch) this.nightQueue.push(witch.id);
    this.nightIndex = 0;
    this.wolfVotes = {};
    this.votes = {};
    this.victim = null;
    this.witchSaved = false;
    this.witchPoison = null;
    this.pushLog(`第 ${this.nightCount} 夜，天黑请闭眼`);
    this.advanceNight();
  }

  advanceNight() {
    while (this.nightIndex < this.nightQueue.length) {
      const seat = this.nightQueue[this.nightIndex];
      const p = this.players[seat];
      if (!p || !p.alive) { this.nightIndex += 1; continue; }
      this.current = seat;
      this.nightStage = p.role === 'wolf' ? 'wolf' : p.role === 'seer' ? 'seer' : 'witch';
      if (this.nightStage === 'witch' && this.victim === null) this.computeVictim();
      this.last = { kind: 'night', stage: this.nightStage, seat };
      return;
    }
    this.resolveNight();
  }

  computeVictim() {
    const counts = {};
    for (const target of Object.values(this.wolfVotes)) counts[target] = (counts[target] || 0) + 1;
    const entries = Object.entries(counts).map(([seat, n]) => ({ seat: Number(seat), n }));
    if (entries.length === 0) { this.victim = null; return; }
    entries.sort((a, b) => b.n - a.n || a.seat - b.seat);
    const best = entries[0];
    const tied = entries.filter((x) => x.n === best.n).length > 1;
    this.victim = tied ? null : best.seat;
  }

  kill(seat, targetSeat) {
    this.assertTurn(seat);
    if (this.stage !== 'night' || this.players[seat].role !== 'wolf') throw new GameError('NOT_WOLF', '现在不是狼人行动');
    if (!Number.isInteger(targetSeat)) throw new GameError('NO_TARGET', '请选择猎杀目标');
    const target = this.players[targetSeat];
    if (!target || !target.alive || target.role === 'wolf') throw new GameError('BAD_TARGET', '不能猎杀该目标');
    this.wolfVotes[seat] = targetSeat;
    this.nightIndex += 1;
    this.last = { kind: 'kill', seat };
    this.advanceNight();
    return this.snapshot();
  }

  inspect(seat, targetSeat) {
    this.assertTurn(seat);
    if (this.stage !== 'night' || this.players[seat].role !== 'seer') throw new GameError('NOT_SEER', '现在不是预言家行动');
    const target = this.players[targetSeat];
    if (!target || !target.alive || targetSeat === seat) throw new GameError('BAD_TARGET', '请选择其他存活玩家');
    this.seerKnowledge[targetSeat] = target.role;
    this.nightIndex += 1;
    this.last = { kind: 'inspect', seat, targetSeat };
    this.advanceNight();
    return this.snapshot();
  }

  witch(seat, action, targetSeat) {
    this.assertTurn(seat);
    if (this.stage !== 'night' || this.players[seat].role !== 'witch') throw new GameError('NOT_WITCH', '现在不是女巫行动');
    if (action === 'save') {
      if (this.witchSaveUsed || this.victim === null) throw new GameError('WITCH_USED', '解药不可用');
      this.witchSaveUsed = true;
      this.witchSaved = true;
    } else if (action === 'poison') {
      if (this.witchPoisonUsed) throw new GameError('WITCH_USED', '毒药已用过');
      const target = this.players[targetSeat];
      if (!target || !target.alive || targetSeat === seat) throw new GameError('BAD_TARGET', '请选择其他存活玩家');
      this.witchPoisonUsed = true;
      this.witchPoison = targetSeat;
    } else if (action !== 'none') {
      throw new GameError('BAD_ACTION', '女巫只能 save / poison / none');
    }
    this.nightIndex += 1;
    this.last = { kind: 'witch', seat, action };
    this.advanceNight();
    return this.snapshot();
  }

  resolveNight() {
    if (this.victim === null) this.computeVictim();
    const deaths = new Set();
    if (this.victim !== null && !this.witchSaved) deaths.add(this.victim);
    if (this.witchPoison !== null) deaths.add(this.witchPoison);
    this.pushLog(`第 ${this.nightCount} 天，天亮`);
    if (deaths.size === 0) {
      this.pushLog('平安夜，没有人死亡');
    } else {
      for (const seat of [...deaths].sort((a, b) => a - b)) {
        const p = this.players[seat];
        if (!p || !p.alive) continue;
        p.alive = false;
        this.pushLog(`${p.name} 死亡，身份是【${ROLE_NAME[p.role]}】`);
      }
    }
    if (this.checkWin()) return;
    this.startDay();
  }

  startDay() {
    this.dayCount += 1;
    this.stage = 'day_speech';
    this.speeches = [];
    this.votes = {};
    this.dayQueue = this.aliveSeats();
    this.dayIndex = 0;
    this.pushLog(`第 ${this.dayCount} 天讨论开始`);
    this.advanceDay();
  }

  advanceDay() {
    if (this.dayIndex >= this.dayQueue.length) {
      this.startVote();
      return;
    }
    const seat = this.dayQueue[this.dayIndex];
    if (!this.players[seat]?.alive) { this.dayIndex += 1; this.advanceDay(); return; }
    this.current = seat;
    this.stage = 'day_speech';
    this.last = { kind: 'speech', seat };
  }

  startVote() {
    this.stage = 'day_vote';
    this.votes = {};
    this.dayQueue = this.aliveSeats();
    this.dayIndex = 0;
    this.pushLog('发言结束，开始投票');
    this.advanceVote();
  }

  advanceVote() {
    if (this.dayIndex >= this.dayQueue.length) {
      this.resolveVote();
      return;
    }
    const seat = this.dayQueue[this.dayIndex];
    if (!this.players[seat]?.alive) { this.dayIndex += 1; this.advanceVote(); return; }
    this.current = seat;
    this.stage = 'day_vote';
    this.last = { kind: 'vote', seat };
  }

  say(seat, text) {
    this.assertTurn(seat);
    if (this.stage !== 'day_speech') throw new GameError('NOT_SPEECH', '现在不是发言阶段');
    const clean = String(text || '').trim().slice(0, 300);
    if (!clean) throw new GameError('EMPTY_SPEECH', '发言不能为空');
    this.speeches.push({ seat, text: clean });
    this.pushLog(`${this.players[seat].name}：${clean}`);
    this.dayIndex += 1;
    this.advanceDay();
    return this.snapshot();
  }

  pass(seat) {
    this.assertTurn(seat);
    if (this.stage === 'day_speech') {
      this.pushLog(`${this.players[seat].name} 过`);
      this.dayIndex += 1;
      this.advanceDay();
      return this.snapshot();
    }
    if (this.stage === 'night') {
      this.nightIndex += 1;
      this.last = { kind: 'pass', seat };
      this.advanceNight();
      return this.snapshot();
    }
    throw new GameError('BAD_PHASE', '现在不能过');
  }

  vote(seat, targetSeat) {
    this.assertTurn(seat);
    if (this.stage !== 'day_vote') throw new GameError('NOT_VOTE', '现在不是投票阶段');
    if (targetSeat !== null) {
      const target = this.players[targetSeat];
      if (!target || !target.alive || targetSeat === seat) throw new GameError('BAD_TARGET', '请选择其他存活玩家');
    }
    this.votes[seat] = targetSeat;
    this.pushLog(`${this.players[seat].name} 投出一票`);
    this.dayIndex += 1;
    this.advanceVote();
    return this.snapshot();
  }

  resolveVote() {
    const counts = {};
    for (const target of Object.values(this.votes)) {
      if (target === null) continue;
      counts[target] = (counts[target] || 0) + 1;
    }
    const entries = Object.entries(counts).map(([seat, n]) => ({ seat: Number(seat), n }));
    const max = entries.reduce((m, x) => Math.max(m, x.n), 0);
    const top = entries.filter((x) => x.n === max).sort((a, b) => a.seat - b.seat);
    if (max === 0 || top.length !== 1) {
      this.pushLog(top.length > 1 ? '投票平票，本轮无人被放逐' : '无人投票，本轮无人被放逐');
    } else {
      const seat = top[0].seat;
      const p = this.players[seat];
      p.alive = false;
      this.pushLog(`${p.name} 被放逐，身份是【${ROLE_NAME[p.role]}】`);
    }
    if (this.checkWin()) return;
    this.nightCount += 1;
    this.startNight();
  }

  checkWin() {
    const alive = this.players.filter((p) => p.alive);
    const wolves = alive.filter((p) => p.role === 'wolf').length;
    const others = alive.length - wolves;
    if (wolves === 0) { this.endGame('village'); return true; }
    if (wolves >= others) { this.endGame('wolves'); return true; }
    return false;
  }

  endGame(team) {
    this.phase = 'roundEnd';
    this.stage = 'roundEnd';
    this.winnerTeam = team;
    this.endReason = team;
    const winners = this.players.filter((p) => p.alive && (team === 'wolves' ? p.role === 'wolf' : p.role !== 'wolf'));
    this.winner = winners[0]?.id ?? null;
    this.pushLog(team === 'wolves' ? '狼人阵营获胜' : '好人阵营获胜');
    this.last = { kind: 'end', team };
  }

  roleOf(seat) { return this.players[seat]?.role ?? null; }

  actionsFor(seat) {
    if (this.phase !== 'playing' || seat !== this.current || !this.players[seat]?.alive) return [];
    const role = this.players[seat].role;
    const aliveOthers = this.aliveSeats().filter((s) => s !== seat);
    if (this.stage === 'night') {
      if (role === 'wolf') {
        const targets = aliveOthers.filter((s) => this.players[s].role !== 'wolf');
        return [
          ...targets.map((s) => ({ id: `kill:${s}`, kind: 'kill', targetSeat: s, label: `猎杀 ${this.players[s].name}`, command: { kind: 'kill', targetSeat: s } })),
          { id: 'pass', kind: 'pass', label: '空过', command: { kind: 'pass' } },
        ];
      }
      if (role === 'seer') {
        return aliveOthers.map((s) => ({ id: `inspect:${s}`, kind: 'inspect', targetSeat: s, label: `查验 ${this.players[s].name}`, command: { kind: 'inspect', targetSeat: s } }));
      }
      if (role === 'witch') {
        const out = [];
        if (!this.witchSaveUsed && this.victim !== null) out.push({ id: 'witch:save', kind: 'witch', action: 'save', label: `用解药救 ${this.players[this.victim].name}`, command: { kind: 'witch', action: 'save' } });
        if (!this.witchPoisonUsed) {
          for (const s of aliveOthers) out.push({ id: `witch:poison:${s}`, kind: 'witch', action: 'poison', targetSeat: s, label: `毒杀 ${this.players[s].name}`, command: { kind: 'witch', action: 'poison', targetSeat: s } });
        }
        out.push({ id: 'witch:none', kind: 'witch', action: 'none', label: '不使用药水', command: { kind: 'witch', action: 'none' } });
        return out;
      }
    }
    if (this.stage === 'day_speech') {
      return [
        { id: 'say', kind: 'say', label: '发言', command: { kind: 'say' } },
        { id: 'pass', kind: 'pass', label: '过', command: { kind: 'pass' } },
      ];
    }
    if (this.stage === 'day_vote') {
      return [
        ...aliveOthers.map((s) => ({ id: `vote:${s}`, kind: 'vote', targetSeat: s, label: `投 ${this.players[s].name}`, command: { kind: 'vote', targetSeat: s } })),
        { id: 'abstain', kind: 'abstain', label: '弃票', command: { kind: 'abstain' } },
      ];
    }
    return [];
  }

  snapshot() {
    return {
      phase: this.phase,
      stage: this.stage,
      current: this.current,
      winner: this.winner,
      winnerTeam: this.winnerTeam,
      endReason: this.endReason,
      nightCount: this.nightCount,
      dayCount: this.dayCount,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        role: this.phase === 'roundEnd' || !p.alive ? p.role : null,
        roleName: this.phase === 'roundEnd' || !p.alive ? ROLE_NAME[p.role] : null,
      })),
      speeches: [...this.speeches],
      log: this.log.slice(-60),
      last: this.last,
    };
  }

  viewFor(seat) {
    const snap = this.snapshot();
    const self = this.players[seat];
    const role = self?.role ?? null;
    const aliveOthers = this.aliveSeats().filter((s) => s !== seat);
    const teammateSeats = role === 'wolf' ? this.wolfSeats().filter((s) => s !== seat) : [];
    const actions = this.actionsFor(seat);
    return {
      ...snap,
      you: seat,
      role,
      roleName: role ? ROLE_NAME[role] : null,
      roleDesc: role ? ROLE_DESC[role] : null,
      teammates: teammateSeats.map((s) => ({ id: s, name: this.players[s].name })),
      seerKnowledge: role === 'seer' ? { ...this.seerKnowledge } : {},
      witch: role === 'witch'
        ? { victim: this.victim, saveUsed: this.witchSaveUsed, poisonUsed: this.witchPoisonUsed }
        : null,
      actions,
      aliveOthers: aliveOthers.map((s) => ({ id: s, name: this.players[s].name })),
      votesCast: Object.keys(this.votes).length,
    };
  }

  pushLog(text) {
    this.log.push(String(text));
    if (this.log.length > 120) this.log.shift();
  }
}

export function aiWerewolf(game, seat) {
  if (game.phase !== 'playing' || game.current !== seat || !game.players[seat]?.alive) return null;
  const role = game.players[seat].role;
  const others = game.aliveSeats().filter((s) => s !== seat);
  if (game.stage === 'night') {
    if (role === 'wolf') {
      const target = others.find((s) => game.players[s].role !== 'wolf');
      return target == null ? { kind: 'pass' } : { kind: 'kill', targetSeat: target };
    }
    if (role === 'seer') {
      const target = others.find((s) => !(s in game.seerKnowledge));
      return target == null ? { kind: 'pass' } : { kind: 'inspect', targetSeat: target };
    }
    if (role === 'witch') {
      if (!game.witchSaveUsed && game.victim !== null) return { kind: 'witch', action: 'save' };
      if (!game.witchPoisonUsed) {
        const target = others.find((s) => s !== game.victim);
        if (target != null) return { kind: 'witch', action: 'poison', targetSeat: target };
      }
      return { kind: 'witch', action: 'none' };
    }
  }
  if (game.stage === 'day_speech') {
    const target = others[0];
    return { kind: 'say', text: target == null ? '我先过。' : `我暂时怀疑 ${game.players[target].name}，先听完大家发言。` };
  }
  if (game.stage === 'day_vote') {
    if (role === 'seer') {
      const knownWolf = Object.entries(game.seerKnowledge).find(([, r]) => r === 'wolf')?.[0];
      if (knownWolf != null) return { kind: 'vote', targetSeat: Number(knownWolf) };
    }
    return others.length ? { kind: 'vote', targetSeat: others[0] } : { kind: 'abstain' };
  }
  return null;
}

export const game = {
  key: 'werewolf',
  name: '狼人杀',
  card: 'WW',
  min: 6,
  max: 8,
  create: ({ playerNames = [], options = {}, random }) => new WerewolfGame({ playerNames, options, random }),
  ai: aiWerewolf,
};
