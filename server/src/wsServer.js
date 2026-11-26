import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { config } from './config.js';
import { decodeInputBinary } from '@space-game/shared/protocol';

export function setupWebSocketServer(httpServer, roomsManager) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxPayloadBytes
  });

  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missedPongs >= 2) {
        ws.terminate();
        continue;
      }
      ws.missedPongs = (ws.missedPongs || 0) + 1;
      ws.ping();
    }
  }, config.pingIntervalMs);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', (ws) => {
    ws.binaryType = 'arraybuffer';
    ws.id = crypto.randomUUID().slice(0, 8);
    ws.missedPongs = 0;
    ws.currentRoom = null;
    ws.msgCount = 0;
    ws.msgWindowStart = Date.now();

    ws.on('pong', () => {
      ws.missedPongs = 0;
    });

    ws.on('error', (err) => {
      console.error(`[WS ${ws.id}] Socket error:`, err.message);
    });

    const joinTimer = setTimeout(() => {
      if (!ws.currentRoom && ws.readyState === 1) {
        ws.close(1008, 'Join timeout (5s)');
      }
    }, config.joinTimeoutMs);

    ws.on('message', (rawData, isBinary) => {
      const now = Date.now();
      if (now - ws.msgWindowStart >= 1000) {
        ws.msgWindowStart = now;
        ws.msgCount = 0;
      }
      ws.msgCount++;
      if (ws.msgCount > 65) {
        return ws.close(1008, 'Rate limit exceeded');
      }

      if (isBinary) {
        if (!ws.currentRoom) return;
        try {
          const arrayBuf = rawData instanceof ArrayBuffer
            ? rawData
            : rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);
          const input = decodeInputBinary(arrayBuf);
          ws.currentRoom.enqueueInput(ws, input);
        } catch (err) {
          ws.close(1003, err.message);
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(rawData.toString('utf8'));
      } catch {
        return ws.close(1003, 'Invalid JSON');
      }

      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        return ws.close(1003, 'Malformed message shape');
      }

      switch (msg.type) {
        case 'join': {
          if (ws.currentRoom) return ws.close(1008, 'Already in a room');
          if (typeof msg.roomId !== 'string' || !msg.roomId.trim()) {
            return ws.close(1003, 'Invalid roomId');
          }

          const nickname = typeof msg.nickname === 'string' && msg.nickname.trim()
            ? msg.nickname.trim().slice(0, 20)
            : `Player_${ws.id}`;

          const room = roomsManager.getOrCreateRoom(msg.roomId.trim());
          clearTimeout(joinTimer);
          ws.currentRoom = room;

          room.addClient(ws, { id: ws.id, nickname });
          ws.send(JSON.stringify({
            type: 'joined',
            roomId: room.id,
            playerId: ws.id,
            nickname,
            players: room.getPlayersList()
          }));
          break;
        }

        case 'input': {
          if (!ws.currentRoom) return;
          ws.currentRoom.enqueueInput(ws, {
            seq: Number(msg.seq) || 0,
            left: Boolean(msg.left),
            right: Boolean(msg.right),
            thrust: Boolean(msg.thrust),
            fire: Boolean(msg.fire)
          });
          break;
        }

        case 'protocol_mode': {
          if (ws.currentRoom) {
            ws.currentRoom.setProtocolMode(ws, Boolean(msg.binary));
          }
          break;
        }

        case 'ping_rtt': {
          ws.send(JSON.stringify({ type: 'pong_rtt', clientTs: msg.clientTs }));
          break;
        }

        case 'chat': {
          if (!ws.currentRoom) return ws.close(1008, 'Must join a room before chatting');
          if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 500) {
            return ws.close(1003, 'Invalid chat text');
          }
          ws.currentRoom.handleChat(ws, msg.text.trim());
          break;
        }

        case 'leave': {
          if (ws.currentRoom) {
            ws.currentRoom.removeClient(ws);
            ws.currentRoom = null;
          }
          ws.close(1000, 'Left room');
          break;
        }

        default: {
          ws.close(1003, `Unknown message type: ${msg.type}`);
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (ws.currentRoom) {
        ws.currentRoom.removeClient(ws);
        ws.currentRoom = null;
      }
    });
  });

  return wss;
}
