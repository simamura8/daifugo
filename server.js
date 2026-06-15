/**
 * 大富豪 WebSocketサーバー
 * Node.js + ws ライブラリ
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// カードユーティリティ
// ─────────────────────────────────────────────

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_SYMBOL = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const RANK_DISPLAY = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 0: '🃏'
};

/**
 * 強さ順: 3<4<5<6<7<8<9<10<J<Q<K<A<2<Joker
 * rank 3=3, 4=4,...,13=K, 1=A, 2=2, 0=Joker
 */
function cardStrength(rank, revolution = false) {
  const order = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 2, 0];
  const base = order.indexOf(rank);
  if (revolution) {
    // 革命時はジョーカーだけ最強維持、それ以外逆転
    if (rank === 0) return 13; // ジョーカー最強
    return 12 - base;         // 0〜12 → 12〜0
  }
  return base;
}

function createDeck(twoJokers = true) {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({
        suit,
        rank,
        display: RANK_DISPLAY[rank] + SUIT_SYMBOL[suit]
      });
    }
  }
  // ジョーカーの枚数設定
  const jokerCount = twoJokers ? 2 : 1;
  for (let i = 0; i < jokerCount; i++) {
    deck.push({ suit: 'joker', rank: 0, display: '🃏' });
  }
  return deck;
}

function shuffle(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardKey(card) {
  return `${card.suit}_${card.rank}`;
}

// ─────────────────────────────────────────────
// ルーム管理
// ─────────────────────────────────────────────

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function generatePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

const DEFAULT_RULES = {
  revolution: true,
  eightCut: true,
  spadeThreeReturn: true,
  fiveskip: false,
  elevenBack: false,
  lock: false,
  cityFall: false,
  twoJokers: true,
};

function createRoom(hostId, hostNickname, hostWs, rules = {}) {
  const id = generateRoomId();
  const room = {
    id,
    hostId,
    players: [{
      id: hostId,
      nickname: hostNickname,
      ws: hostWs,
      hand: [],
      rank: null,
      passed: false,
      connected: true,
    }],
    rules: { ...DEFAULT_RULES, ...rules },
    gameState: null,
    sessionRankings: [], // 通算順位
  };
  rooms.set(id, room);
  return room;
}

function getPlayerById(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function broadcast(room, message, excludeId = null) {
  const data = JSON.stringify(message);
  for (const p of room.players) {
    if (p.connected && p.ws && p.ws.readyState === 1 && p.id !== excludeId) {
      p.ws.send(data);
    }
  }
}

function sendTo(player, message) {
  if (player.connected && player.ws && player.ws.readyState === 1) {
    player.ws.send(JSON.stringify(message));
  }
}

function buildRoomState(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
    })),
    rules: room.rules,
  };
}

function buildGameState(room) {
  const gs = room.gameState;
  return {
    type: 'game_state',
    field: gs.field,
    fieldHistory: gs.fieldHistory || [],
    fieldPlayer: gs.fieldPlayer,
    turn: gs.turn,
    revolution: gs.revolution,
    elevenBack: gs.elevenBack || false,
    passCount: gs.passCount,
    phase: gs.phase,
    lockSuit: gs.lockSuit || null,
    players: room.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      handCount: p.hand.length,
      rank: p.rank,
      passed: p.passed,
    })),
    sessionRankings: room.sessionRankings,
  };
}

function sendGameState(room) {
  const base = buildGameState(room);
  for (const p of room.players) {
    if (!p.connected) continue;
    sendTo(p, { ...base, type: 'game_state' });
    // 自分の手札を送る
    sendTo(p, { type: 'your_hand', cards: p.hand });
  }
}

// ─────────────────────────────────────────────
// ゲームロジック
// ─────────────────────────────────────────────

function startGame(room) {
  // 全プレイヤーのランク・パスをリセット
  for (const p of room.players) {
    p.hand = [];
    p.rank = null;
    p.passed = false;
  }

  const twoJokers = room.rules.twoJokers !== false;
  const deck = shuffle(createDeck(twoJokers));
  const n = room.players.length;
  deck.forEach((card, i) => {
    room.players[i % n].hand.push(card);
  });

  // ♣3を持つプレイヤーを先攻に
  let startIdx = 0;
  if (!room.gameState || room.gameState.phase === 'init') {
    // 最初のラウンド: ♣3持ちから
    const clubThreeHolder = room.players.findIndex(p =>
      p.hand.some(c => c.suit === 'clubs' && c.rank === 3)
    );
    startIdx = clubThreeHolder >= 0 ? clubThreeHolder : 0;
  } else {
    // 2ラウンド目以降: 前ラウンドの大貧民から
    const lastRound = room.sessionRankings[room.sessionRankings.length - 1];
    if (lastRound) {
      const daihinin = lastRound[lastRound.length - 1];
      const idx = room.players.findIndex(p => p.id === daihinin);
      startIdx = idx >= 0 ? idx : 0;
    }
  }

  room.gameState = {
    field: [],
    fieldHistory: [],
    fieldPlayer: null,
    fieldType: null, // 'single'|'pair'|'triple'|'quad'|'stairs'
    turn: room.players[startIdx].id,
    revolution: false,
    elevenBack: false,
    passCount: 0,
    phase: 'playing',
    lockSuit: null,
    firstPlay: true, // ♣3縛り
  };

  sendGameState(room);
}

/** カードの形式を判定 */
function detectCardType(cards) {
  if (cards.length === 0) return null;

  const nonJokers = cards.filter(c => c.rank !== 0);
  const jokerCount = cards.length - nonJokers.length;

  if (cards.length === 1) {
    return { type: 'single', rank: cards[0].rank };
  }

  // ペア・トリプル・クワッド
  if (nonJokers.length > 0) {
    const baseRank = nonJokers[0].rank;
    const allSame = nonJokers.every(c => c.rank === baseRank);
    if (allSame && jokerCount + nonJokers.length === cards.length) {
      if (cards.length === 2) return { type: 'pair', rank: baseRank };
      if (cards.length === 3) return { type: 'triple', rank: baseRank };
      if (cards.length === 4) return { type: 'quad', rank: baseRank };
    }
  } else {
    // 全部ジョーカー
    if (cards.length === 2) return { type: 'pair', rank: 0 };
    if (cards.length === 3) return { type: 'triple', rank: 0 };
    if (cards.length === 4) return { type: 'quad', rank: 0 };
  }

  // 階段（3枚以上）
  if (cards.length >= 3) {
    const stairs = detectStairs(cards);
    if (stairs) return stairs;
  }

  return null;
}

function detectStairs(cards) {
  const nonJokers = cards.filter(c => c.rank !== 0);
  const jokerCount = cards.length - nonJokers.length;

  // 階段の強さ順（3〜2の順）
  const stairOrder = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 2];

  const sortedRanks = nonJokers
    .map(c => stairOrder.indexOf(c.rank))
    .sort((a, b) => a - b);

  if (sortedRanks.length === 0) return null;

  // ジョーカーで穴埋め可能な連続かチェック
  const minIdx = sortedRanks[0];
  let jokersNeeded = 0;
  let prev = minIdx - 1;
  for (const idx of sortedRanks) {
    const gap = idx - prev - 1;
    jokersNeeded += gap;
    prev = idx;
  }

  if (jokersNeeded <= jokerCount) {
    const maxIdx = sortedRanks[sortedRanks.length - 1] + (jokerCount - jokersNeeded);
    const topRank = stairOrder[maxIdx] || stairOrder[sortedRanks[sortedRanks.length - 1]];
    return {
      type: 'stairs',
      length: cards.length,
      topRank,
      minIdx,
    };
  }

  return null;
}

/** カードが場より強いか判定 */
function isStronger(playCards, fieldCards, revolution, elevenBack) {
  if (fieldCards.length === 0) return true;
  if (playCards.length !== fieldCards.length) return false;

  const playType = detectCardType(playCards);
  const fieldType = detectCardType(fieldCards);

  if (!playType || !fieldType) return false;
  if (playType.type !== fieldType.type) {
    // 階段は枚数一致が必要
    if (playType.type === 'stairs' && fieldType.type === 'stairs') {
      if (playType.length !== fieldType.length) return false;
    } else {
      return false;
    }
  }

  // ジョーカー単体は最強（単出しのみ）
  if (playType.type === 'single' && playCards[0].rank === 0) return true;

  const effectiveRevolution = revolution !== elevenBack; // 11バックはトグル

  if (playType.type === 'stairs') {
    const playStr = cardStrength(playType.topRank, effectiveRevolution);
    const fieldStr = cardStrength(fieldType.topRank, effectiveRevolution);
    return playStr > fieldStr;
  }

  const playStr = cardStrength(playType.rank, effectiveRevolution);
  const fieldStr = cardStrength(fieldType.rank, effectiveRevolution);
  return playStr > fieldStr;
}

/** 縛りチェック */
function checkLock(playCards, gs) {
  if (!gs.lockSuit) return true;
  const nonJokers = playCards.filter(c => c.rank !== 0);
  return nonJokers.every(c => c.suit === gs.lockSuit);
}

/** 次のアクティブプレイヤーのIDを取得（上がっていないプレイヤー） */
function getNextActivePlayer(room, currentId) {
  const players = room.players;
  const n = players.length;
  const currentIdx = players.findIndex(p => p.id === currentId);
  for (let i = 1; i < n; i++) {
    const p = players[(currentIdx + i) % n];
    if (p.rank === null) return p.id; // まだ上がっていないプレイヤー
  }
  return null;
}

/** 次のアクティブかつ未パスプレイヤーのIDを取得 */
function getNextNotPassedPlayer(room, currentId) {
  const players = room.players;
  const n = players.length;
  const currentIdx = players.findIndex(p => p.id === currentId);
  for (let i = 1; i < n; i++) {
    const p = players[(currentIdx + i) % n];
    if (p.rank === null && !p.passed) return p.id;
  }
  return null;
}

/** アクティブ（未上がり）プレイヤー数 */
function activePlayerCount(room) {
  return room.players.filter(p => p.rank === null).length;
}

/** アクティブかつパスしていないプレイヤー数 */
function notPassedCount(room) {
  return room.players.filter(p => p.rank === null && !p.passed).length;
}

/** 次のラウンドまたは新しいゲームのカード交換処理 */
function startExchangePhase(room) {
  const n = room.players.length;
  room.gameState.phase = 'exchange';

  const rankings = room.players
    .slice()
    .sort((a, b) => a.rank - b.rank);

  // 交換ペアを決定
  const exchanges = [];
  if (n >= 4) {
    // 大富豪 ⇔ 大貧民: 2枚
    exchanges.push({ from: rankings[n - 1].id, to: rankings[0].id, count: 2 });
    // 富豪 ⇔ 貧民: 1枚
    exchanges.push({ from: rankings[n - 2].id, to: rankings[1].id, count: 1 });
  } else if (n === 3) {
    // 大富豪 ⇔ 大貧民: 1枚
    exchanges.push({ from: rankings[n - 1].id, to: rankings[0].id, count: 1 });
  }
  // 2人: 交換なし

  room.gameState.exchanges = exchanges;
  room.gameState.exchangeDone = [];

  if (exchanges.length === 0) {
    // 交換不要 → 即次ラウンド通知
    sendRoundEnd(room);
    return;
  }

  // 各交換の「渡す側」に交換要求を送る
  for (const ex of exchanges) {
    const fromPlayer = getPlayerById(room, ex.from);
    if (fromPlayer) {
      // 最強カード順で並び替えて送る
      const sortedHand = [...fromPlayer.hand].sort((a, b) =>
        cardStrength(b.rank) - cardStrength(a.rank)
      );
      sendTo(fromPlayer, {
        type: 'exchange_request',
        give: ex.count,
        toId: ex.to,
        hand: sortedHand,
      });
    }
  }

  sendRoundEnd(room);
}

function sendRoundEnd(room) {
  const rankings = room.players
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map(p => ({
      id: p.id,
      nickname: p.nickname,
      rank: p.rank,
    }));

  // 通算スコアに追加
  room.sessionRankings.push(rankings.map(r => r.id));

  const gs = room.gameState;
  broadcast(room, {
    type: 'round_end',
    rankings,
    phase: gs.phase,
    exchanges: gs.exchanges || [],
    sessionRankings: room.sessionRankings,
  });
}

/** プレイヤーのカードを手札から削除 */
function removeCards(player, cards) {
  const keys = cards.map(cardKey);
  const usedKeys = new Set();

  // ジョーカーのカード削除（複数枚対応）
  player.hand = player.hand.filter(c => {
    const k = cardKey(c);
    if (keys.includes(k) && !usedKeys.has(k + '_' + usedKeys.size)) {
      // ジョーカーは同じキーが複数ある
      const idx = keys.indexOf(k);
      if (idx !== -1) {
        keys.splice(idx, 1);
        return false;
      }
    }
    return true;
  });
}

/** カードの出し処理 */
function processPlay(room, player, cards) {
  const gs = room.gameState;

  // ♣3縛り（最初の出し）
  if (gs.firstPlay) {
    const hasClub3 = cards.some(c => c.suit === 'clubs' && c.rank === 3);
    if (!hasClub3) {
      sendTo(player, { type: 'action_result', success: false, message: '最初のターンは♣3を含む手札で出してください' });
      return;
    }
    gs.firstPlay = false;
  }

  // カード形式チェック
  const cardType = detectCardType(cards);
  if (!cardType) {
    sendTo(player, { type: 'action_result', success: false, message: '出せないカードの組み合わせです' });
    return;
  }

  // 場との比較
  if (gs.field.length > 0) {
    if (!isStronger(cards, gs.field, gs.revolution, gs.elevenBack)) {
      sendTo(player, { type: 'action_result', success: false, message: '場のカードより強いカードを出してください' });
      return;
    }
    // 縛りチェック
    if (!checkLock(cards, gs)) {
      sendTo(player, { type: 'action_result', success: false, message: `${gs.lockSuit}縛りです` });
      return;
    }
  }

  // 上がれない条件チェック（手札最後の1枚がジョーカー単体）
  if (player.hand.length === cards.length && cards.length === 1 && cards[0].rank === 0) {
    // ジョーカー単体上がり禁止（8切りでない場合）
    const isEightCut = cards.some(c => c.rank === 8) && room.rules.eightCut;
    if (!isEightCut) {
      sendTo(player, { type: 'action_result', success: false, message: 'ジョーカー単体では上がれません' });
      return;
    }
  }

  // カードを手札から除去
  removeCardsFromHand(player, cards);

  // 場を更新
  gs.field = cards;
  gs.fieldHistory = gs.fieldHistory || [];
  gs.fieldHistory.push({ player: player.id, cards });
  gs.fieldPlayer = player.id;

  // パスカウントリセット・全員のpassedリセット
  gs.passCount = 0;
  for (const p of room.players) {
    p.passed = false;
  }

  sendTo(player, { type: 'action_result', success: true, message: 'カードを出しました' });

  // ─ 特殊ルール判定 ─

  // スペ3返し判定（ジョーカー単体出し）
  if (cards.length === 1 && cards[0].rank === 0 && room.rules.spadeThreeReturn) {
    // 他プレイヤーに♠3を持っているか確認
    gs.awaitingSpadeThree = true;
    gs.spadeThreeDeadline = Date.now() + 5000; // 5秒待つ
    sendGameState(room);

    // 全プレイヤーに「♠3返し可能」通知
    broadcast(room, {
      type: 'spade_three_chance',
      fromId: player.id,
    });
    // 5秒後に自動で次へ
    setTimeout(() => {
      if (gs.awaitingSpadeThree && room.gameState === gs) {
        gs.awaitingSpadeThree = false;
        afterPlay(room, player, cards, cardType);
      }
    }, 5000);
    return;
  }

  afterPlay(room, player, cards, cardType);
}

function removeCardsFromHand(player, cards) {
  // カードを手札から削除（ジョーカー重複対応）
  const remaining = [...player.hand];
  for (const card of cards) {
    const idx = remaining.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  player.hand = remaining;
}

function afterPlay(room, player, cards, cardType) {
  const gs = room.gameState;
  let extraTurn = false; // 出したプレイヤーが続けて出せるか

  // 革命判定
  if (cardType.type === 'quad' && room.rules.revolution) {
    gs.revolution = !gs.revolution;
    broadcast(room, { type: 'revolution', state: gs.revolution });
  }

  // 11バック（Jで一時逆転）
  // ★修正: hasJack変数を先に宣言しておく
  const hasJack = cards.some(c => c.rank === 11);
  if (hasJack && room.rules.elevenBack) {
    gs.elevenBack = !gs.elevenBack;
    broadcast(room, { type: 'eleven_back', state: gs.elevenBack });
  }

  // 8切り
  const hasEight = cards.some(c => c.rank === 8);
  if (hasEight && room.rules.eightCut) {
    gs.field = [];
    gs.fieldHistory = [];
    gs.fieldPlayer = null;
    gs.lockSuit = null;
    gs.elevenBack = false; // 8切り時は11バックも解除
    for (const p of room.players) p.passed = false;
    extraTurn = true; // 出したプレイヤーが再度出す
    broadcast(room, { type: 'eight_cut', playerId: player.id });
  }

  // 縛り設定（★修正: 2回連続同一スートで縛り発動）
  if (!extraTurn && gs.field.length > 0 && room.rules.lock) {
    const nonJokers = cards.filter(c => c.rank !== 0);
    if (nonJokers.length > 0) {
      const allSameSuit = nonJokers.every(c => c.suit === nonJokers[0].suit);
      if (allSameSuit) {
        const thisSuit = nonJokers[0].suit;
        // fieldHistory の末尾2つを確認（現在のプレイはすでに追加済み）
        const history = gs.fieldHistory;
        if (history && history.length >= 2) {
          const prevPlay = history[history.length - 2];
          const prevNonJokers = prevPlay.cards.filter(c => c.rank !== 0);
          // 前回のプレイも同一スートなら縛り発動
          const prevSameSuit = prevNonJokers.length > 0 &&
            prevNonJokers.every(c => c.suit === thisSuit);
          if (prevSameSuit) {
            gs.lockSuit = thisSuit;
          } else {
            gs.lockSuit = null; // 1回目は縛りなし
          }
        } else {
          gs.lockSuit = null; // 履歴が1件以下は縛りなし
        }
      } else {
        gs.lockSuit = null; // 異なるスートが混ざっていたら縛り解除
      }
    }
  }

  // 上がり判定
  if (player.hand.length === 0) {
    const rankNum = room.players.filter(p => p.rank !== null).length + 1;
    player.rank = rankNum;

    // 都落ち判定
    if (room.rules.cityFall && room.sessionRankings.length > 0) {
      const prevRound = room.sessionRankings[room.sessionRankings.length - 1];
      if (prevRound[0] === player.id && rankNum !== 1) {
        // 前ラウンドの大富豪が1位でない → 大貧民に
        player.rank = room.players.length;
        // 既に大貧民の人を繰り上げ（後で調整）
      }
    }

    broadcast(room, {
      type: 'player_ranked',
      playerId: player.id,
      rank: player.rank,
      rankName: getRankName(player.rank, room.players.length),
    });

    // 全員上がったか
    if (activePlayerCount(room) === 0 || activePlayerCount(room) <= 1) {
      // 最後の1人も自動的に最下位
      const last = room.players.find(p => p.rank === null);
      if (last) last.rank = room.players.length;
      startExchangePhase(room);
      return;
    }

    // extraTurnは上がったプレイヤーには不適用
    extraTurn = false;
  }

  // 次の手番へ
  if (extraTurn) {
    gs.turn = player.id;
  } else {
    // ★修正: パス済みプレイヤーをスキップして次のアクティブ＆未パスプレイヤーを探す
    let nextId = getNextNotPassedPlayer(room, player.id);

    // 5飛び
    if (cards.some(c => c.rank === 5) && room.rules.fiveskip) {
      nextId = getNextNotPassedPlayer(room, nextId || player.id);
    }

    gs.turn = nextId || player.id;
  }

  // ★修正: 11バックは場が流れるまで継続（手番移動時には解除しない）
  // → 8切り時のみ解除（上記の hasEight ブロックで処理済み）

  sendGameState(room);
}

function hasEight(cards) {
  return cards.some(c => c.rank === 8);
}

function getRankName(rank, total) {
  if (total <= 2) return rank === 1 ? '勝者' : '敗者';
  if (total === 3) {
    return ['大富豪', '平民', '大貧民'][rank - 1] || '平民';
  }
  if (total === 4) {
    return ['大富豪', '富豪', '貧民', '大貧民'][rank - 1] || '平民';
  }
  if (total === 5) {
    return ['大富豪', '富豪', '平民', '貧民', '大貧民'][rank - 1] || '平民';
  }
  // 6人
  return ['大富豪', '富豪', '平民', '平民', '貧民', '大貧民'][rank - 1] || '平民';
}

/** パス処理 */
function processPass(room, player) {
  const gs = room.gameState;
  player.passed = true;
  gs.passCount++;

  sendTo(player, { type: 'action_result', success: true, message: 'パスしました' });

  // 残りアクティブプレイヤー（上がっていない人）の中でパスしていない人を確認
  const active = room.players.filter(p => p.rank === null);
  const notPassed = active.filter(p => !p.passed);

  // ★修正: 全員パスした場合（場を出したプレイヤー1人だけが未パス状態で手番が戻ってくる前も含む）
  // 全員パスしたら場を流して最後に出した人からスタート
  const shouldClear = notPassed.length === 0 ||
    (notPassed.length === 1 && notPassed[0].id === gs.fieldPlayer) ||
    (active.length === 1 && gs.fieldPlayer !== null);

  if (shouldClear) {
    // 場を流す前に最後に出したプレイヤーIDを保存
    const lastFieldPlayer = gs.fieldPlayer;

    // 場を流す
    gs.field = [];
    gs.fieldHistory = [];
    gs.fieldPlayer = null;
    gs.lockSuit = null;
    gs.elevenBack = false; // 場が流れたら11バック解除
    gs.passCount = 0;
    for (const p of room.players) p.passed = false;

    // ★修正: 最後にカードを出したプレイヤーから再スタート（上がっていれば次へ）
    let nextStart = lastFieldPlayer;
    if (!nextStart || getPlayerById(room, nextStart)?.rank !== null) {
      // 上がっていた場合は次のアクティブプレイヤーへ
      nextStart = getNextActivePlayer(room, lastFieldPlayer || gs.turn);
    }
    gs.turn = nextStart || active[0]?.id;

    broadcast(room, { type: 'field_cleared', nextTurn: gs.turn });
    sendGameState(room);
    return;
  }

  // ★修正: 次のアクティブかつ未パスのプレイヤーへ
  const nextId = getNextNotPassedPlayer(room, player.id);
  gs.turn = nextId || player.id;
  sendGameState(room);
}

// ─────────────────────────────────────────────
// WebSocket ハンドラ
// ─────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);

  // クエリパラメータ除去
  filePath = filePath.split('?')[0];

  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 見つからない場合は index.html をフォールバックとして返す（SPA対応）
      const fallbackPath = path.join(__dirname, 'public', 'index.html');
      fs.readFile(fallbackPath, (errFallback, dataFallback) => {
        if (errFallback) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(dataFallback);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

/** ws接続ごとの情報 */
const wsPlayerMap = new Map(); // ws -> { playerId, roomId }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type } = msg;

    if (type === 'create') {
      handleCreate(ws, msg);
    } else if (type === 'join') {
      handleJoin(ws, msg);
    } else {
      // その他のメッセージはプレイヤーIDとルームIDが必要
      const info = wsPlayerMap.get(ws);
      if (!info) return;
      const room = rooms.get(info.roomId);
      if (!room) return;
      const player = getPlayerById(room, info.playerId);
      if (!player) return;

      if (type === 'start') handleStart(room, player);
      else if (type === 'play') handlePlay(room, player, msg);
      else if (type === 'pass') handlePass(room, player);
      else if (type === 'exchange') handleExchange(room, player, msg);
      else if (type === 'next_round') handleNextRound(room, player);
      else if (type === 'spade_three') handleSpadeThree(room, player, msg);
      else if (type === 'update_rules') handleUpdateRules(room, player, msg);
    }
  });

  ws.on('close', () => {
    const info = wsPlayerMap.get(ws);
    if (!info) return;
    wsPlayerMap.delete(ws);

    const room = rooms.get(info.roomId);
    if (!room) return;

    const player = getPlayerById(room, info.playerId);
    if (player) {
      player.connected = false;
      player.ws = null;
    }

    // 全員切断なら部屋削除
    if (room.players.every(p => !p.connected)) {
      rooms.delete(room.id);
      return;
    }

    // ホストが切断した場合、次のプレイヤーがホストに
    if (room.hostId === info.playerId) {
      const nextHost = room.players.find(p => p.connected);
      if (nextHost) {
        room.hostId = nextHost.id;
        broadcast(room, { type: 'host_changed', hostId: room.hostId });
      }
    }

    broadcast(room, {
      type: 'player_disconnected',
      playerId: info.playerId,
    });

    // ゲーム中なら手番スキップ
    if (room.gameState && room.gameState.phase === 'playing') {
      if (room.gameState.turn === info.playerId) {
        processPass(room, player);
      }
    }

    broadcast(room, { ...buildRoomState(room), type: 'room_state' });
  });
});

function handleCreate(ws, msg) {
  const { nickname, rules } = msg;
  if (!nickname || nickname.trim().length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'ニックネームを入力してください' }));
    return;
  }
  const playerId = generatePlayerId();
  const room = createRoom(playerId, nickname.trim(), ws, rules);
  wsPlayerMap.set(ws, { playerId, roomId: room.id });
  ws.send(JSON.stringify({
    ...buildRoomState(room),
    type: 'created',
    playerId,
  }));
}

function handleJoin(ws, msg) {
  const { roomId, nickname } = msg;
  if (!roomId || !nickname || nickname.trim().length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'ルームIDとニックネームを入力してください' }));
    return;
  }

  const room = rooms.get(roomId.toUpperCase());
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: '部屋が見つかりません' }));
    return;
  }

  // ゲーム中の再接続チェック
  const disconnected = room.players.find(p => !p.connected && p.nickname === nickname.trim());
  if (disconnected) {
    disconnected.ws = ws;
    disconnected.connected = true;
    wsPlayerMap.set(ws, { playerId: disconnected.id, roomId: room.id });
    ws.send(JSON.stringify({
      ...buildRoomState(room),
      type: 'rejoined',
      playerId: disconnected.id,
    }));
    if (room.gameState) {
      sendGameState(room);
    }
    broadcast(room, { type: 'player_reconnected', playerId: disconnected.id }, disconnected.id);
    return;
  }

  if (room.players.length >= 6) {
    ws.send(JSON.stringify({ type: 'error', message: '部屋が満員です（最大6人）' }));
    return;
  }
  if (room.gameState && room.gameState.phase !== 'init') {
    ws.send(JSON.stringify({ type: 'error', message: 'ゲームはすでに開始されています' }));
    return;
  }

  const playerId = generatePlayerId();
  room.players.push({
    id: playerId,
    nickname: nickname.trim(),
    ws,
    hand: [],
    rank: null,
    passed: false,
    connected: true,
  });

  wsPlayerMap.set(ws, { playerId, roomId: room.id });

  ws.send(JSON.stringify({
    ...buildRoomState(room),
    type: 'joined',
    playerId,
  }));

  // 他の参加者に通知
  broadcast(room, { ...buildRoomState(room), type: 'room_state' }, playerId);
}

function handleStart(room, player) {
  if (room.hostId !== player.id) {
    sendTo(player, { type: 'error', message: 'ホストのみゲームを開始できます' });
    return;
  }
  const connectedCount = room.players.filter(p => p.connected).length;
  if (connectedCount < 2) {
    sendTo(player, { type: 'error', message: '2人以上必要です' });
    return;
  }

  startGame(room);
}

function handlePlay(room, player, msg) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;
  if (gs.turn !== player.id) {
    sendTo(player, { type: 'action_result', success: false, message: 'あなたの手番ではありません' });
    return;
  }

  const { cards } = msg;
  if (!Array.isArray(cards) || cards.length === 0) {
    sendTo(player, { type: 'action_result', success: false, message: 'カードを選択してください' });
    return;
  }

  // 手札に含まれるか確認
  const hand = [...player.hand];
  for (const card of cards) {
    const idx = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (idx === -1) {
      sendTo(player, { type: 'action_result', success: false, message: '手札にないカードです' });
      return;
    }
    hand.splice(idx, 1);
  }

  processPlay(room, player, cards);
}

function handlePass(room, player) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'playing') return;
  if (gs.turn !== player.id) {
    sendTo(player, { type: 'action_result', success: false, message: 'あなたの手番ではありません' });
    return;
  }
  if (gs.field.length === 0) {
    sendTo(player, { type: 'action_result', success: false, message: '場にカードがない場合はパスできません' });
    return;
  }
  processPass(room, player);
}

function handleExchange(room, player, msg) {
  const gs = room.gameState;
  if (!gs || gs.phase !== 'exchange') return;

  const { cards } = msg;
  if (!Array.isArray(cards)) return;

  // この人が交換すべきかチェック
  const ex = gs.exchanges?.find(e => e.from === player.id);
  if (!ex) {
    sendTo(player, { type: 'action_result', success: false, message: '交換の必要はありません' });
    return;
  }
  if (cards.length !== ex.count) {
    sendTo(player, { type: 'action_result', success: false, message: `${ex.count}枚選択してください` });
    return;
  }

  // カードを相手に渡す
  const toPlayer = getPlayerById(room, ex.to);
  if (!toPlayer) return;

  // 渡す人の手札から削除
  removeCardsFromHand(player, cards);
  // 渡される人の手札に追加（相手の最強カードを渡す人が受け取る）
  const toTopCards = [...toPlayer.hand]
    .sort((a, b) => cardStrength(b.rank) - cardStrength(a.rank))
    .slice(0, ex.count);
  removeCardsFromHand(toPlayer, toTopCards);
  toPlayer.hand.push(...cards);
  player.hand.push(...toTopCards);

  gs.exchangeDone = gs.exchangeDone || [];
  gs.exchangeDone.push(player.id);

  sendTo(player, { type: 'action_result', success: true, message: 'カード交換完了' });
  sendTo(player, { type: 'your_hand', cards: player.hand });
  sendTo(toPlayer, { type: 'your_hand', cards: toPlayer.hand });

  // 全交換完了チェック
  if (gs.exchangeDone.length >= gs.exchanges.length) {
    gs.phase = 'ready';
    broadcast(room, { type: 'exchange_complete' });
  }
}

function handleNextRound(room, player) {
  if (room.hostId !== player.id) {
    sendTo(player, { type: 'error', message: 'ホストのみ次のラウンドを開始できます' });
    return;
  }
  // 既存の gameState を引き継いでラウンド開始
  const prevState = room.gameState;
  room.gameState = { phase: 'init' }; // 一時的にinitにしてstartGameの分岐を制御
  if (prevState) room.gameState.prevRound = prevState;
  startGame(room);
}

function handleSpadeThree(room, player, msg) {
  const gs = room.gameState;
  if (!gs || !gs.awaitingSpadeThree) return;

  // ♠3を持っているか確認
  const spadeThree = player.hand.find(c => c.suit === 'spades' && c.rank === 3);
  if (!spadeThree) {
    sendTo(player, { type: 'action_result', success: false, message: '♠3を持っていません' });
    return;
  }

  gs.awaitingSpadeThree = false;

  // ♠3を手札から削除
  removeCardsFromHand(player, [spadeThree]);

  // ジョーカーを出した人に♠3を返す（手札に追加）
  const jokerPlayer = getPlayerById(room, gs.fieldPlayer);
  if (jokerPlayer) {
    const jokerCard = gs.field.find(c => c.rank === 0);
    if (jokerCard) {
      jokerPlayer.hand.push(jokerCard); // ジョーカーを返す
    }
    removeCardsFromHand(jokerPlayer, gs.field); // 念のため場のカードを整理
  }

  // 場を流す（♠3を出したプレイヤーが先攻）
  gs.field = [];
  gs.fieldHistory = [];
  gs.fieldPlayer = null;
  gs.lockSuit = null;
  gs.turn = player.id;
  for (const p of room.players) p.passed = false;

  broadcast(room, {
    type: 'spade_three_used',
    playerId: player.id,
  });

  sendGameState(room);
}

function handleUpdateRules(room, player, msg) {
  if (room.hostId !== player.id) return;
  if (room.gameState) return; // ゲーム中は変更不可
  room.rules = { ...DEFAULT_RULES, ...msg.rules };
  broadcast(room, { ...buildRoomState(room), type: 'room_state' });
}

// ─────────────────────────────────────────────
// サーバー起動
// ─────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🃏 大富豪サーバー起動中: http://localhost:${PORT}`);
});
