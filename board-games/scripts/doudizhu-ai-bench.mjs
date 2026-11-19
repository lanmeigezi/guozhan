// doudizhu-ai-bench.mjs — 斗地主 AI A/B 基准（零依赖，可复跑）。
//
// 跑法：node board-games/scripts/doudizhu-ai-bench.mjs [局数，默认 60]
// 同一个种子发同样的牌，分别让「强化 AI」和「旧规则 AI」坐同一席位，
// 对手固定为旧 AI；统计胜局。胜率数字来自本脚本实跑，不写在文档里凭空断言。
import { DoudizhuGame, aiDoudizhu, aiDoudizhuLegacy } from '../core/src/doudizhu.js';
import { mulberry32 } from '../core/src/cards.js';

const N = Number(process.argv[2]) || 60;
const AI = { new: aiDoudizhu, old: aiDoudizhuLegacy };

function playOne(seed, champion, championSeat) {
  const g = new DoudizhuGame({ playerNames: ['A', 'B', 'C'], random: mulberry32(seed) });
  g.start();
  for (let s = 0; s < 3; s++) {
    const bid = (s === championSeat ? AI[champion] : AI.old)(g, s);
    g.applyAction(s, bid || { kind: 'bid', score: 0 });
  }
  if (g.phase !== 'playing') return null; // 三家都不叫，流局，重发
  let steps = 0;
  const landlord = g.landlord;
  while (g.phase === 'playing' && steps++ < 400) {
    const seat = g.current;
    const act = (seat === championSeat ? AI[champion] : AI.old)(g, seat);
    if (!act) throw new Error(`AI ${seat} 无动作，step=${steps}`);
    try {
      g.applyAction(seat, act);
    } catch (err) {
      throw new Error(`非法动作 seed=${seed} seat=${seat} ${JSON.stringify(act)}: ${err.message}`);
    }
  }
  if (g.phase !== 'roundEnd') throw new Error(`对局未终止 seed=${seed}`);
  const championWon = (g.winner === landlord) === (championSeat === landlord);
  return championWon;
}

let newWins = 0, oldWins = 0, played = 0;
for (let seed = 1; played < N; seed++) {
  const championSeat = seed % 3; // 轮换席位，消除先手偏差
  const r = playOne(seed, 'new', championSeat);
  if (r === null) continue;
  if (r) newWins++;
  played++;
}
for (let seed = 1, p2 = 0; p2 < N; seed++) {
  const championSeat = seed % 3;
  const r = playOne(seed, 'old', championSeat);
  if (r === null) continue;
  if (r) oldWins++;
  p2++;
}
console.log(JSON.stringify({
  games: N,
  newWins,
  oldWins,
  newWinRate: +(newWins / N).toFixed(4),
  oldWinRate: +(oldWins / N).toFixed(4),
  illegalActions: 0,
}, null, 2));
