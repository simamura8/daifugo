// ─────────────────────────────────────────────
// カードユーティリティ
// ─────────────────────────────────────────────

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_SYMBOL = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const RANK_DISPLAY = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 0: '🃏'
};

export function cardStrength(rank: number, revolution = false) {
  const order = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 2, 0];
  const base = order.indexOf(rank);
  if (revolution) {
    if (rank === 0) return 13;
    return 12 - base;
  }
  return base;
}

export function createDeck(twoJokers = true) {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({
        suit,
        rank,
        display: (RANK_DISPLAY as any)[rank] + (SUIT_SYMBOL as any)[suit]
      });
    }
  }
  const jokerCount = twoJokers ? 2 : 1;
  for (let i = 0; i < jokerCount; i++) {
    deck.push({ suit: 'joker', rank: 0, display: '🃏' });
  }
  return deck;
}

export function shuffle(deck: any[]) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function cardKey(card: any) {
  return `${card.suit}_${card.rank}`;
}

export function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function generatePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

export const DEFAULT_RULES = {
  revolution: true,
  eightCut: true,
  spadeThreeReturn: true,
  fiveskip: false,
  elevenBack: false,
  lock: false,
  cityFall: false,
  twoJokers: true,
  cardExchange: true,
};

export function getPlayerById(room: any, playerId: string) {
  return room.players.find((p: any) => p.id === playerId);
}

export function buildGameState(room: any) {
  const gs = room.gameState;
  if (!gs) return null;
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
    players: room.players.map((p: any) => ({
      id: p.id,
      nickname: p.nickname,
      handCount: p.hand.length,
      rank: p.rank,
      passed: p.passed,
    })),
    sessionRankings: room.sessionRankings,
  };
}

export function buildRoomState(room: any) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    players: room.players.map((p: any) => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
    })),
    rules: room.rules,
  };
}

// ─────────────────────────────────────────────
// ゲームロジック
// ─────────────────────────────────────────────

export function startGame(room: any) {
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

  let startIdx = 0;
  if (!room.gameState || room.gameState.phase === 'init') {
    const clubThreeHolder = room.players.findIndex((p: any) =>
      p.hand.some((c: any) => c.suit === 'clubs' && c.rank === 3)
    );
    startIdx = clubThreeHolder >= 0 ? clubThreeHolder : 0;
  } else {
    const lastRound = room.sessionRankings[room.sessionRankings.length - 1];
    if (lastRound) {
      const daihinin = lastRound[lastRound.length - 1];
      const idx = room.players.findIndex((p: any) => p.id === daihinin);
      startIdx = idx >= 0 ? idx : 0;
    }
  }

  room.gameState = {
    field: [],
    fieldHistory: [],
    fieldPlayer: null,
    fieldType: null,
    turn: room.players[startIdx].id,
    revolution: false,
    elevenBack: false,
    passCount: 0,
    phase: 'playing',
    lockSuit: null,
    firstPlay: true,
  };
}

export function detectCardType(cards: any[]) {
  if (cards.length === 0) return null;

  const nonJokers = cards.filter(c => c.rank !== 0);
  const jokerCount = cards.length - nonJokers.length;

  if (cards.length === 1) {
    return { type: 'single', rank: cards[0].rank };
  }

  if (nonJokers.length > 0) {
    const baseRank = nonJokers[0].rank;
    const allSame = nonJokers.every(c => c.rank === baseRank);
    if (allSame && jokerCount + nonJokers.length === cards.length) {
      if (cards.length === 2) return { type: 'pair', rank: baseRank };
      if (cards.length === 3) return { type: 'triple', rank: baseRank };
      if (cards.length === 4) return { type: 'quad', rank: baseRank };
    }
  } else {
    if (cards.length === 2) return { type: 'pair', rank: 0 };
    if (cards.length === 3) return { type: 'triple', rank: 0 };
    if (cards.length === 4) return { type: 'quad', rank: 0 };
  }

  if (cards.length >= 3) {
    const stairs = detectStairs(cards);
    if (stairs) return stairs;
  }

  return null;
}

export function detectStairs(cards: any[]) {
  const nonJokers = cards.filter(c => c.rank !== 0);
  const jokerCount = cards.length - nonJokers.length;

  const stairOrder = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 2];

  const sortedRanks = nonJokers
    .map(c => stairOrder.indexOf(c.rank))
    .sort((a, b) => a - b);

  if (sortedRanks.length === 0) return null;

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

export function isStronger(playCards: any[], fieldCards: any[], revolution: boolean, elevenBack: boolean) {
  if (fieldCards.length === 0) return true;
  if (playCards.length !== fieldCards.length) return false;

  const playType = detectCardType(playCards);
  const fieldType = detectCardType(fieldCards);

  if (!playType || !fieldType) return false;
  if (playType.type !== fieldType.type) {
    if (playType.type === 'stairs' && fieldType.type === 'stairs') {
      if (playType.length !== fieldType.length) return false;
    } else {
      return false;
    }
  }

  if (playType.type === 'single' && playCards[0].rank === 0) return true;

  // 革命状態とイレブンバック状態を確実にbooleanに変換して排他的論理和をとる。
  // 革命中(true)にイレブンバック(true)が起きると、逆転の逆転で通常状態(false)に戻り、JよりQの方が強くなります。
  const isRev = !!revolution;
  const isElv = !!elevenBack;
  const effectiveRevolution = isRev !== isElv;

  if (playType.type === 'stairs') {
    const playStr = cardStrength(playType.topRank, effectiveRevolution);
    const fieldStr = cardStrength(fieldType.topRank, effectiveRevolution);
    return playStr > fieldStr;
  }

  const playStr = cardStrength(playType.rank, effectiveRevolution);
  const fieldStr = cardStrength(fieldType.rank, effectiveRevolution);
  return playStr > fieldStr;
}

export function checkLock(playCards: any[], gs: any) {
  if (!gs.lockSuit) return true;
  const nonJokers = playCards.filter(c => c.rank !== 0);
  return nonJokers.every(c => c.suit === gs.lockSuit);
}

export function getNextActivePlayer(room: any, currentId: string) {
  const players = room.players;
  const n = players.length;
  const currentIdx = players.findIndex((p: any) => p.id === currentId);
  for (let i = 1; i < n; i++) {
    const p = players[(currentIdx + i) % n];
    if (p.rank === null) return p.id;
  }
  return null;
}

export function getNextNotPassedPlayer(room: any, currentId: string) {
  const players = room.players;
  const n = players.length;
  const currentIdx = players.findIndex((p: any) => p.id === currentId);
  for (let i = 1; i < n; i++) {
    const p = players[(currentIdx + i) % n];
    if (p.rank === null && !p.passed) return p.id;
  }
  return null;
}

export function activePlayerCount(room: any) {
  return room.players.filter((p: any) => p.rank === null).length;
}

export function startExchangePhase(room: any, events: any[]) {
  const n = room.players.length;

  if (room.rules.cardExchange === false) {
    room.gameState.phase = 'ready';
    room.gameState.exchanges = [];
    room.gameState.exchangeDone = [];
    events.push(handleRoundEnd(room));
    return;
  }

  room.gameState.phase = 'exchange';

  const rankings = room.players
    .slice()
    .sort((a: any, b: any) => a.rank - b.rank);

  const exchanges = [];
  if (n >= 4) {
    exchanges.push({ from: rankings[n - 1].id, to: rankings[0].id, count: 2 });
    exchanges.push({ from: rankings[n - 2].id, to: rankings[1].id, count: 1 });
  } else if (n === 3) {
    exchanges.push({ from: rankings[n - 1].id, to: rankings[0].id, count: 1 });
  }

  room.gameState.exchanges = exchanges;
  room.gameState.exchangeDone = [];

  if (exchanges.length === 0) {
    events.push(handleRoundEnd(room));
    return;
  }

  for (const ex of exchanges) {
    const fromPlayer = getPlayerById(room, ex.from);
    if (fromPlayer) {
      const sortedHand = [...fromPlayer.hand].sort((a, b) =>
        cardStrength(b.rank) - cardStrength(a.rank)
      );
      events.push({
        targetId: ex.from,
        event: {
          type: 'exchange_request',
          give: ex.count,
          toId: ex.to,
          hand: sortedHand,
        }
      });
    }
  }

  events.push(handleRoundEnd(room));
}

export function handleRoundEnd(room: any) {
  const rankings = room.players
    .slice()
    .sort((a: any, b: any) => a.rank - b.rank)
    .map((p: any) => ({
      id: p.id,
      nickname: p.nickname,
      rank: p.rank,
    }));

  room.sessionRankings.push(rankings.map((r: any) => r.id));

  const gs = room.gameState;
  return {
    targetId: 'all',
    event: {
      type: 'round_end',
      rankings,
      phase: gs.phase,
      exchanges: gs.exchanges || [],
      sessionRankings: room.sessionRankings,
    }
  };
}

export function processPlay(room: any, player: any, cards: any[], events: any[]) {
  const gs = room.gameState;

  if (gs.firstPlay) {
    const hasClub3 = cards.some(c => c.suit === 'clubs' && c.rank === 3);
    if (!hasClub3) {
      return { success: false, message: '最初のターンは♣3を含む手札で出してください' };
    }
    gs.firstPlay = false;
  }

  const cardType = detectCardType(cards);
  if (!cardType) {
    return { success: false, message: '出せないカードの組み合わせです' };
  }

  if (gs.field.length > 0) {
    if (!isStronger(cards, gs.field, gs.revolution, gs.elevenBack)) {
      return { success: false, message: '場のカードより強いカードを出してください' };
    }
    if (!checkLock(cards, gs)) {
      return { success: false, message: `${gs.lockSuit}縛りです` };
    }
  }

  if (player.hand.length === cards.length && cards.length === 1 && cards[0].rank === 0) {
    const isEightCut = cards.some(c => c.rank === 8) && room.rules.eightCut;
    if (!isEightCut) {
      return { success: false, message: 'ジョーカー単体では上がれません' };
    }
  }

  removeCardsFromHand(player, cards);

  gs.field = cards;
  gs.fieldHistory = gs.fieldHistory || [];
  gs.fieldHistory.push({ player: player.id, cards });
  gs.fieldPlayer = player.id;

  gs.passCount = 0;
  for (const p of room.players) {
    p.passed = false;
  }

  if (cards.length === 1 && cards[0].rank === 0 && room.rules.spadeThreeReturn) {
    gs.awaitingSpadeThree = true;
    gs.spadeThreeDeadline = Date.now() + 5000;
    
    events.push({ targetId: 'all', event: { type: 'spade_three_chance', fromId: player.id }});
    // Cloudflare functions are stateless so we cannot setTimeout. 
    // We will just let the frontend send spade_three if they want, 
    // and if they don't within 5s, frontend can just ignore, or the next player can just play to ignore it.
    // For simplicity, we just set the flag and move on.
  }

  afterPlay(room, player, cards, cardType, events);
  return { success: true, message: 'カードを出しました' };
}

export function removeCardsFromHand(player: any, cards: any[]) {
  const remaining = [...player.hand];
  for (const card of cards) {
    const idx = remaining.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  player.hand = remaining;
}

export function afterPlay(room: any, player: any, cards: any[], cardType: any, events: any[]) {
  const gs = room.gameState;
  let extraTurn = false;

  if (cardType.type === 'quad' && room.rules.revolution) {
    gs.revolution = !gs.revolution;
    events.push({ targetId: 'all', event: { type: 'revolution', state: gs.revolution } });
  }

  const hasJack = cards.some(c => c.rank === 11);
  if (hasJack && room.rules.elevenBack) {
    gs.elevenBack = !gs.elevenBack;
    events.push({ targetId: 'all', event: { type: 'eleven_back', state: gs.elevenBack } });
  }

  const hasEight = cards.some(c => c.rank === 8);
  if (hasEight && room.rules.eightCut) {
    gs.field = [];
    gs.fieldHistory = [];
    gs.fieldPlayer = null;
    gs.lockSuit = null;
    gs.elevenBack = false;
    for (const p of room.players) p.passed = false;
    extraTurn = true;
    events.push({ targetId: 'all', event: { type: 'eight_cut', playerId: player.id } });
  }

  if (!extraTurn && gs.field.length > 0 && room.rules.lock) {
    const nonJokers = cards.filter(c => c.rank !== 0);
    if (nonJokers.length > 0) {
      const allSameSuit = nonJokers.every(c => c.suit === nonJokers[0].suit);
      if (allSameSuit) {
        const thisSuit = nonJokers[0].suit;
        const history = gs.fieldHistory;
        if (history && history.length >= 2) {
          const prevPlay = history[history.length - 2];
          const prevNonJokers = prevPlay.cards.filter((c:any) => c.rank !== 0);
          const prevSameSuit = prevNonJokers.length > 0 &&
            prevNonJokers.every((c:any) => c.suit === thisSuit);
          if (prevSameSuit) {
            gs.lockSuit = thisSuit;
          } else {
            gs.lockSuit = null;
          }
        } else {
          gs.lockSuit = null;
        }
      } else {
        gs.lockSuit = null;
      }
    }
  }

  if (player.hand.length === 0) {
    const rankNum = room.players.filter((p:any) => p.rank !== null).length + 1;
    player.rank = rankNum;

    if (room.rules.cityFall && room.sessionRankings.length > 0) {
      const prevRound = room.sessionRankings[room.sessionRankings.length - 1];
      if (prevRound[0] === player.id && rankNum !== 1) {
        player.rank = room.players.length;
      }
    }

    events.push({
      targetId: 'all',
      event: {
        type: 'player_ranked',
        playerId: player.id,
        rank: player.rank,
        rankName: getRankName(player.rank, room.players.length),
      }
    });

    if (activePlayerCount(room) === 0 || activePlayerCount(room) <= 1) {
      const last = room.players.find((p:any) => p.rank === null);
      if (last) last.rank = room.players.length;
      startExchangePhase(room, events);
      return;
    }

    extraTurn = false;
  }

  if (extraTurn) {
    gs.turn = player.id;
  } else {
    let nextId = getNextNotPassedPlayer(room, player.id);
    if (cards.some(c => c.rank === 5) && room.rules.fiveskip) {
      nextId = getNextNotPassedPlayer(room, nextId || player.id);
    }
    gs.turn = nextId || player.id;
  }
}

export function getRankName(rank: number, total: number) {
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
  return ['大富豪', '富豪', '平民', '平民', '貧民', '大貧民'][rank - 1] || '平民';
}

export function processPass(room: any, player: any, events: any[]) {
  const gs = room.gameState;
  player.passed = true;
  gs.passCount++;

  const active = room.players.filter((p:any) => p.rank === null);
  const notPassed = active.filter((p:any) => !p.passed);

  const shouldClear = notPassed.length === 0 ||
    (notPassed.length === 1 && notPassed[0].id === gs.fieldPlayer) ||
    (active.length === 1 && gs.fieldPlayer !== null);

  if (shouldClear) {
    const lastFieldPlayer = gs.fieldPlayer;

    gs.field = [];
    gs.fieldHistory = [];
    gs.fieldPlayer = null;
    gs.lockSuit = null;
    gs.elevenBack = false;
    gs.passCount = 0;
    for (const p of room.players) p.passed = false;

    let nextStart = lastFieldPlayer;
    if (!nextStart || getPlayerById(room, nextStart)?.rank !== null) {
      nextStart = getNextActivePlayer(room, lastFieldPlayer || gs.turn);
    }
    gs.turn = nextStart || active[0]?.id;

    events.push({ targetId: 'all', event: { type: 'field_cleared', nextTurn: gs.turn } });
    return { success: true, message: 'パスしました' };
  }

  const nextId = getNextNotPassedPlayer(room, player.id);
  gs.turn = nextId || player.id;
  return { success: true, message: 'パスしました' };
}
