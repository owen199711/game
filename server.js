const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.IO 允许跨域（部署时需要）
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // 连接超时设长一点，避免弱网环境断开
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(__dirname));

// 根路径重定向到游戏页面
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/witch-game.html');
});

// ===== 游戏房间管理 =====
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // 创建房间
  socket.on('create_room', () => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);
    rooms[code] = {
      players: [socket.id],
      state: 'waiting', // waiting | p1_setup | p2_setup | playing | gameover
      poisonP1: -1,
      poisonP2: -1,
      currentPlayer: 0,
      eaten: [],
      foods: [],
      winner: 0,
    };
    socket.join(code);
    socket.emit('room_created', { code, playerIndex: 1 });
    socket.currentRoom = code;
    console.log(`[创建房间] ${code} by ${socket.id}`);
  });

  // 加入房间
  socket.on('join_room', (code) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', '房间不存在');
    if (room.players.length >= 2) return socket.emit('error_msg', '房间已满');
    if (room.state !== 'waiting') return socket.emit('error_msg', '游戏已开始');

    room.players.push(socket.id);
    socket.join(code);
    socket.currentRoom = code;
    const playerIndex = room.players.length; // 1 or 2
    socket.emit('room_joined', { code, playerIndex });

    // 通知房主有玩家加入
    io.to(room.players[0]).emit('player_joined');

    console.log(`[加入房间] ${code} by ${socket.id}`);
  });

  // 开始游戏（房主触发）
  socket.on('start_game', () => {
    const room = getRoom(socket);
    const c = socket.currentRoom;
    if (!room || !c) return;
    if (room.players[0] !== socket.id) return;

    // 打乱食材
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
    });
  });

  // 下毒
  socket.on('set_poison', (idx) => {
    const room = getRoom(socket);
    const c = socket.currentRoom;
    if (!room || !c) return;
    const playerIdx = room.players.indexOf(socket.id) + 1; // 1 or 2

    if (room.state === 'p1_setup' && playerIdx === 1) {
      room.poisonP1 = idx;
      room.state = 'p2_setup';
      io.to(c).emit('poison_set', { state: room.state, currentPlayer: 2 });
      // 通知 P1 已确认
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
      });
      io.to(room.players[1]).emit('poison_confirmed', { player: 2 });
    }
  });

  // 吃食材
  socket.on('eat_food', (idx) => {
    const room = getRoom(socket);
    const c = socket.currentRoom;
    if (!room || !c) return;
    const playerIdx = room.players.indexOf(socket.id) + 1;
    if (room.state !== 'playing') return;
    if (playerIdx !== room.currentPlayer) return;
    if (room.eaten.includes(idx)) return;

    room.eaten.push(idx);

    // 检查是否中毒（吃到对方的毒药）
    const opponentPoison = room.currentPlayer === 1 ? room.poisonP2 : room.poisonP1;
    let isPoisoned = (idx === opponentPoison);

    if (isPoisoned) {
      room.winner = room.currentPlayer === 1 ? 2 : 1;
      room.state = 'gameover';
      io.to(c).emit('game_over', {
        winner: room.winner,
        loser: room.currentPlayer,
        eatenIdx: idx,
        poisonP1: room.poisonP1,
        poisonP2: room.poisonP2,
        eaten: room.eaten,
      });
    } else if (room.eaten.length >= 25) {
      room.state = 'gameover';
      room.winner = 0; // 平局
      io.to(c).emit('game_over', {
        winner: 0,
        eaten: room.eaten,
        poisonP1: room.poisonP1,
        poisonP2: room.poisonP2,
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

  // 断开连接
  socket.on('disconnect', () => {
    const code = socket.currentRoom;
    if (code && rooms[code]) {
      io.to(code).emit('opponent_left');
      delete rooms[code];
      console.log(`[销毁房间] ${code}`);
    }
    console.log(`[断开] ${socket.id}`);
  });

  function getRoom(socket) {
    const code = socket.currentRoom;
    if (!code || !rooms[code]) return null;
    return rooms[code];
  }
});

// 启动服务器
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
