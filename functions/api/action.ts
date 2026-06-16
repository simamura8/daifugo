import { triggerPusherEvent } from "./pusherHelper";
import {
  generateRoomId, generatePlayerId, DEFAULT_RULES,
  buildGameState, buildRoomState, startGame,
  processPlay, processPass, removeCardsFromHand,
  cardStrength, getPlayerById
} from "./gameLogic";

export async function onRequestPost(context: any) {
  const env = context.env;
  const req = context.request;
  const body: any = await req.json();

  const { type, roomId, playerId, nickname, rules, cards } = body;

  if (type === 'create') {
    if (!nickname) return new Response("Missing nickname", { status: 400 });
    const newRoomId = generateRoomId();
    const newPlayerId = generatePlayerId();
    const room = {
      id: newRoomId,
      hostId: newPlayerId,
      players: [{
        id: newPlayerId,
        nickname: nickname,
        hand: [],
        rank: null,
        passed: false,
        connected: true,
      }],
      rules: { ...DEFAULT_RULES, ...rules },
      gameState: null,
      sessionRankings: [],
    };
    await env.DB.prepare("INSERT INTO rooms (id, state) VALUES (?, ?)").bind(newRoomId, JSON.stringify(room)).run();
    return new Response(JSON.stringify({
      ...buildRoomState(room),
      type: 'created',
      playerId: newPlayerId,
      roomId: newRoomId
    }));
  }

  if (!roomId) return new Response("Missing roomId", { status: 400 });
  const row = await env.DB.prepare("SELECT state FROM rooms WHERE id = ?").bind(roomId.toUpperCase()).first();
  if (!row) return new Response("Room not found", { status: 404 });

  const room = JSON.parse(row.state as string);
  let player = playerId ? getPlayerById(room, playerId) : null;
  const events: any[] = [];
  const channel = `daifugo-room-${room.id}`;

  if (type === 'join') {
    if (!nickname) return new Response("Missing nickname", { status: 400 });
    let existing = room.players.find((p:any) => p.nickname === nickname);
    if (existing) {
      existing.connected = true;
      player = existing;
      events.push({ targetId: 'all', event: { ...buildRoomState(room), type: 'room_state' }});
    } else {
      if (room.players.length >= 6) return new Response(JSON.stringify({ type: 'error', message: 'Room full' }), { status: 400 });
      const newPlayerId = generatePlayerId();
      room.players.push({
        id: newPlayerId,
        nickname: nickname,
        hand: [],
        rank: null,
        passed: false,
        connected: true,
      });
      player = room.players[room.players.length - 1];
      events.push({ targetId: 'all', event: { ...buildRoomState(room), type: 'room_state' }});
    }
  } else if (type === 'start') {
    if (room.hostId !== player.id) return new Response(JSON.stringify({ type: 'error', message: 'Not host' }), { status: 400 });
    startGame(room);
    events.push({ targetId: 'all', event: { ...buildGameState(room), type: 'game_state' }});
    for(const p of room.players) {
        events.push({ targetId: p.id, event: { type: 'your_hand', cards: p.hand } });
    }
  } else if (type === 'play') {
    const res = processPlay(room, player, cards, events);
    if (!res.success) return new Response(JSON.stringify(res), { status: 400 });
    events.push({ targetId: 'all', event: { ...buildGameState(room), type: 'game_state' }});
    for(const p of room.players) {
        events.push({ targetId: p.id, event: { type: 'your_hand', cards: p.hand } });
    }
  } else if (type === 'pass') {
    const res = processPass(room, player, events);
    if (!res.success) return new Response(JSON.stringify(res), { status: 400 });
    events.push({ targetId: 'all', event: { ...buildGameState(room), type: 'game_state' }});
  } else if (type === 'exchange') {
    const ex = room.gameState.exchanges?.find((e:any) => e.from === player.id);
    if (ex && cards.length === ex.count) {
      const toPlayer = getPlayerById(room, ex.to);
      removeCardsFromHand(player, cards);
      const toTopCards = [...toPlayer.hand]
        .sort((a, b) => cardStrength(b.rank) - cardStrength(a.rank))
        .slice(0, ex.count);
      removeCardsFromHand(toPlayer, toTopCards);
      toPlayer.hand.push(...cards);
      player.hand.push(...toTopCards);

      room.gameState.exchangeDone = room.gameState.exchangeDone || [];
      room.gameState.exchangeDone.push(player.id);
      
      events.push({ targetId: player.id, event: { type: 'your_hand', cards: player.hand } });
      events.push({ targetId: toPlayer.id, event: { type: 'your_hand', cards: toPlayer.hand } });
      events.push({ targetId: player.id, event: { type: 'action_result', success: true, message: 'カード交換完了' }});
      
      if (room.gameState.exchangeDone.length >= room.gameState.exchanges.length) {
        room.gameState.phase = 'ready';
        events.push({ targetId: 'all', event: { type: 'exchange_complete' } });
      }
    }
  } else if (type === 'next_round') {
    if (room.hostId === player.id) {
        const prevState = room.gameState;
        room.gameState = { phase: 'init' };
        if (prevState) room.gameState.prevRound = prevState;
        startGame(room);
        events.push({ targetId: 'all', event: { ...buildGameState(room), type: 'game_state' }});
        for(const p of room.players) {
            events.push({ targetId: p.id, event: { type: 'your_hand', cards: p.hand } });
        }
    }
  } else if (type === 'update_rules') {
    if (room.hostId === player.id && !room.gameState) {
      room.rules = { ...DEFAULT_RULES, ...rules };
      events.push({ targetId: 'all', event: { ...buildRoomState(room), type: 'room_state' }});
    }
  }

  await env.DB.prepare("UPDATE rooms SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(JSON.stringify(room), room.id).run();

  for (const e of events) {
    let evtChannel = channel;
    if (e.targetId !== 'all') {
      evtChannel = `${channel}-player-${e.targetId}`;
    }
    await triggerPusherEvent(env, evtChannel, 'state-update', e.event);
  }

  let responseData: any = { success: true };
  if (type === 'join') {
      responseData = { ...buildRoomState(room), type: 'joined', playerId: player.id };
  } else if (['play', 'pass', 'exchange', 'spade_three'].includes(type)) {
      responseData = { type: 'action_result', success: true, message: '操作成功' };
  }
  
  return new Response(JSON.stringify(responseData));
}
