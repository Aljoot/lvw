const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// Lightweight server-side game engine mirror to track action economy and turns accurately
class ServerLavaAndWaterGame {
    constructor() {
        this.board = Array.from({ length: 11 }, () => Array(7).fill(0)); 
        this.LAVA = 1; 
        this.WATER = 2; 
        this.currentPlayer = this.LAVA;
        this.colMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5, 'G': 6 };
        this.revColMap = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
        this.waterSources = [{ r: 2, c: 3 }];
        this.lavaSources = [{ r: 9, c: 3 }];
        this.lavaQueenings = 0;
        this.waterQueenings = 0;
        this.movesRemaining = 1; 
        this.movesMadeInTurn = []; 
        this.turnCounter = 1;
        this.initializeMaterial();
    }

    initializeMaterial() {
        for (let r = 1; r <= 10; r++) {
            for (let c = 0; c < 7; c++) { this.board[r][c] = 0; }
        }
        for (let r = 1; r <= 3; r++) {
            for (let c = 0; c < 7; c++) { this.board[r][c] = this.WATER; }
        }
        for (let r = 8; r <= 10; r++) {
            for (let c = 0; c < 7; c++) { this.board[r][c] = this.LAVA; }
        }
        this.waterSources.forEach(s => { this.board[s.r][s.c] = this.WATER; });
        this.lavaSources.forEach(s => { this.board[s.r][s.c] = this.LAVA; });
    }
    
    getPlayerSources(playerColor) {
        return playerColor === this.LAVA ? this.lavaSources : this.waterSources;
    }
    
    isSource(r, c) {
        const pieceColor = this.board[r][c];
        if (pieceColor === 0) return false;
        return this.getPlayerSources(pieceColor).some(s => s.r === r && s.c === c);
    }
    
    getNormalPieces(color) {
        const pieces = [];
        for (let r = 1; r <= 10; r++) {
            for (let c = 0; c < 7; c++) {
                if (this.board[r][c] === color && !this.isSource(r, c)) pieces.push({ r, c });
            }
        }
        return pieces;
    }

    posToCoord(posStr) {
        const colStr = posStr[0].toUpperCase();
        const row = parseInt(posStr.substring(1));
        const col = this.colMap[colStr];
        if (isNaN(row) || col === undefined) throw new Error("Invalid format.");
        return { r: row, c: col };
    }

    getNeighbors(r, c) {
        const neighbors = [];
        for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 1 && nr <= 10 && nc >= 0 && nc <= 6) neighbors.push({ r: nr, c: nc });
        }
        return neighbors;
    }
    
    checkConnectivity(playerColor) {
        const sources = this.getPlayerSources(playerColor);
        const allNormalPieces = this.getNormalPieces(playerColor);
        if (sources.length === 0) return allNormalPieces; 
        const connected = new Set();
        const queue = [...sources];
        sources.forEach(s => connected.add(`${s.r},${s.c}`));

        while (queue.length > 0) {
            const { r, c } = queue.shift();
            for (const { r: nr, c: nc } of this.getNeighbors(r, c)) {
                const coordKey = `${nr},${nc}`;
                if (this.board[nr][nc] === playerColor && !connected.has(coordKey)) {
                    connected.add(coordKey);
                    queue.push({ r: nr, c: nc });
                }
            }
        }
        return allNormalPieces.filter(piece => !connected.has(`${piece.r},${piece.c}`));
    }

    applyCaptures(lastMoveCoord, capturingColor) {
        const { r, c } = lastMoveCoord;
        const opponentColor = (3 - capturingColor);
        const piecesToRemove = [];

        for (const { r: nr, c: nc } of this.getNeighbors(r, c)) {
            if (this.board[nr][nc] === opponentColor) {
                const dr = nr - r, dc = nc - c; 
                let r_curr = nr, c_curr = nc;
                while (r_curr >= 1 && r_curr <= 10 && c_curr >= 0 && c_curr <= 6 && this.board[r_curr][c_curr] === opponentColor) {
                    if (!this.isSource(r_curr, c_curr)) piecesToRemove.push({ r: r_curr, c: c_curr });
                    else break; 
                    r_curr += dr; c_curr += dc;
                }
            }
        }
        const uniqueKeys = new Set(piecesToRemove.map(p => `${p.r},${p.c}`));
        return Array.from(uniqueKeys).map(k => {
            const [r_coord, c_coord] = k.split(',').map(Number);
            return { r: r_coord, c: c_coord };
        });
    }

applyQueening(r, c, playerColor) {
        const isQueeningRow = playerColor === this.LAVA ? r === 1 : r === 10;
        if (isQueeningRow) {
            const sources = this.getPlayerSources(playerColor);
            if (!this.isSource(r, c)) { 
                 sources.push({ r, c });
                 if (playerColor === this.LAVA) this.lavaQueenings++;
                 else this.waterQueenings++;
                 return true;
            }
        }
        return false;
    }
    
    removeSource(color, r, c) {
        const sources = this.getPlayerSources(color);
        const index = sources.findIndex(s => s.r === r && s.c === c);
        if (index > -1) {
            sources.splice(index, 1);
            this.board[r][c] = 0;
        }
    }

    makeMove(startPosStr, endPosStr, isSwap = false) {
        if (this.movesRemaining <= 0) return;
        let r1, c1, r2, c2;
        try {
            ({ r: r1, c: c1 } = this.posToCoord(startPosStr));
            ({ r: r2, c: c2 } = this.posToCoord(endPosStr));
        } catch (e) { return; }

        const playerColor = this.currentPlayer;
        const opponentColor = (3 - playerColor);
        const pieceToMove = this.board[r1][c1];
        const isMovingSource = this.isSource(r1, c1);
        
        if (isMovingSource) {
            const sources = this.getPlayerSources(playerColor);
            const originalSourceIndex = sources.findIndex(s => s.r === r1 && s.c === c1);
            if (originalSourceIndex !== -1) sources[originalSourceIndex] = { r: r2, c: c2 };
        }
        
        if (isSwap) {
            [this.board[r1][c1], this.board[r2][c2]] = [this.board[r2][c2], this.board[r1][c1]];
            if (!isMovingSource) { 
                 const targetSourceIndex = this.getPlayerSources(playerColor).findIndex(s => s.r === r2 && s.c === c2);
                 if (targetSourceIndex !== -1) this.getPlayerSources(playerColor)[targetSourceIndex] = { r: r1, c: c1 };
            }
        } else {
            this.board[r2][c2] = pieceToMove;
            this.board[r1][c1] = 0;
        }
        
        this.applyQueening(r2, c2, playerColor);
        this.movesMadeInTurn.push({ r: r2, c: c2 });
        this.movesRemaining--;
        
        if (this.movesRemaining <= 0) {
            const allCaptured = [];
            for (const { r, c } of this.movesMadeInTurn) {
                const capturedCoords = this.applyCaptures({ r, c }, playerColor);
                allCaptured.push(...capturedCoords);
                for (const { r: nr, c: nc } of this.getNeighbors(r, c)) {
                    if (this.board[nr][nc] === opponentColor && this.isSource(nr, nc)) {
                        this.removeSource(opponentColor, nr, nc);
                        allCaptured.push({r: nr, c: nc});
                    }
                }
            }
            const uniqueCapturedCoords = Array.from(new Set(allCaptured.map(p => `${p.r},${p.c}`))).map(k => {
                const [r, c] = k.split(',').map(Number);
                return { r, c };
            });
            for (const { r, c } of uniqueCapturedCoords) this.board[r][c] = 0; 

            const playerDiscarded = this.checkConnectivity(playerColor);
            for (const { r, c } of playerDiscarded) this.board[r][c] = 0; 
            const opponentDiscarded = this.checkConnectivity(opponentColor);
            for (const { r, c } of opponentDiscarded) this.board[r][c] = 0; 

            const opponentSources = this.getPlayerSources(opponentColor);
            const opponentNormalPieces = this.getNormalPieces(opponentColor);

            if (opponentSources.length > 0 && opponentNormalPieces.length > 0) {
                this.currentPlayer = opponentColor;
                this.movesRemaining = this.getPlayerSources(opponentColor).length;
                this.movesMadeInTurn = []; 
                this.turnCounter++; 
            }
        }
    }
}

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
          game: new ServerLavaAndWaterGame(),
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
              // Replay moves into server game state on recovery
              room.game.makeMove(moveData.startPosStr, moveData.endPosStr, moveData.isSwap);
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
      
      // Update server-side game state with the verified move
      room.game.makeMove(moveData.startPosStr, moveData.endPosStr, moveData.isSwap);

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
