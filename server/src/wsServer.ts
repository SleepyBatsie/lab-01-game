import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type http from 'node:http';
import crypto from 'node:crypto';
import {
  type PlayerId,
  type RoomId,
  asPlayerId,
  asRoomId,
  asSeqNumber,
  assertNever
} from '@space-game/shared/types';
import { parseClientMessage } from '@space-game/shared/schemas';
import { decodeInputBinary } from '@space-game/shared/protocol';
import type { Room } from './Room.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { serverMetrics } from './metrics.ts';
import type { ServerLifecycleState } from './httpServer.ts';

export interface RoomsManager {
  getOrCreateRoom(roomId: RoomId): Room | null;
  listRooms(): Array<{ readonly id: RoomId; readonly playersCount: number }>;
  shutdownAll(reason?: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface GameWebSocket extends WebSocket {
  playerId: PlayerId;
  clientIp: string;
  currentRoom: Room | null;
  isAlive: boolean;
  msgCountWindow: number;
  windowStart: number;
}

export function isOriginAllowed(originHeader: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true;
  if (!originHeader) return false;
  return allowed.includes(originHeader);
}

export function setupWebSocketServer(
  httpServer: http.Server,
  roomsManager: RoomsManager,
  lifecycle: ServerLifecycleState = { isShuttingDown: false }
): WebSocketServer {
  const ipConnections = new Map<string, number>();

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 8 * 1024,
    verifyClient: (info, done) => {
      if (lifecycle.isShuttingDown) {
        done(false, 503, 'Server shutting down');
        return;
      }
      const origin = info.origin;
      if (!isOriginAllowed(origin, config.ALLOWED_ORIGINS)) {
        logger.warn({ origin }, 'Rejected WebSocket connection due to disallowed Origin');
        done(false, 403, 'Origin not allowed');
        return;
      }
      done(true);
    }
  });

  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as GameWebSocket;
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  wss.on('connection', (rawWs: WebSocket, req: http.IncomingMessage) => {
    const ws = rawWs as GameWebSocket;
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp =
      typeof forwardedFor === 'string'
        ? (forwardedFor.split(',')[0]?.trim() ?? 'unknown')
        : (req.socket.remoteAddress ?? 'unknown');

    const currentIpCount = ipConnections.get(clientIp) ?? 0;
    if (currentIpCount >= config.MAX_CONNS_PER_IP) {
      logger.warn({ clientIp, currentIpCount }, 'Rejected WebSocket connection: IP limit exceeded');
      ws.close(1008, 'Too many connections from this IP');
      return;
    }
    ipConnections.set(clientIp, currentIpCount + 1);

    ws.binaryType = 'arraybuffer';
    ws.playerId = asPlayerId(crypto.randomBytes(4).toString('hex'));
    ws.clientIp = clientIp;
    ws.currentRoom = null;
    ws.isAlive = true;
    ws.msgCountWindow = 0;
    ws.windowStart = Date.now();

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('error', (err: unknown) => {
      logger.error({ playerId: ws.playerId, err }, 'WebSocket socket error');
    });

    const joinTimeout = setTimeout(() => {
      if (!ws.currentRoom && ws.readyState === 1) {
        ws.close(1008, 'Join timeout (5s)');
      }
    }, 5000);

    ws.on('message', (rawData: RawData, isBinary: boolean) => {
      const byteLength =
        rawData instanceof ArrayBuffer
          ? rawData.byteLength
          : Array.isArray(rawData)
            ? rawData.reduce((s, b) => s + b.byteLength, 0)
            : rawData.byteLength;
      serverMetrics.recordTraffic(byteLength);

      const now = Date.now();
      if (now - ws.windowStart > 1000) {
        ws.windowStart = now;
        ws.msgCountWindow = 0;
      }
      ws.msgCountWindow += 1;
      if (ws.msgCountWindow > 65) {
        logger.warn({ playerId: ws.playerId, roomId: ws.currentRoom?.id }, 'Rate limit exceeded');
        ws.close(1008, 'Rate limit exceeded');
        return;
      }

      if (isBinary) {
        try {
          const ab =
            rawData instanceof ArrayBuffer
              ? rawData
              : Buffer.isBuffer(rawData)
                ? rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength)
                : new ArrayBuffer(0);
          const input = decodeInputBinary(ab as ArrayBuffer);
          if (ws.currentRoom) {
            ws.currentRoom.enqueueInput(ws, input);
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'Bad binary frame';
          logger.warn({ playerId: ws.playerId, reason }, 'Rejected malformed binary frame');
          ws.close(1003, reason);
        }
        return;
      }

      const textStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
      const parsed = parseClientMessage(textStr);
      if (!parsed.ok) {
        logger.warn({ playerId: ws.playerId, reason: parsed.reason }, 'Invalid JSON message');
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
          clearTimeout(joinTimeout);
          const roomId = asRoomId(msg.roomId);
          const nickname = msg.nickname && msg.nickname.length > 0 ? msg.nickname : `Pilot_${ws.playerId.slice(0, 4)}`;
          const room = roomsManager.getOrCreateRoom(roomId);
          if (!room) {
            ws.close(1013, 'Server room capacity reached');
            return;
          }
          if (room.size >= config.MAX_PLAYERS_PER_ROOM) {
            ws.close(1008, 'Room is full');
            return;
          }
          ws.currentRoom = room;
          room.addClient(ws, { id: ws.playerId, nickname });
          break;
        }

        case 'input': {
          if (ws.currentRoom) {
            ws.currentRoom.enqueueInput(ws, {
              seq: asSeqNumber(msg.seq),
              left: msg.left,
              right: msg.right,
              thrust: msg.thrust,
              fire: msg.fire
            });
          }
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
      clearTimeout(joinTimeout);
      const count = ipConnections.get(ws.clientIp) ?? 1;
      if (count <= 1) {
        ipConnections.delete(ws.clientIp);
      } else {
        ipConnections.set(ws.clientIp, count - 1);
      }

      if (ws.currentRoom) {
        ws.currentRoom.removeClient(ws);
        ws.currentRoom = null;
      }
    });
  });

  return wss;
}