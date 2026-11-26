import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { Room } from './Room.ts';
import { createAppHttpServer } from './httpServer.ts';
import { setupWebSocketServer, type RoomsManager } from './wsServer.ts';
import type { RoomId } from '@space-game/shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../client/dist');

const rooms = new Map<RoomId, Room>();

const roomsManager: RoomsManager = {
  getOrCreateRoom(roomId: RoomId): Room {
    let room = rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      room.on('empty', (emptyId: RoomId) => {
        rooms.delete(emptyId);
      });
      rooms.set(roomId, room);
    }
    return room;
  },
  listRooms() {
    return Array.from(rooms.values()).map((r) => r.toJSON());
  },
  async closeAll(): Promise<void> {
    await Promise.all(Array.from(rooms.values()).map((r) => r.close()));
    rooms.clear();
  }
};

const httpServer = createAppHttpServer(roomsManager, publicDir);
const wss = setupWebSocketServer(httpServer, roomsManager);

httpServer.listen(config.port, config.host, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\nReceived ${signal}, shutting down...`);
  wss.close();
  await roomsManager.closeAll();
  httpServer.close(() => process.exit(0));
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });