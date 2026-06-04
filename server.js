const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/witch-game.html');
});

// ===== 游戏房间管理 =====
const rooms = {};
const ROOM_CLEANUP_MS = 5 * 60 * 1000; // 5 分钟

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function cleanupRoom(code) {
  if (rooms[code]) {
    if (rooms[code].cleanupTimer) clearTimeout(rooms[code].cleanupTimer);
    delete rooms[code];
    console.log(`[清理房间] ${code}`);
  }
}

/** 获取客户端真实 IP（考虑代理） */
function getClientIP(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

io.on('connection', (socket) => {
  const clientIP = getClientIP(socket);
  console.log(`[连接] ${socket.id} IP=${clientIP}`);

  // ===== 创建房间 =====
  socket.on('create_room', () => {
    // 先检查这个 IP 是否已在某个房间中
    for (const code in rooms) {
      const r = rooms[code];
      const idx = r.playerIPs.indexOf(clientIP);
      if (idx >= 0 && !r.disconnected[idx]) {
        return socket.emit('error_msg', '你已经在房间 ' + code + ' 中了');
      }
    }

    let code;
    do { code = generateRoomCode(); } while (rooms[code]);
    rooms[code] = {
      players: [socket.id, null],
      playerIPs: [clientIP, null],
      disconnected: [false, false],
      scores: [{ win: 0, lose: 0 }, { win: 0, lose: 0 }],
      state: 'waiting',
      poisonP1: -1,
      poisonP2: -1,
      currentPlayer: 0,
      eaten: [],
      foods: [],
      winner: 0,
      round: 0,
      cleanupTimer: null,
    };
    socket.join(code);
    socket.currentRoom = code;
    socket.emit('room_created', { code, playerIndex: 1 });
    console.log(`[创建房间] ${code} 玩家1 IP=${clientIP}`);
  });

  // ===== 加入房间 =====
  socket.on('join_room', (code) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', '房间不存在');
    if (room.players.length < 2) return socket.emit('error_msg', '房间异常');

    // 检查第二个位置是否已被占用
    if (room.players[1] && !room.disconnected[1]) {
      return socket.emit('error_msg', '房间已满');
    }

    // 检查这个 IP 是否已经在对局中
    if (room.playerIPs[0] === clientIP) {
      // 房主自己不能加入自己的房间
      return socket.emit('error_msg', '你是房主，不能以玩家2身份加入');
    }

    room.players[1] = socket.id;
    room.playerIPs[1] = clientIP;
    room.disconnected[1] = false;

    socket.join(code);
    socket.currentRoom = code;

    socket.emit('room_joined', { code, playerIndex: 2, scores: room.scores });
    io.to(room.players[0]).emit('player_joined', { scores: room.scores });
    console.log(`[加入房间] ${code} 玩家2 IP=${clientIP}`);
  });

  // ===== IP 自动重连 =====
  socket.on('rejoin_room', (code) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('rejoin_failed', '房间已过期');

    // 查找这个 IP 在房间中的位置
    const idx = room.playerIPs.indexOf(clientIP);
    if (idx === -1) return socket.emit('rejoin_failed', 'IP 不匹配，你不是这个房间的玩家');
    if (!room.disconnected[idx]) return socket.emit('rejoin_failed', '当前玩家未断开');

    // 执行重连
    room.players[idx] = socket.id;
    room.disconnected[idx] = false;
    socket.join(code);
    socket.currentRoom = code;

    // 取消清理
    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }

    // 通知对手
    const opponentIdx = idx === 0 ? 1 : 0;
    if (room.players[opponentIdx]) {
      io.to(room.players[opponentIdx]).emit('opponent_reconnected');
    }

    const playerIndex = idx + 1;
    socket.emit('rejoin_success', {
      state: room.state,
      playerIndex,
      foods: room.foods,
      eaten: room.eaten,
      currentPlayer: room.currentPlayer,
      winner: room.winner,
      poisonP1: room.poisonP1,
      poisonP2: room.poisonP2,
      scores: room.scores,
      round: room.round,
    });

    console.log(`[重连] ${code} 玩家${playerIndex} IP=${clientIP}`);
  });

  // ===== 检查房间状态 =====
  socket.on('get_room_state', (code) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('room_state', null);
    const idx = room.playerIPs.indexOf(clientIP);
    socket.emit('room_state', {
      exists: true,
      playerCount: room.players.filter(p => p).length,
      state: room.state,
      playerIndex: idx >= 0 ? idx + 1 : 0,
      isMyTurn: idx >= 0 && room.state === 'playing' && room.currentPlayer === idx + 1,
    });
  });

  // ===== 开始游戏 =====
  socket.on('start_game', () => {
    const room = getRoom(socket);
    const c = socket.currentRoom;
    if (!room || !c) return;
    if (room.players[0] !== socket.id) return;

    const FOODS = [
      '🍎','🍊','🍋','🍇','🍓','🍑','🍒','🍌','🍉','🍈',
      '🥝','🍍','🥭','🍬','🍫','🧁','🍩','🍪','🌰','🥜',
      '🍿','🎂','🍭','🍦','🍡','🍐','🌽','🥕','🧀','🥨',
    ];
    const shuffled = [...FOODS];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    room.foods = shuffled.slice(0, 25);
    room.state = 'p1_setup';

    io.to(c).emit('game_start', {
      foods: room.foods,
      state: room.state,
      currentPlayer: 1,
      round: room.round,
      scores: room.scores,
    });
  });

  // ===== 下毒 =====
  socket.on('set_poison', (idx) => {
    const room = getRoom(socket);
    const c = socket.currentRoom;
    if (!room || !c) return;
    const playerIdx = room.players.indexOf(socket.id) + 1;

    if (room.state === 'p1_setup' && playerIdx === 1) {
      room.poisonP1 = idx;
      room.state = 'p2_setup';
      io.to(c).emit('poison_set', { state: room.state, currentPlayer: 2 });
      io.to(room.players[0]).emit('poison_confirmed', { player: 1 });
    } else if (room.state === 'p2_setup' && playerIdx === 2) {
      room.poisonP2 = idx;
      room.state = 'playing';
      room.currentPlayer = Math.random() < 0.5 ? 1 : 2;
      io.to(c).emit('poison_set', {
        state: room.state,
        currentPlayer: room.currentPlayer,
        poisonP1: room.poisonP1,
        poisonP2: room.poisonP2,
        scores: room.scores,
        round: room.round,
      });
      io.to(room.players[1]).emit('poison_confirmed', { player: 2 });
    }
  });

  // ===== 吃食材 =====
  socket.on('eat_food', (idx) => {
    const room = getRoom(socket);
    const c = socket.currentRoom;
    if (!room || !c) return;
    const playerIdx = room.players.indexOf(socket.id) + 1;
    if (room.state !== 'playing') return;
    if (playerIdx !== room.currentPlayer) return;
    if (room.eaten.includes(idx)) return;

    room.eaten.push(idx);

    const opponentPoison = room.currentPlayer === 1 ? room.poisonP2 : room.poisonP1;
    const isPoisoned = (idx === opponentPoison);

    if (isPoisoned) {
      room.winner = room.currentPlayer === 1 ? 2 : 1;
      const loser = room.currentPlayer;
      const winner = room.winner;
      // 更新积分
      room.scores[winner - 1].win++;
      room.scores[loser - 1].lose++;
      room.state = 'gameover';
      io.to(c).emit('game_over', {
        winner,
        loser,
        eatenIdx: idx,
        poisonP1: room.poisonP1,
        poisonP2: room.poisonP2,
        eaten: room.eaten,
        scores: room.scores,
        round: room.round,
      });
    } else if (room.eaten.length >= 25) {
      room.state = 'gameover';
      room.winner = 0;
      // 平局双方都记负
      room.scores[0].lose++;
      room.scores[1].lose++;
      io.to(c).emit('game_over', {
        winner: 0,
        eaten: room.eaten,
        poisonP1: room.poisonP1,
        poisonP2: room.poisonP2,
        scores: room.scores,
        round: room.round,
      });
    } else {
      room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;
      io.to(c).emit('eat_result', {
        eaten: room.eaten,
        currentPlayer: room.currentPlayer,
        eatenIdx: idx,
        isPoisoned: false,
      });
    }
  });

  // ===== 下一局 =====
  socket.on('next_round', () => {
    const room = getRoom(socket);
    const c = socket.currentRoom;
    if (!room || !c) return;
    if (room.state !== 'gameover') return;

    room.round++;
    room.poisonP1 = -1;
    room.poisonP2 = -1;
    room.eaten = [];
    room.winner = 0;
    room.currentPlayer = 0;

    // 重新打乱食材
    const FOODS = [
      '🍎','🍊','🍋','🍇','🍓','🍑','🍒','🍌','🍉','🍈',
      '🥝','🍍','🥭','🍬','🍫','🧁','🍩','🍪','🌰','🥜',
      '🍿','🎂','🍭','🍦','🍡','🍐','🌽','🥕','🧀','🥨',
    ];
    const shuffled = [...FOODS];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    room.foods = shuffled.slice(0, 25);
    room.state = 'p1_setup';

    io.to(c).emit('game_start', {
      foods: room.foods,
      state: room.state,
      currentPlayer: 1,
      round: room.round,
      scores: room.scores,
    });
  });

  // ===== 断开连接 =====
  socket.on('disconnect', () => {
    const code = socket.currentRoom;
    if (!code || !rooms[code]) {
      console.log(`[断开] ${socket.id}（无房间）`);
      return;
    }

    const room = rooms[code];
    const playerIdx = room.players.indexOf(socket.id);
    if (playerIdx === -1) {
      console.log(`[断开] ${socket.id}（不在房间列表中）`);
      return;
    }

    // 标记断开（保留 IP 和 player slot）
    room.disconnected[playerIdx] = true;
    console.log(`[断开] ${code} 玩家${playerIdx + 1} IP=${room.playerIPs[playerIdx]}`);

    // 通知对手
    const opponentIdx = playerIdx === 0 ? 1 : 0;
    if (room.players[opponentIdx]) {
      io.to(room.players[opponentIdx]).emit('opponent_disconnected');
    }

    // 所有玩家都断开 → 立即清理
    if (room.disconnected.every(d => d)) {
      cleanupRoom(code);
      return;
    }

    // 部分断开 → 5 分钟后清理（给足重连时间）
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => cleanupRoom(code), ROOM_CLEANUP_MS);
    console.log(`[房间] ${code} 将在 ${ROOM_CLEANUP_MS / 1000} 秒后清理`);
  });

  function getRoom(socket) {
    const code = socket.currentRoom;
    if (!code || !rooms[code]) return null;
    return rooms[code];
  }
});

// ===== 启动 =====
function startServer(port) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`🧙‍♀️ 女巫的毒药 服务器已启动!`);
    console.log(`   地址: http://localhost:${port}`);
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      console.log(`   公网: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`  端口 ${port} 被占用, 尝试 ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('  服务器启动失败:', e.message);
    }
  });
}

const PORT = parseInt(process.env.PORT) || 3000;
startServer(PORT);
