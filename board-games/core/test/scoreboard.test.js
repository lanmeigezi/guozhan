// scoreboard.test.js — cross-game scoring, team wins, aggregation and Host wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Host } from '../src/host.js';
import { mulberry32 } from '../src/cards.js';
import { GAMES } from '../src/games.js';
import {
  SCORE_RULES,
  SCORE_VERSION,
  scoreMatch,
  winnersFor,
  aggregateScoreEvents,
  scoreEventsFromResult,
  tierFor,
} from '../src/scoreboard.js';
import { LeaderboardStore } from '../../server/leaderboard.mjs';

const now = Date.parse('2026-10-27T12:00:00Z');

function fakeGame(n, extra = {}) {
  return { phase: 'roundEnd', players: Array.from({ length: n }, (_, i) => ({ id: i, name: `P${i}`, role: 'villager' })), winner: 0, ...extra };
}

function humanPlayers(n) {
  return Array.from({ length: n }, (_, seat) => ({ seat, name: `P${seat}`, kind: 'human' }));
}

test('大富翁等每个内建游戏都有积分规则', () => {
  for (const key of Object.keys(GAMES)) assert.ok(SCORE_RULES[key], `missing score rule: ${key}`);
  for (const key of Object.keys(SCORE_RULES)) assert.ok(GAMES[key], `score rule without game: ${key}`);
});

test('胜利积分随时长、人数和真人比例增加', () => {
  const base = scoreMatch({ gameKey: 'uno', game: fakeGame(2), startedAt: now - 12 * 60000, endedAt: now, players: humanPlayers(2) });
  const human = base.players.find((p) => p.seat === 0);
  assert.equal(human.outcome, 'win');
  assert.equal(human.points, 50, '2 人 12 分钟真人局基准分');

  const longer = scoreMatch({ gameKey: 'uno', game: fakeGame(2), startedAt: now - 24 * 60000, endedAt: now, players: humanPlayers(2) });
  assert.ok(longer.players[0].points > human.points, '更长的对局应更高');

  const bigger = scoreMatch({ gameKey: 'uno', game: fakeGame(4), startedAt: now - 12 * 60000, endedAt: now, players: humanPlayers(4) });
  assert.ok(bigger.players[0].points > human.points, '更多对手应更高');

  const aiOnly = scoreMatch({
    gameKey: 'uno',
    game: fakeGame(2),
    startedAt: now - 12 * 60000,
    endedAt: now,
    players: [{ seat: 0, name: 'A', kind: 'human' }, { seat: 1, name: 'Bot', kind: 'bot' }],
  });
  assert.ok(aiOnly.players[0].points < human.points, 'AI 对手应打折');
  assert.equal(aiOnly.players[1].kind, 'bot');
  assert.equal(scoreEventsFromResult(aiOnly).length, 1, 'AI 不得写入积分');
});

test('败者只有参与分，平局介于两者之间', () => {
  const win = scoreMatch({ gameKey: 'uno', game: fakeGame(2), startedAt: now - 12 * 60000, endedAt: now, players: humanPlayers(2) });
  const loser = win.players.find((p) => p.seat === 1);
  assert.equal(loser.outcome, 'loss');
  assert.equal(loser.points, 5);
  assert.ok(loser.points < win.players[0].points / 5);

  const drawGame = fakeGame(2, { winner: null });
  const draw = scoreMatch({ gameKey: 'uno', game: drawGame, startedAt: now - 12 * 60000, endedAt: now, players: humanPlayers(2) });
  assert.equal(draw.players[0].outcome, 'draw');
  assert.equal(draw.players[0].points, 20);
});

test('团队游戏的胜者按阵营计算', () => {
  const ddz = { phase: 'roundEnd', players: [{ id: 0 }, { id: 1 }, { id: 2 }], winner: 1, landlord: 0 };
  assert.deepEqual(winnersFor('doudizhu', ddz), [1, 2], '农民获胜时两名农民都算赢');
  const landlordWin = { ...ddz, winner: 0 };
  assert.deepEqual(winnersFor('doudizhu', landlordWin), [0]);

  const ww = {
    phase: 'roundEnd',
    players: [
      { id: 0, role: 'wolf' }, { id: 1, role: 'wolf' }, { id: 2, role: 'villager' },
      { id: 3, role: 'seer' }, { id: 4, role: 'witch' }, { id: 5, role: 'villager' },
    ],
    winnerTeam: 'village',
    winner: 2,
  };
  assert.deepEqual(winnersFor('werewolf', ww), [2, 3, 4, 5]);
  assert.deepEqual(winnersFor('werewolf', { ...ww, winnerTeam: 'wolves' }), [0, 1]);
});

test('排行榜聚合：去重、按区间过滤、段位', () => {
  const event = (id, key, at, points, outcome = 'win', name = key) => ({
    v: SCORE_VERSION, id, playerKey: key, name, game: 'uno', endedAt: new Date(at).toISOString(),
    durationSec: 600, outcome, points, players: 2, humans: 2,
  });
  const events = [
    event('a:0', 'alice', now - 2 * 3600000, 50),
    event('b:0', 'alice', now - 3600000, 20, 'loss'),
    event('c:0', 'bob', now - 3600000, 30, 'win'),
    event('c:0', 'bob', now - 3600000, 30, 'win'), // duplicate id
    event('d:0', 'carol', now - 30 * 86400000, 500),
  ];
  const all = aggregateScoreEvents(events, { now });
  assert.equal(all.length, 3);
  assert.equal(all[0].key, 'carol');
  assert.equal(all.find((r) => r.key === 'alice').plays, 2);
  assert.equal(all.find((r) => r.key === 'bob').plays, 1, '重复 id 只算一次');
  const week = aggregateScoreEvents(events, { range: 'week', now });
  assert.equal(week.length, 2, '30 天前的记录不进本周榜');
  assert.equal(week[0].key, 'alice');
  const today = aggregateScoreEvents(events, { range: 'today', now });
  assert.equal(today.length, 2);
  assert.equal(today[0].key, 'alice');
  assert.equal(tierFor(0).name, '新手');
  assert.equal(tierFor(150).name, '青铜');
  assert.equal(tierFor(1200).name, '黄金');
  assert.equal(tierFor(99999).next, null);
});

test('Host 对局结束只发一次计分，且只给真人', () => {
  const host = new Host({ game: 'uno', playerName: '我', random: mulberry32(11), llm: { model: 'mock', decide: async () => null } });
  host.stopLlmLoop();
  const scores = [];
  const ends = [];
  host.onLocalUpdate = (msg) => { if (msg.t === 'score') scores.push(msg.score); };
  host.onMatchEnd = (result) => ends.push(result);
  try {
    host.addBot('机器人');
    host.setLlmCount(1);
    assert.equal(host.game.players.length, 3);
    host.startGame();
    let guard = 0;
    while (host.game.phase === 'playing' && guard++ < 600) {
      const seat = host.game.current;
      const action = host.ai(seat);
      assert.ok(action, 'every seat has a heuristic');
      const r = host.execute(seat, { t: 'act', kind: action.kind, ...action });
      assert.ok(r.ok, JSON.stringify(r));
    }
    assert.equal(host.game.phase, 'roundEnd');
    assert.equal(scores.length, 1, '只给一个真人发个人积分');
    assert.equal(ends.length, 1, '只回调一次');
    assert.equal(ends[0].humanCount, 1);
    assert.equal(ends[0].players.filter((p) => p.kind === 'human').length, 1);
    assert.ok(ends[0].players.find((p) => p.kind === 'human').points > 0);
    assert.equal(host.execute(0, { t: 'act', kind: 'noop' }).ok, false);
    assert.equal(ends.length, 1, '终局后的非法动作不得重复计分');
  } finally {
    host.stopLlmLoop();
  }
});

test('LeaderboardStore 落盘、去重、哈希设备号并支持区间', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uno-score-'));
  try {
    const store = new LeaderboardStore({ dir });
    const result = {
      matchId: 'm-test', game: 'uno', gameName: 'UNO', endedAt: new Date(now).toISOString(),
      durationSec: 300, playerCount: 2, humanCount: 2,
      players: [
        { seat: 0, name: '甲', kind: 'human', deviceId: 'dev-a', outcome: 'win', points: 30 },
        { seat: 1, name: '乙', kind: 'human', deviceId: 'dev-b', outcome: 'loss', points: 3 },
        { seat: 2, name: 'AI', kind: 'bot', outcome: 'draw', points: 1 },
      ],
    };
    assert.equal(store.appendResult(result), 2);
    assert.equal(store.appendResult(result), 0, '同一 matchId 不重复写入');
    const rows = store.list({ range: 'all' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, '甲');
    assert.equal(rows[0].points, 30);
    const raw = fs.readFileSync(path.join(dir, 'leaderboard.jsonl'), 'utf8');
    assert.ok(!raw.includes('dev-a'), '设备号不得明文落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
