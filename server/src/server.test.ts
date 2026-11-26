import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Room } from './Room.ts';
import { createAppHttpServer } from './httpServer.ts';
import { setupWebSocketServer, type RoomsManager } from './wsServer.ts';
import { asPlayerId, asRoomId, asSeqNumber, type RoomId } from '@space-game/shared/types';
import { decodeSnapshotBinary } from '@space-game/shared/protocol';

afterEach(() => {
  vi.useRealTimers();
});

function createMockSocket() {
  const sent: Array<string | ArrayBuffer> = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string | ArrayBuffer) {
      sent.push(data);
    }
  } as unknown as WebSocket;
  return { ws, sent };
}

describe('Server Room & Simulation Loop (with fake timers)', () => {
  it('adds client, assigns sequential slots, and sends init_world', async () => {
    const room = new Room(asRoomId('test-room-1'));
    const c1 = createMockSocket();
    const c2 = createMockSocket();

    room.addClient(c1.ws, { id: asPlayerId('p1'), nickname: 'Alice' });
    room.addClient(c2.ws, { id: asPlayerId('p2'), nickname: 'Bob' });

    expect(room.size).toBe(2);
    const initMsg = JSON.parse(c1.sent[0] as string);
    expect(initMsg.type).toBe('init_world');
    expect(initMsg.slot).toBe(0);

    const initMsg2 = JSON.parse(c2.sent[0] as string);
    expect(initMsg2.slot).toBe(1);

    await room.close();
  });

  it('steps simulation on fake timer ticks and broadcasts binary snapshots', async () => {
    vi.useFakeTimers();
    const room = new Room(asRoomId('timer-room'));
    const c1 = createMockSocket();
    room.addClient(c1.ws, { id: asPlayerId('p1'), nickname: 'Alice' });
    room.enqueueInput(c1.ws, {
      seq: asSeqNumber(7),
      left: false,
      right: false,
      thrust: true,
      fire: false
    });

    await vi.advanceTimersByTimeAsync(100);

    const binaryFrames = c1.sent.filter((m): m is ArrayBuffer => m instanceof ArrayBuffer);
    expect(binaryFrames.length).toBeGreaterThanOrEqual(2);

    const snap = decodeSnapshotBinary(binaryFrames[binaryFrames.length - 1]!);
    expect(snap.tick).toBeGreaterThanOrEqual(2);
    const ship = snap.entities.find((e) => e.kind === 'ship');
    expect(ship).toBeDefined();
    if (ship && ship.kind === 'ship') {
      expect(ship.lastProcessedSeq).toBe(7);
    }

    await room.close();
  });

  it('switches client protocol mode between binary and JSON', async () => {
    vi.useFakeTimers();
    const room = new Room(asRoomId('proto-room'));
    const c1 = createMockSocket();
    room.addClient(c1.ws, { id: asPlayerId('p1'), nickname: 'Alice' });
    room.setProtocolMode(c1.ws, false);

    await vi.advanceTimersByTimeAsync(50);

    const jsonSnapshots = c1.sent
      .filter((m): m is string => typeof m === 'string')
      .map((s) => JSON.parse(s))
      .filter((obj) => obj.type === 'snapshot');

    expect(jsonSnapshots.length).toBeGreaterThanOrEqual(1);
    await room.close();
  });

  it('broadcasts chat messages to room members', async () => {
    const room = new Room(asRoomId('chat-room'));
    const c1 = createMockSocket();
    const c2 = createMockSocket();
    room.addClient(c1.ws, { id: asPlayerId('p1'), nickname: 'Alice' });
    room.addClient(c2.ws, { id: asPlayerId('p2'), nickname: 'Bob' });

    room.handleChat(c1.ws, 'GG WP!');
    const lastMsg = JSON.parse(c2.sent[c2.sent.length - 1] as string);
    expect(lastMsg.type).toBe('chat');
    expect(lastMsg.text).toBe('GG WP!');
    expect(lastMsg.from).toBe('Alice');

    await room.close();
  });

  it('emits empty event when last client leaves room', async () => {
    const room = new Room(asRoomId('empty-room'));
    const c1 = createMockSocket();
    let emptiedId: RoomId | null = null;
    room.on('empty', (id) => { emptiedId = id; });

    room.addClient(c1.ws, { id: asPlayerId('p1'), nickname: 'Alice' });
    room.removeClient(c1.ws);

    await new Promise((r) => setTimeout(r, 20));
    expect(emptiedId).toBe('empty-room');
  });

  it('enforces WebSocket rate limit (>65 msg/s) and closes abusive client with code 1008', async () => {
    const rooms = new Map<RoomId, Room>();
    const manager: RoomsManager = {
      getOrCreateRoom(id) {
        let r = rooms.get(id);
        if (!r) { r = new Room(id); rooms.set(id, r); }
        return r;
      },
      listRooms: () => [],
      closeAll: async () => {
        for (const r of rooms.values()) await r.close();
      }
    };

    const httpServer = createAppHttpServer(manager, '.');
    const wss = setupWebSocketServer(httpServer, manager);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));

    const closeCode = await new Promise<number>((resolve) => {
      client.on('close', (code) => resolve(code));
      for (let i = 0; i < 75; i++) {
        client.send(JSON.stringify({ type: 'ping_rtt', clientTs: i }));
      }
    });

    expect(closeCode).toBe(1008);
    wss.close();
    await manager.closeAll();
    httpServer.close();
  });

  it('closes socket with code 1003 on malformed JSON message', async () => {
    const manager: RoomsManager = {
      getOrCreateRoom: (id) => new Room(id),
      listRooms: () => [],
      closeAll: async () => {}
    };
    const httpServer = createAppHttpServer(manager, '.');
    const wss = setupWebSocketServer(httpServer, manager);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => client.on('open', () => resolve()));

    const closeCode = await new Promise<number>((resolve) => {
      client.on('close', (code) => resolve(code));
      client.send('{not valid json');
    });

    expect(closeCode).toBe(1003);
    wss.close();
    httpServer.close();
  });
});