import { WebSocket } from 'ws';
import { Room } from './Room.ts';
import { createAppHttpServer } from './httpServer.ts';
import { setupWebSocketServer, type RoomsManager } from './wsServer.ts';
import { asSeqNumber, type RoomId } from '@space-game/shared/types';
import { encodeInputBinary } from '@space-game/shared/protocol';

const CLIENT_COUNTS = [8, 32, 64, 128];
const TICKS_PER_STAGE = 45;

async function runStage(clientCount: number): Promise<{ clients: number; avgTickMs: number; p95TickMs: number; maxTickMs: number }> {
  const rooms = new Map<RoomId, Room>();
  const tickDurations: number[] = [];

  const manager: RoomsManager = {
    getOrCreateRoom(id) {
      let r = rooms.get(id);
      if (!r) {
        r = new Room(id);
        const origStep = (r as unknown as { stepSimulation: () => void }).stepSimulation.bind(r);
        (r as unknown as { stepSimulation: () => void }).stepSimulation = () => {
          const t0 = performance.now();
          origStep();
          tickDurations.push(performance.now() - t0);
        };
        rooms.set(id, r);
      }
      return r;
    },
    listRooms: () => [], shutdownAll: async () => {},
    closeAll: async () => {
      for (const r of rooms.values()) await r.close();
      rooms.clear();
    }
  };

  const httpServer = createAppHttpServer(manager, '.');
  const wss = setupWebSocketServer(httpServer, manager);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const sockets: WebSocket[] = [];
  for (let i = 0; i < clientCount; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ type: 'join', roomId: 'load-arena', nickname: `Bot_${i}` }));
    sockets.push(ws);
  }

  let seq = 0;
  const inputTimer = setInterval(() => {
    seq++;
    for (let i = 0; i < sockets.length; i++) {
      const ws = sockets[i];
      if (!ws || ws.readyState !== 1) continue;
      const buf = encodeInputBinary({
        seq: asSeqNumber(seq),
        left: (seq + i) % 5 === 0,
        right: (seq + i) % 7 === 0,
        thrust: true,
        fire: (seq + i) % 10 === 0
      });
      ws.send(buf);
    }
  }, 1000 / 30);

  await new Promise((r) => setTimeout(r, TICKS_PER_STAGE * (1000 / 30)));
  clearInterval(inputTimer);

  for (const ws of sockets) {
    ws.close(1000);
  }
  wss.close();
  await manager.closeAll();
  httpServer.close();

  const sorted = [...tickDurations].sort((a, b) => a - b);
  const avg = sorted.reduce((acc, v) => acc + v, 0) / Math.max(1, sorted.length);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;

  return {
    clients: clientCount,
    avgTickMs: Number(avg.toFixed(3)),
    p95TickMs: Number(p95.toFixed(3)),
    maxTickMs: Number(max.toFixed(3))
  };
}

async function main(): Promise<void> {
  console.log('=== Server Headless Load Benchmark (30 TPS budget = 33.33 ms) ===');
  for (const count of CLIENT_COUNTS) {
    const res = await runStage(count);
    console.log(
      `Clients: ${String(res.clients).padStart(3)} | avg tick: ${res.avgTickMs.toFixed(3)} ms | p95 tick: ${res.p95TickMs.toFixed(3)} ms | max tick: ${res.maxTickMs.toFixed(3)} ms | status: ${res.p95TickMs > 33.33 ? 'OVER BUDGET (>33ms)' : 'OK'}`
    );
  }
}

void main();