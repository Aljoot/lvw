const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function main() {
  const db = await open({
    filename: 'game.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_offset TEXT UNIQUE,
        room_code TEXT,
        move_data TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {}
  });

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  const rooms = {};

  function broadcastRoomStatus(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('room-status', {
      lavaConnected: !!room.lavaSocketId,
      waterConnected: !!room.waterSocketId
    });
  }

  io.on('connection', async (socket) => {
    console.log('a user connected');

    socket.on('join-game', async (roomCode) => {
      socket.join(roomCode);
      console.log(`User joined room: ${roomCode}`);

      if (!rooms[roomCode]) {
        rooms[roomCode] = { 
          currentPlayer: 1, 
          lavaSocketId: null, 
          waterSocketId: null 
        };
      }

      const room = rooms[roomCode];
      let assignedRole = 'spectator';

      if (socket.id === room.lavaSocketId) {
        assignedRole = 'lava';
      } else if (socket.id === room.waterSocketId) {
        assignedRole = 'water';
      } else {
        const openSlots = [];
        if (!room.lavaSocketId) openSlots.push('lava');
        if (!room.waterSocketId) openSlots.push('water');

        if (openSlots.length > 0) {
          assignedRole = openSlots.length === 1 ? openSlots[0] : (Math.random() < 0.5 ? 'lava' : 'water');
          
          if (assignedRole === 'lava') room.lavaSocketId = socket.id;
          else room.waterSocketId = socket.id;
        }
      }

      socket.data.roomCode = roomCode;
      socket.emit('role-assigned', assignedRole);
      
      broadcastRoomStatus(roomCode);

      if (!socket.recovered) {
        try {
          await db.each(
            'SELECT id, move_data FROM moves WHERE id > ? AND room_code = ?',
            [socket.handshake.auth.serverOffset || 0, roomCode],
            (_err, row) => {
              const moveData = JSON.parse(row.move_data);
              socket.emit('opponent-move', moveData, row.id);
            }
          );
        } catch (e) {
          console.error('Recovery failed:', e);
        }
      }
    });

    socket.on('player-move', async ({ roomCode, moveData, clientOffset }, callback) => {
      const room = rooms[roomCode];
      
      if (!room || !room.lavaSocketId || !room.waterSocketId) {
          if (typeof callback === 'function') callback();
          return;
      }

      let result;
      try {
        result = await db.run(
          'INSERT INTO moves (room_code, move_data, client_offset) VALUES (?, ?, ?)',
          roomCode,
          JSON.stringify(moveData),
          clientOffset
        );
      } catch (e) {
        if (e.errno === 19 && typeof callback === 'function') {
          callback();
        }
        return;
      }
      
      room.currentPlayer = room.currentPlayer === 1 ? 2 : 1;

      socket.to(roomCode).emit('opponent-move', moveData, result.lastID);
      if (typeof callback === 'function') {
        callback();
      }
    });

    socket.on('disconnect', () => {
      console.log('user disconnected');
      const roomCode = socket.data.roomCode;
      if (roomCode && rooms[roomCode]) {
        const room = rooms[roomCode];
        
        if (room.lavaSocketId === socket.id) room.lavaSocketId = null;
        if (room.waterSocketId === socket.id) room.waterSocketId = null;
        
        broadcastRoomStatus(roomCode);
      }
    });
  });
    
  server.listen(3000, () => {
    console.log('server running at http://localhost:3000');
  });
}

main();