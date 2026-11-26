import { config } from './config.js';
import { Room } from './Room.js';
import { createHttpServer } from './httpServer.js';
import { setupWebSocketServer } from './wsServer.js';

class RoomsManager {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreateRoom(id, name) {
    if (!this.rooms.has(id)) {
      const room = new Room(id, name);
      room.on('empty', (emptyRoomId) => {
        console.log(`[RoomsManager] Видаляємо порожню кімнату: ${emptyRoomId}`);
        this.rooms.delete(emptyRoomId);
      });
      this.rooms.set(id, room);
    }
    return this.rooms.get(id);
  }

  listRooms() {
    return Array.from(this.rooms.values()).map((r) => r.toJSON());
  }

  async closeAll() {
    const closePromises = Array.from(this.rooms.values()).map((room) => room.close());
    await Promise.all(closePromises);
    this.rooms.clear();
  }
}

const roomsManager = new RoomsManager();
const httpServer = createHttpServer(roomsManager);
const wss = setupWebSocketServer(httpServer, roomsManager);

httpServer.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  console.log(`Logs directory: ${config.logDir}`);
});

// Graceful Shutdown (коректне завершення при Ctrl+C або SIGTERM)
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Shutdown] Отримано ${signal}. Закриваємо з'єднання та дописуємо логи...`);

  // 1. Закриваємо всі активні WebSocket-клієнти
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
  wss.close();

  // 2. Закриваємо всі кімнати та чекаємо завершення запису потоків логів
  await roomsManager.closeAll();

  // 3. Зупиняємо HTTP-сервер і виходимо з кодом 0
  httpServer.close(() => {
    console.log('[Shutdown] Усі ресурси звільнено. Вихід (код 0).');
    process.exit(0);
  });

  // Запобіжник на випадок завислих keep-alive HTTP-з'єднань
  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));