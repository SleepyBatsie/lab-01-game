import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomId } from '@space-game/shared/types';
import { Room } from './Room.ts';
import { createAppHttpServer, type ServerLifecycleState } from './httpServer.ts';
import { setupWebSocketServer, type RoomsManager } from './wsServer.ts';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { serverMetrics } from './metrics.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

const rooms = new Map<RoomId, Room>();
const lifecycle: ServerLifecycleState = { isShuttingDown: false };

const roomsManager: RoomsManager = {
  getOrCreateRoom(roomId: RoomId): Room | null {
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= config.MAX_ROOMS) {
        return null;
      }
      room = new Room(roomId);
      room.on('empty', (emptyRoomId) => {
        rooms.delete(emptyRoomId);
        logger.info({ roomId: emptyRoomId }, 'Room closed (empty)');
      });
      rooms.set(roomId, room);
      logger.info({ roomId }, 'Room created');
    }
    return room;
  },

  listRooms(): Array<{ readonly id: RoomId; readonly playersCount: number }> {
    const result: Array<{ readonly id: RoomId; readonly playersCount: number }> = [];
    for (const [id, room] of rooms.entries()) {
      if (room.size > 0) {
        result.push({ id, playersCount: room.size });
      }
    }
    return result;
  },

  async shutdownAll(reason = 'Server shutting down'): Promise<void> {
    const closingPromises: Array<Promise<void>> = [];
    for (const room of rooms.values()) {
      closingPromises.push(room.shutdownRoom(reason));
    }
    await Promise.all(closingPromises);
    rooms.clear();
  },

  async closeAll(): Promise<void> {
    const closingPromises: Array<Promise<void>> = [];
    for (const room of rooms.values()) {
      closingPromises.push(room.close());
    }
    await Promise.all(closingPromises);
    rooms.clear();
  }
};

const httpServer = createAppHttpServer(roomsManager, CLIENT_DIST, lifecycle);
const wss = setupWebSocketServer(httpServer, roomsManager, lifecycle);

httpServer.listen(config.PORT, '0.0.0.0', () => {
  logger.info(
    { port: config.PORT, gitSha: config.BUILD_SHA, allowedOrigins: config.ALLOWED_ORIGINS },
    'Space Arena server listening'
  );
});

async function gracefulShutdown(signal: string): Promise<void> {
  if (lifecycle.isShuttingDown) return;
  lifecycle.isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown initiated');

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 8000);
  forceExitTimer.unref();

  try {
    await roomsManager.shutdownAll(`Server ${signal}`);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    serverMetrics.stop();
    logger.info({ signal }, 'Graceful shutdown completed cleanly');
    pinoFlushAndExit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    pinoFlushAndExit(1);
  }
}

function pinoFlushAndExit(code: number): void {
  logger.flush(() => {
    process.exit(code);
  });
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — terminating process');
  pinoFlushAndExit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection — terminating process');
  pinoFlushAndExit(1);
});
if (process.platform === 'win32') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (chunk.trim() === 'SHUTDOWN') {
      void gracefulShutdown('SIGTERM');
    }
  });
}