import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { Server as HttpServer } from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.ts';
import type { Room } from './Room.ts';
import { asPlayerId, assertNever, type PlayerId, type RoomId } from '@space-game/shared/types';
import { parseClientMessage } from '@space-game/shared/schemas';
import { decodeInputBinary } from '@space-game/shared/protocol';

export interface RoomsManager {
  getOrCreateRoom(roomId: RoomId): Room;
  listRooms(): Array<{ id: RoomId; name: string; playersCount: number; logFile: string }>;
  closeAll(): Promise<void>;
}

interface GameWebSocket extends WebSocket {
  id: PlayerId;
  missedPongs: number;
  currentRoom: Room | null;
  msgCount: number;
  msgWindowStart: number;
}

function rawDataToArrayBuffer(rawData: RawData): ArrayBuffer {
  if (rawData instanceof ArrayBuffer) {
    return rawData;
  }
  const buf = Array.isArray(rawData) ? Buffer.concat(rawData) : rawData;
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}

export function setupWebSocketServer(httpServer: HttpServer, roomsManager: RoomsManager): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxPayloadBytes
  });

  const pingInterval = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as GameWebSocket; // Extend ws instance with session fields
      if (ws.missedPongs >= 2) {
        ws.terminate();
        continue;
      }
      ws.missedPongs += 1;
      ws.ping();
    }
  }, config.pingIntervalMs);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', (rawWs: WebSocket) => {
    const ws = rawWs as GameWebSocket; // Extend ws instance with session fields
    ws.binaryType = 'arraybuffer';
    ws.id = asPlayerId(crypto.randomUUID().slice(0, 8));
    ws.missedPongs = 0;
    ws.currentRoom = null;
    ws.msgCount = 0;
    ws.msgWindowStart = Date.now();

    ws.on('pong', () => {
      ws.missedPongs = 0;
    });

    ws.on('error', (err: unknown) => {
      console.error(`[WS ${ws.id}] Socket error:`, err);
    });

    const joinTimer = setTimeout(() => {
      if (!ws.currentRoom && ws.readyState === 1) {
        ws.close(1008, 'Join timeout (5s)');
      }
    }, config.joinTimeoutMs);

    ws.on('message', (rawData: RawData, isBinary: boolean) => {
      const now = Date.now();
      if (now - ws.msgWindowStart >= 1000) {
        ws.msgWindowStart = now;
        ws.msgCount = 0;
      }
      ws.msgCount++;
      if (ws.msgCount > 65) {
        ws.close(1008, 'Rate limit exceeded');
        return;
      }

      if (isBinary) {
        if (!ws.currentRoom) return;
        try {
          const input = decodeInputBinary(rawDataToArrayBuffer(rawData));
          ws.currentRoom.enqueueInput(ws, input);
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : 'Invalid binary frame';
          console.warn(`[WS ${ws.id}] Binary protocol error: ${reason}`);
          ws.close(1003, reason);
        }
        return;
      }

      // Валідація вхідного текстового повідомлення через Zod (без ручних typeof перевірок)
      const parsed = parseClientMessage(rawData.toString('utf8'));
      if (!parsed.ok) {
        console.warn(`[WS ${ws.id}] Invalid message: ${parsed.reason}`);
        ws.close(1003, parsed.reason);
        return;
      }

      const msg = parsed.data;
      switch (msg.type) {
        case 'join': {
          if (ws.currentRoom) {
            ws.close(1008, 'Already in a room');
            return;
          }
          const nickname = msg.nickname && msg.nickname.length > 0 ? msg.nickname : `Player_${ws.id}`;
          const room = roomsManager.getOrCreateRoom(msg.roomId);
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
            seq: msg.seq,
            left: msg.left,
            right: msg.right,
            thrust: msg.thrust,
            fire: msg.fire,
            clientTs: msg.clientTs
          });
          break;
        }

        case 'protocol_mode': {
          if (ws.currentRoom) {
            ws.currentRoom.setProtocolMode(ws, msg.binary);
          }
          break;
        }

        case 'ping_rtt': {
          ws.send(JSON.stringify({ type: 'pong_rtt', clientTs: msg.clientTs }));
          break;
        }

        case 'chat': {
          if (!ws.currentRoom) {
            ws.close(1008, 'Must join a room before chatting');
            return;
          }
          ws.currentRoom.handleChat(ws, msg.text);
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

        default:
          assertNever(msg);
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