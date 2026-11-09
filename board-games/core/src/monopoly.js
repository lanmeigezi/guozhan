// monopoly.js — 简化大富翁：24 格环形棋盘、买地、租金、基建、监狱、机会卡堆、抵押与连片倍租。
// 规则只由本文件裁决；Host/UI/LLM 只能提交动作。
//
// 本轮机制扩充（摇色子的刺激感来源）：
//   1. 掷出双数可再走一次；连续三次双数直接入狱。
//   2. 机会格改为真随机卡堆（洗牌抽取，抽出的卡放回堆底，不永久消耗）。
//   3. 出狱三选一：缴 50 交保 / 狱中掷双数免费出狱 / 服刑满 3 回合强制出狱并缴 50。
//   4. 抵押与赎回：抵押得地价一半且期间不收租，赎回付地价一半 + 10% 手续费。
//   5. 同颜色组全部持有且无抵押时，该组租金 ×2（空地与有房同样享受连片系数）。

import { GameError } from './game-error.js';

const START_CASH = 1500;
const GO_SALARY = 200;
const MAX_TURNS = 200;
const MAX_HOUSES = 3;
const BAIL_COST = 50;            // 交保金 / 服刑满 3 回合的强制出狱金
const JAIL_MAX_TURNS = 3;        // 入狱当回合算第 1 服刑回合
const REDEEM_FEE_RATE = 0.1;     // 赎回手续费：抵押价（地价一半）的 10%
const GROUP_RENT_MULTIPLIER = 2; // 同组连片倍租系数
// 房租随建筑等级陡增（空地 / 1 / 2 / 3 级）：平地收租没感觉，后期必须疼
const HOUSE_RENT_MULTIPLIERS = Object.freeze([1, 3, 8, 15]);

/** 24 格：8 个特殊格 + 16 块地产（A-H 每组两块） */
export const MONOPOLY_BOARD = Object.freeze([
  { i: 0, kind: 'go', name: '起点' },
  { i: 1, kind: 'property', name: '长安街', group: 'A', price: 60, rent: 2, houseCost: 50 },
  { i: 2, kind: 'chance', name: '机会' },
  { i: 3, kind: 'property', name: '朱雀街', group: 'A', price: 80, rent: 4, houseCost: 50 },
  { i: 4, kind: 'tax', name: '税关', amount: 75 },
  { i: 5, kind: 'property', name: '玄武坊', group: 'B', price: 100, rent: 6, houseCost: 50 },
  { i: 6, kind: 'jail', name: '监狱（探监）' },
  { i: 7, kind: 'property', name: '白虎坊', group: 'B', price: 120, rent: 8, houseCost: 50 },
  { i: 8, kind: 'property', name: '东市', group: 'C', price: 140, rent: 10, houseCost: 100 },
  { i: 9, kind: 'chance', name: '机会' },
  { i: 10, kind: 'property', name: '西市', group: 'C', price: 160, rent: 12, houseCost: 100 },
  { i: 11, kind: 'free', name: '免费停车' },
  { i: 12, kind: 'property', name: '南门', group: 'D', price: 180, rent: 14, houseCost: 100 },
  { i: 13, kind: 'property', name: '北门', group: 'D', price: 200, rent: 16, houseCost: 100 },
  { i: 14, kind: 'property', name: '曲江池', group: 'E', price: 220, rent: 18, houseCost: 150 },
  { i: 15, kind: 'property', name: '灞桥', group: 'E', price: 240, rent: 20, houseCost: 150 },
  { i: 16, kind: 'gojail', name: '入狱' },
  { i: 17, kind: 'property', name: '大雁塔', group: 'F', price: 260, rent: 22, houseCost: 150 },
  { i: 18, kind: 'property', name: '小雁塔', group: 'F', price: 280, rent: 24, houseCost: 150 },
  { i: 19, kind: 'chance', name: '机会' },
  { i: 20, kind: 'property', name: '未央宫', group: 'G', price: 300, rent: 26, houseCost: 200 },
  { i: 21, kind: 'property', name: '长乐宫', group: 'G', price: 320, rent: 28, houseCost: 200 },
  { i: 22, kind: 'property', name: '大明宫', group: 'H', price: 350, rent: 30, houseCost: 200 },
  { i: 23, kind: 'property', name: '兴庆宫', group: 'H', price: 400, rent: 35, houseCost: 200 },
]);

const BOARD_SIZE = MONOPOLY_BOARD.length;

/** 颜色组 → 地产格索引，用于同组连片判定 */
const GROUP_TILES = (() => {
  const map = {};
  for (const t of MONOPOLY_BOARD) {
    if (t.kind !== 'property') continue;
    (map[t.group] = map[t.group] || []).push(t.i);
  }
  return map;
})();

/**
 * 机会卡堆 12 张：奖金 / 罚款 / 前进到指定格 / 后退 / 直接入狱 / 免租一次 / 向对手收钱。
 * 抽卡先用 this.random 洗牌，抽出的卡放回堆底，因此不会永久消耗。
 */
const CHANCE = Object.freeze([
  { text: '银行分红，获得 150 金', cash: 150 },
  { text: '商队厚报，获得 200 金', cash: 200 },
  { text: '修缮府邸，支出 150 金', cash: -150 },
  { text: '官府罚没，支出 100 金', cash: -100 },
  { text: '被巡捕查获，直接进入监狱', jail: true },
  { text: '取得免租凭据，下次应付租金全免', rentFree: 1 },
  { text: '亲友送礼，向每位对手各收 50 金', collect: 50 },
  { text: '快马加鞭，前进至起点并领取薪俸', moveTo: 0 },
  { text: '顺路拜访，前进至朱雀街', moveTo: 3 },
  { text: '远行经商，前进至大明宫', moveTo: 22 },
  { text: '误入巷弄，前进至免费停车', moveTo: 11 },
  { text: '倒车回府，后退三格', moveBack: 3 },
]);

/** 只读机会卡堆与常量，供测试与 UI 引用 */
export const CHANCE_CARDS = CHANCE;
export const JAIL_RULES = Object.freeze({ bail: BAIL_COST, maxTurns: JAIL_MAX_TURNS });
export const RENT_RULES = Object.freeze({ redeemFeeRate: REDEEM_FEE_RATE, groupMultiplier: GROUP_RENT_MULTIPLIER, houseMultipliers: HOUSE_RENT_MULTIPLIERS });

function propIndex(tile) {
  return MONOPOLY_BOARD.find((t) => t.i === tile);
}

export class MonopolyGame {
  constructor({ playerNames = [], options = {}, random } = {}) {
    this.random = random || Math.random;
    this.players = playerNames.map((name, i) => this.makePlayer(i, name));
    this.phase = 'lobby'; // lobby | playing | roundEnd
    this.current = 0;
    this.winner = null;
    this.endReason = null;
    this.turnCount = 0;
    this.pending = null; // {kind:'buy'|'manage', tile}
    this.roll = null;
    this.extraRollFor = null; // 掷出双数后可再走一次的座位
    this.chanceDeck = [];     // 机会卡堆（存 CHANCE 下标，抽出的卡放回堆底）
    this.last = null;
    this.log = [];
    this.properties = MONOPOLY_BOARD.filter((t) => t.kind === 'property').map((t) => ({
      tile: t.i,
      ownerId: null,
      houses: 0,
      mortgaged: false,
    }));
  }

  get n() { return this.players.length; }

  makePlayer(id, name) {
    return {
      id,
      name: String(name || '玩家').slice(0, 20),
      cash: START_CASH,
      pos: 0,
      inJail: 0,     // >0 表示在狱中，数值为已服刑回合数（入狱当回合算第 1 回合）
      bankrupt: false,
      doublesRun: 0, // 连续掷出双数的次数，满 3 直接入狱
      rentFree: 0,   // 免租凭据张数
    };
  }

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '游戏已开始');
    if (this.n >= 4) throw new GameError('ROOM_FULL', '大富翁最多 4 人');
    this.players.push(this.makePlayer(this.players.length, name));
    return this.players.length - 1;
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('GAME_STARTED', '游戏已开始');
    if (this.n < 2) throw new GameError('NOT_ENOUGH', '大富翁至少需要 2 人');
    if (this.n > 4) throw new GameError('TOO_MANY', '大富翁最多 4 人');
    this.phase = 'playing';
    this.current = 0;
    this.turnCount = 1;
    this.winner = null;
    this.endReason = null;
    this.pending = null;
    this.roll = null;
    this.extraRollFor = null;
    this.log = [];
    this.buildChanceDeck();
    this.pushLog(`游戏开始：${this.players.map((p) => p.name).join('、')}，每人 ${START_CASH} 金`);
    this.pushLog(`轮到 ${this.players[this.current].name}`);
    return this.snapshot();
  }

  // ————————————————————— 机会卡堆 —————————————————————

  buildChanceDeck() {
    this.chanceDeck = CHANCE.map((_, i) => i);
    for (let i = this.chanceDeck.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const tmp = this.chanceDeck[i];
      this.chanceDeck[i] = this.chanceDeck[j];
      this.chanceDeck[j] = tmp;
    }
  }

  /** 取堆顶并放回堆底（不永久消耗） */
  drawChanceCard() {
    if (!this.chanceDeck.length) this.buildChanceDeck();
    const idx = this.chanceDeck.shift();
    this.chanceDeck.push(idx);
    return { ...CHANCE[idx], idx };
  }

  applyAction(seat, action) {
    const act = action || {};
    switch (act.kind) {
      case 'start': return this.start();
      case 'roll': return this.rollDice(seat);
      case 'buy': return this.buy(seat);
      case 'decline': return this.decline(seat);
      case 'build': return this.build(seat);
      case 'pay_bail': return this.payBail(seat);
      case 'mortgage': return this.mortgage(seat, act.tile);
      case 'redeem': return this.redeem(seat, act.tile);
      case 'end': return this.endTurn(seat);
      default: throw new GameError('UNKNOWN_ACT', '未知大富翁操作');
    }
  }

  assertTurn(seat) {
    if (this.phase !== 'playing') throw new GameError('NOT_PLAYING', '对局未开始或已结束');
    const p = this.players[seat];
    if (!p || p.bankrupt) throw new GameError('ELIMINATED', '你已破产');
    if (seat !== this.current) throw new GameError('NOT_YOUR_TURN', '还没轮到你');
  }

  rollTwo() {
    const a = 1 + Math.floor(this.random() * 6);
    const b = 1 + Math.floor(this.random() * 6);
    return { a, b, total: a + b, doubles: a === b };
  }

  rollDice(seat) {
    this.assertTurn(seat);
    if (this.pending) throw new GameError('PENDING_ACTION', '请先处理当前地块的购买/建造');
    const p = this.players[seat];
    if (p.inJail > 0) return this.rollInJail(seat);

    const dice = this.rollTwo();
    this.roll = { a: dice.a, b: dice.b, total: dice.total, doubles: dice.doubles };
    const fromName = MONOPOLY_BOARD[p.pos].name;

    // 连续三次双数直接入狱（经典规则）
    if (dice.doubles) {
      p.doublesRun += 1;
      if (p.doublesRun >= 3) {
        this.extraRollFor = null;
        this.pushLog(`${p.name} 连续第三次掷出双数 ${dice.a}+${dice.b}，罚入监狱`);
        this.sendToJail(p, '连续三次双数');
        this.advanceTurn();
        return this.snapshot();
      }
      this.extraRollFor = seat; // 双数再走一次
    } else {
      p.doublesRun = 0;
      this.extraRollFor = null;
    }

    const { to } = this.moveSteps(p, dice.total);
    this.pushLog(
      `${p.name} 掷出 ${dice.a}+${dice.b}=${dice.total}${dice.doubles ? '（双数，可再走一次）' : ''}，`
      + `从 ${fromName} 前进至 ${MONOPOLY_BOARD[to].name}`,
    );
    this.resolveTile(seat);
    return this.snapshot();
  }

  /** 狱中掷骰：掷双数免费出狱并照常前进；否则继续服刑，满 3 回合强制出狱并缴 50 */
  rollInJail(seat) {
    const p = this.players[seat];
    p.inJail += 1;
    const dice = this.rollTwo();
    this.roll = { a: dice.a, b: dice.b, total: dice.total, doubles: dice.doubles, inJail: true };
    if (dice.doubles) {
      p.inJail = 0;
      p.doublesRun = 0;
      this.pushLog(`${p.name} 狱中掷出双数 ${dice.a}+${dice.b}，免费出狱并前进 ${dice.total} 格`);
      this.moveSteps(p, dice.total);
      this.resolveTile(seat);
      return this.snapshot();
    }
    this.pushLog(`${p.name} 狱中掷出 ${dice.a}+${dice.b}，仍未能出狱（已服刑 ${p.inJail}/${JAIL_MAX_TURNS} 回合）`);
    if (p.inJail >= JAIL_MAX_TURNS) {
      p.inJail = 0;
      p.doublesRun = 0;
      this.pushLog(`${p.name} 服刑满 ${JAIL_MAX_TURNS} 回合，强制出狱并缴纳 ${BAIL_COST} 金`);
      if (!this.payBank(p, BAIL_COST)) {
        this.advanceTurn();
        return this.snapshot();
      }
    }
    this.advanceTurn();
    return this.snapshot();
  }

  /** 缴纳 50 金交保出狱；出狱后本回合仍可正常掷骰前进 */
  payBail(seat) {
    this.assertTurn(seat);
    if (this.pending) throw new GameError('PENDING_ACTION', '请先处理当前地块的购买/建造');
    const p = this.players[seat];
    if (p.inJail <= 0) throw new GameError('NOT_IN_JAIL', '你不在监狱中');
    if (p.cash < BAIL_COST) throw new GameError('INSUFFICIENT_GOLD', `交保需要 ${BAIL_COST} 金`);
    p.cash -= BAIL_COST;
    p.inJail = 0;
    p.doublesRun = 0;
    this.pushLog(`${p.name} 缴纳 ${BAIL_COST} 金交保出狱，本回合可正常掷骰`);
    return this.snapshot();
  }

  // ————————————————————— 移动 —————————————————————

  /** 前进 n 格，绕圈经过起点领取薪俸 */
  moveSteps(p, steps) {
    const from = p.pos;
    const to = (from + steps) % BOARD_SIZE;
    if (from + steps >= BOARD_SIZE) {
      p.cash += GO_SALARY;
      this.pushLog(`${p.name} 经过起点，领取 ${GO_SALARY} 金`);
    }
    p.pos = to;
    return { from, to };
  }

  /** 后退 n 格：不领也不付起点薪俸 */
  moveBack(p, steps) {
    const from = p.pos;
    p.pos = (from - steps + BOARD_SIZE) % BOARD_SIZE;
    this.pushLog(`${p.name} 从 ${MONOPOLY_BOARD[from].name} 后退至 ${MONOPOLY_BOARD[p.pos].name}`);
  }

  /** 直接前往指定格（绕行经过起点照常领薪） */
  moveToTile(p, target) {
    const steps = (target - p.pos + BOARD_SIZE) % BOARD_SIZE;
    if (steps === 0) {
      this.pushLog(`${p.name} 已在 ${MONOPOLY_BOARD[p.pos].name}，无需移动`);
      return;
    }
    this.moveSteps(p, steps);
  }

  resolveTile(seat, depth = 0) {
    const p = this.players[seat];
    if (!p || p.bankrupt || this.phase !== 'playing') return this.snapshot();
    const tile = MONOPOLY_BOARD[p.pos];
    if (!tile) return this.advanceTurn();
    if (tile.kind === 'property') {
      const prop = this.propAt(tile.i);
      if (!prop) return this.advanceTurn();
      if (prop.ownerId === null) {
        this.pending = { kind: 'buy', tile: tile.i };
        this.pushLog(`${p.name} 抵达无主地产「${tile.name}」，可花 ${tile.price} 金购买`);
        return this.snapshot();
      }
      if (prop.ownerId === seat) {
        this.pending = { kind: 'manage', tile: tile.i };
        this.pushLog(`${p.name} 回到自己的「${tile.name}」${prop.mortgaged ? '（已抵押，不收租）' : ''}`);
        return this.snapshot();
      }
      const owner = this.players[prop.ownerId];
      if (!owner || owner.bankrupt) return this.advanceTurn();
      if (prop.mortgaged) {
        this.pushLog(`${p.name} 踩中 ${owner.name} 抵押中的「${tile.name}」，抵押期间不收租金`);
        return this.advanceTurn();
      }
      const rent = this.rentOf(tile, prop);
      if (p.rentFree > 0 && rent > 0) {
        p.rentFree -= 1;
        this.pushLog(`${p.name} 使用免租凭据，免付「${tile.name}」租金 ${rent} 金`);
        return this.advanceTurn();
      }
      const bonus = this.hasGroupMonopoly(prop.ownerId, tile.group) ? '（同组连片倍租）' : '';
      this.pushLog(`${p.name} 踩中 ${owner.name} 的「${tile.name}」，支付租金 ${rent} 金${bonus}`);
      if (!this.payBank(p, rent)) return this.advanceTurn();
      owner.cash += rent;
      return this.advanceTurn();
    }
    if (tile.kind === 'tax') {
      this.pushLog(`${p.name} 缴纳「${tile.name}」${tile.amount} 金`);
      if (!this.payBank(p, tile.amount)) return this.advanceTurn();
      return this.advanceTurn();
    }
    if (tile.kind === 'gojail') {
      this.sendToJail(p, '入狱格');
      return this.advanceTurn();
    }
    if (tile.kind === 'chance') {
      const card = this.drawChanceCard();
      this.pushLog(`${p.name} 抽到机会：${card.text}`);
      if (this.applyChanceCard(seat, card, depth)) return this.snapshot();
      return this.advanceTurn();
    }
    if (tile.kind === 'jail') {
      this.pushLog(`${p.name} 探监，无额外事件`);
      return this.advanceTurn();
    }
    this.pushLog(`${p.name} 停在「${tile.name}」`);
    return this.advanceTurn();
  }

  /**
   * 执行机会卡效果。返回 true 表示回合已在此处推进（递归结算新落点或对局已结束），
   * 返回 false 表示调用方需要 advanceTurn。
   */
  applyChanceCard(seat, card, depth) {
    const p = this.players[seat];
    if (card.cash) {
      if (card.cash > 0) p.cash += card.cash;
      else if (!this.payBank(p, -card.cash)) {
        this.advanceTurn();
        return true;
      }
      return false;
    }
    if (card.jail) {
      this.sendToJail(p, '机会牌');
      return false;
    }
    if (card.rentFree) {
      p.rentFree += card.rentFree;
      this.pushLog(`${p.name} 现有免租凭据 ${p.rentFree} 张`);
      return false;
    }
    if (card.collect) {
      this.collectFromRivals(p, card.collect);
      return this.phase !== 'playing';
    }
    if (card.moveTo != null || card.moveBack) {
      if (card.moveTo != null) this.moveToTile(p, card.moveTo);
      else this.moveBack(p, card.moveBack);
      if (depth >= 3) return false; // 卡片链递归上限
      this.resolveTile(seat, depth + 1);
      return true;
    }
    return false;
  }

  /** 亲友送礼：向每位存活对手收取固定金额（付不起的对手会破产） */
  collectFromRivals(p, amount) {
    let gained = 0;
    for (const other of this.players) {
      if (other.id === p.id || other.bankrupt) continue;
      if (this.phase !== 'playing') break;
      if (!this.payBank(other, amount)) {
        if (this.phase !== 'playing') break;
        continue;
      }
      gained += amount;
    }
    p.cash += gained;
    if (gained > 0) this.pushLog(`${p.name} 收取 ${gained} 金（每位对手 ${amount} 金）`);
    return gained;
  }

  buy(seat) {
    this.assertTurn(seat);
    if (!this.pending || this.pending.kind !== 'buy') throw new GameError('NO_PENDING', '当前没有可购买的地产');
    const p = this.players[seat];
    const tile = propIndex(this.pending.tile);
    const prop = this.propAt(tile.i);
    if (!tile || !prop || prop.ownerId !== null) throw new GameError('NOT_FOR_SALE', '该地产已不可购买');
    if (p.cash < tile.price) throw new GameError('INSUFFICIENT_GOLD', `购买「${tile.name}」需要 ${tile.price} 金`);
    p.cash -= tile.price;
    prop.ownerId = seat;
    this.pending = null;
    this.pushLog(`${p.name} 以 ${tile.price} 金买下「${tile.name}」`);
    this.advanceTurn();
    return this.snapshot();
  }

  decline(seat) {
    this.assertTurn(seat);
    if (!this.pending || this.pending.kind !== 'buy') throw new GameError('NO_PENDING', '当前没有待购买的地产');
    const tile = propIndex(this.pending.tile);
    this.pending = null;
    this.pushLog(`${this.players[seat].name} 放弃购买「${tile?.name ?? '地产'}」`);
    this.advanceTurn();
    return this.snapshot();
  }

  build(seat) {
    this.assertTurn(seat);
    if (!this.pending || this.pending.kind !== 'manage') throw new GameError('NO_PENDING', '当前不在自己的地产上');
    const tile = propIndex(this.pending.tile);
    const prop = this.propAt(tile.i);
    const p = this.players[seat];
    if (!tile || !prop || prop.ownerId !== seat) throw new GameError('NOT_OWNER', '不是你的地产');
    if (prop.mortgaged) throw new GameError('MORTGAGED', '抵押中的地产需先赎回才能建造');
    if (prop.houses >= MAX_HOUSES) throw new GameError('MAX_HOUSES', '该地产已达到最高等级');
    if (p.cash < tile.houseCost) throw new GameError('INSUFFICIENT_GOLD', `建造需要 ${tile.houseCost} 金`);
    p.cash -= tile.houseCost;
    prop.houses += 1;
    this.pushLog(`${p.name} 在「${tile.name}」建造，等级 ${prop.houses}，租金提升`);
    return this.snapshot();
  }

  // ————————————————————— 抵押与赎回 —————————————————————

  mortgageGain(tile) {
    return Math.floor(tile.price / 2);
  }

  redeemCost(tile) {
    return Math.ceil(this.mortgageGain(tile) * (1 + REDEEM_FEE_RATE));
  }

  mortgage(seat, tileIdx) {
    this.assertTurn(seat);
    const p = this.players[seat];
    if (p.inJail > 0) throw new GameError('IN_JAIL', '狱中不能处置地产');
    const tile = propIndex(Number(tileIdx));
    const prop = tile && tile.kind === 'property' ? this.propAt(tile.i) : null;
    if (!prop) throw new GameError('BAD_TILE', '该格不是可抵押的地产');
    if (prop.ownerId !== seat) throw new GameError('NOT_OWNER', '不是你的地产');
    if (prop.mortgaged) throw new GameError('MORTGAGED', '该地产已处于抵押状态');
    if (prop.houses > 0) throw new GameError('HAS_HOUSES', '已建房的地产不能抵押');
    const gain = this.mortgageGain(tile);
    prop.mortgaged = true;
    p.cash += gain;
    this.pushLog(`${p.name} 抵押「${tile.name}」获得 ${gain} 金（抵押期间不收租）`);
    return this.snapshot();
  }

  redeem(seat, tileIdx) {
    this.assertTurn(seat);
    const p = this.players[seat];
    if (p.inJail > 0) throw new GameError('IN_JAIL', '狱中不能处置地产');
    const tile = propIndex(Number(tileIdx));
    const prop = tile && tile.kind === 'property' ? this.propAt(tile.i) : null;
    if (!prop) throw new GameError('BAD_TILE', '该格不是可赎回的地产');
    if (prop.ownerId !== seat) throw new GameError('NOT_OWNER', '不是你的地产');
    if (!prop.mortgaged) throw new GameError('NOT_MORTGAGED', '该地产未抵押');
    const cost = this.redeemCost(tile);
    if (p.cash < cost) throw new GameError('INSUFFICIENT_GOLD', `赎回「${tile.name}」需要 ${cost} 金`);
    p.cash -= cost;
    prop.mortgaged = false;
    this.pushLog(`${p.name} 花 ${cost} 金赎回「${tile.name}」（含 ${cost - this.mortgageGain(tile)} 金手续费）`);
    return this.snapshot();
  }

  endTurn(seat) {
    this.assertTurn(seat);
    if (this.pending?.kind === 'buy') throw new GameError('PENDING_ACTION', '请先购买或放弃该地产');
    this.pending = null;
    this.advanceTurn();
    return this.snapshot();
  }

  sendToJail(p, reason) {
    p.pos = 6;
    p.inJail = 1;
    p.doublesRun = 0;
    if (this.extraRollFor === p.id) this.extraRollFor = null;
    this.pending = null;
    this.pushLog(`${p.name} 因${reason}进入监狱（可交保 ${BAIL_COST} 金 / 狱中掷双数 / 服刑满 ${JAIL_MAX_TURNS} 回合强制出狱）`);
  }

  payBank(p, amount) {
    if (amount <= 0) return true;
    if (p.cash < amount) {
      p.cash = 0;
      this.bankrupt(p, `无力支付 ${amount} 金`);
      return false;
    }
    p.cash -= amount;
    return true;
  }

  bankrupt(p, reason) {
    if (p.bankrupt) return;
    p.bankrupt = true;
    p.inJail = 0;
    p.doublesRun = 0;
    p.rentFree = 0;
    if (this.extraRollFor === p.id) this.extraRollFor = null;
    for (const prop of this.properties) {
      if (prop.ownerId === p.id) {
        prop.ownerId = null;
        prop.houses = 0;
        prop.mortgaged = false;
      }
    }
    this.pushLog(`${p.name} 破产：${reason}`);
    const alive = this.players.filter((x) => !x.bankrupt);
    if (alive.length <= 1) {
      this.endGame(alive[0]?.id ?? null, 'bankruptcy');
    }
  }

  advanceTurn() {
    if (this.phase !== 'playing') return;
    this.pending = null;
    // 刻意不清 this.roll：UI 靠快照里的骰子点数做翻滚/落点动画，
    // 清掉会让"轮到下一位"的那一帧看不到刚掷出的点数。下一次掷骰会覆盖它。
    if (this.players.filter((p) => !p.bankrupt).length <= 1) {
      this.endGame(this.players.find((p) => !p.bankrupt)?.id ?? null, 'bankruptcy');
      return;
    }
    if (this.turnCount >= MAX_TURNS) {
      const alive = this.players.filter((p) => !p.bankrupt);
      alive.sort((a, b) => this.netWorth(b) - this.netWorth(a) || a.id - b.id);
      this.endGame(alive[0]?.id ?? null, 'turn_limit');
      return;
    }
    // 双数再走一次：同一玩家继续掷骰，但回合号照常递增，保证对局必然终局
    const seat = this.current;
    const extra = this.extraRollFor;
    this.extraRollFor = null;
    const cur = this.players[seat];
    if (extra === seat && cur && !cur.bankrupt && cur.inJail === 0) {
      this.turnCount += 1;
      this.last = { kind: 'turn', seat, turn: this.turnCount, extraRoll: true };
      this.pushLog(`${cur.name} 掷出双数，再走一次（第 ${this.turnCount} 回合）`);
      return;
    }
    if (cur) cur.doublesRun = 0;
    for (let step = 0; step < this.n; step++) {
      this.current = (this.current + 1) % this.n;
      if (!this.players[this.current].bankrupt) break;
    }
    this.turnCount += 1;
    const p = this.players[this.current];
    this.last = { kind: 'turn', seat: this.current, turn: this.turnCount };
    this.pushLog(`轮到 ${p.name}`);
  }

  // ————————————————————— 租金与连片 —————————————————————

  /** 同一颜色组全部持有且组内无任何抵押 → 视为连片，租金系数 ×2 */
  hasGroupMonopoly(ownerId, group) {
    const tiles = GROUP_TILES[group] || [];
    if (!tiles.length) return false;
    return tiles.every((i) => {
      const prop = this.propAt(i);
      return prop && prop.ownerId === ownerId && !prop.mortgaged;
    });
  }

  /** 单块地产当前应收租金（含建筑等级与连片系数；无主或抵押为 0） */
  rentOf(tile, prop) {
    if (!tile || !prop || prop.ownerId === null || prop.mortgaged) return 0;
    const base = tile.rent * HOUSE_RENT_MULTIPLIERS[Math.min(prop.houses, MAX_HOUSES)];
    const mult = this.hasGroupMonopoly(prop.ownerId, tile.group) ? GROUP_RENT_MULTIPLIER : 1;
    return Math.round(base * mult);
  }

  netWorth(p) {
    let total = p.cash;
    for (const prop of this.properties) {
      if (prop.ownerId !== p.id) continue;
      const tile = propIndex(prop.tile);
      if (!tile) continue;
      // 抵押中的地产按半价计入净值（抵押换到的现金已计在 cash 里）
      total += (prop.mortgaged ? Math.floor(tile.price / 2) : tile.price) + tile.houseCost * prop.houses;
    }
    return total;
  }

  endGame(winner, reason) {
    this.phase = 'roundEnd';
    this.winner = winner;
    this.endReason = reason;
    this.pending = null;
    this.roll = null;
    this.extraRollFor = null;
    this.pushLog(winner === null ? '游戏结束：无人胜出' : `游戏结束：${this.players[winner].name} 胜出`);
    this.last = { kind: 'end', winner, reason };
  }

  propAt(tile) {
    return this.properties.find((p) => p.tile === tile) || null;
  }

  /** 可抵押地产（未抵押、无建筑），按抵押收益从高到低 */
  mortgageable(seat) {
    return this.properties
      .filter((prop) => prop.ownerId === seat && !prop.mortgaged && prop.houses === 0)
      .map((prop) => propIndex(prop.tile))
      .filter(Boolean)
      .sort((a, b) => b.price - a.price);
  }

  /** 可赎回地产（已抵押），按地价从低到高 */
  redeemable(seat) {
    return this.properties
      .filter((prop) => prop.ownerId === seat && prop.mortgaged)
      .map((prop) => propIndex(prop.tile))
      .filter(Boolean)
      .sort((a, b) => a.price - b.price);
  }

  mortgageActions(seat) {
    if (this.players[seat].inJail > 0) return [];
    return this.mortgageable(seat).map((tile) => ({
      id: `mortgage:${tile.i}`,
      kind: 'mortgage',
      tile: tile.i,
      gain: this.mortgageGain(tile),
      label: `抵押「${tile.name}」得 ${this.mortgageGain(tile)} 金（期间不收租）`,
      command: { kind: 'mortgage', tile: tile.i },
    }));
  }

  redeemActions(seat) {
    const p = this.players[seat];
    if (p.inJail > 0) return [];
    return this.redeemable(seat)
      .filter((tile) => p.cash >= this.redeemCost(tile))
      .map((tile) => ({
        id: `redeem:${tile.i}`,
        kind: 'redeem',
        tile: tile.i,
        cost: this.redeemCost(tile),
        label: `赎回「${tile.name}」（${this.redeemCost(tile)} 金，含 10% 手续费）`,
        command: { kind: 'redeem', tile: tile.i },
      }));
  }

  actionsFor(seat) {
    if (this.phase !== 'playing' || seat !== this.current) return [];
    const p = this.players[seat];
    if (!p || p.bankrupt) return [];
    if (this.pending?.kind === 'buy') {
      const tile = propIndex(this.pending.tile);
      const canBuy = tile && p.cash >= tile.price;
      return [
        ...(canBuy ? [{ id: 'buy', kind: 'buy', label: `购买「${tile.name}」（${tile.price} 金）`, command: { kind: 'buy' } }] : []),
        ...this.mortgageActions(seat),
        { id: 'decline', kind: 'decline', label: '放弃购买', command: { kind: 'decline' } },
      ];
    }
    if (this.pending?.kind === 'manage') {
      const tile = propIndex(this.pending.tile);
      const prop = this.propAt(tile.i);
      const out = [];
      if (prop && !prop.mortgaged && prop.houses < MAX_HOUSES && p.cash >= tile.houseCost) {
        out.push({ id: 'build', kind: 'build', label: `建造「${tile.name}」→ Lv${prop.houses + 1}（${tile.houseCost} 金）`, command: { kind: 'build' } });
      }
      out.push(...this.redeemActions(seat));
      out.push(...this.mortgageActions(seat));
      out.push({ id: 'end', kind: 'end', label: '结束回合', command: { kind: 'end' } });
      return out;
    }
    // 狱中三选一：缴 50 交保 / 掷双数免费出狱（服刑满 3 回合由规则强制出狱并缴 50）
    if (p.inJail > 0) {
      const out = [];
      if (p.cash >= BAIL_COST) {
        out.push({ id: 'pay_bail', kind: 'pay_bail', label: `缴纳 ${BAIL_COST} 金交保出狱`, command: { kind: 'pay_bail' } });
      }
      out.push({
        id: 'roll',
        kind: 'roll',
        label: `狱中掷骰求双数（已服刑 ${p.inJail}/${JAIL_MAX_TURNS} 回合）`,
        command: { kind: 'roll' },
      });
      return out;
    }
    return [
      { id: 'roll', kind: 'roll', label: '掷骰子', command: { kind: 'roll' } },
      ...this.redeemActions(seat),
      ...this.mortgageActions(seat),
    ];
  }

  snapshot() {
    return {
      phase: this.phase,
      current: this.current,
      winner: this.winner,
      endReason: this.endReason,
      turnCount: this.turnCount,
      roll: this.roll,
      extraRollFor: this.extraRollFor,
      pending: this.pending ? { ...this.pending } : null,
      chanceCards: this.chanceDeck.length,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, cash: p.cash, pos: p.pos, inJail: p.inJail, bankrupt: p.bankrupt,
        doublesRun: p.doublesRun, rentFree: p.rentFree,
        netWorth: this.netWorth(p),
      })),
      board: MONOPOLY_BOARD.map((t) => {
        const prop = this.propAt(t.i);
        return {
          ...t,
          ownerId: prop?.ownerId ?? null,
          houses: prop?.houses ?? 0,
          mortgaged: prop?.mortgaged ?? false,
          rentNow: prop && prop.ownerId !== null ? this.rentOf(t, prop) : null,
          groupBonus: prop && prop.ownerId !== null ? this.hasGroupMonopoly(prop.ownerId, t.group) : false,
        };
      }),
      log: this.log.slice(-30),
      last: this.last,
    };
  }

  viewFor(seat) {
    const snap = this.snapshot();
    const p = this.players[seat];
    return {
      ...snap,
      you: seat,
      actions: this.actionsFor(seat),
      owe: null,
      netWorth: p ? this.netWorth(p) : 0,
    };
  }

  pushLog(text) {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }
}

export function aiMonopoly(game, seat) {
  if (game.phase !== 'playing' || game.current !== seat) return null;
  const acts = game.actionsFor(seat);
  if (!acts.length) return null;
  const p = game.players[seat];
  const mortgage = acts.filter((a) => a.kind === 'mortgage');
  const redeem = acts.filter((a) => a.kind === 'redeem');

  if (game.pending?.kind === 'buy') {
    const tile = propIndex(game.pending.tile);
    if (tile && p.cash >= tile.price + 100) return { kind: 'buy' };
    // 现金不够，但抵押最贵一块就买得起 → 先抵押换现金（已按收益从高到低排序）
    if (tile && mortgage.length && p.cash + mortgage[0].gain >= tile.price + 100) return mortgage[0].command;
    return { kind: 'decline' };
  }

  if (game.pending?.kind === 'manage') {
    const build = acts.find((a) => a.kind === 'build');
    if (build && p.cash > 500) return { kind: 'build' };
    if (p.cash < 150 && mortgage.length) return mortgage[0].command;
    if (p.cash > 700 && redeem.length) return redeem[0].command;
    return { kind: 'end' };
  }

  // 狱中：现金充裕就交保保住行棋节奏，否则赌双数
  if (p.inJail > 0) {
    const bail = acts.find((a) => a.kind === 'pay_bail');
    if (bail && p.cash >= 300) return { kind: 'pay_bail' };
    return { kind: 'roll' };
  }

  // 手头紧时抵押救急，宽裕时把失血的地赎回来
  if (p.cash < 200 && mortgage.length) return mortgage[0].command;
  if (p.cash > 800 && redeem.length) return redeem[0].command;
  return { kind: 'roll' };
}

export const game = {
  key: 'monopoly',
  name: '大富翁',
  card: 'MON',
  min: 2,
  max: 4,
  create: ({ playerNames = [], options = {}, random }) => new MonopolyGame({ playerNames, options, random }),
  ai: aiMonopoly,
};
