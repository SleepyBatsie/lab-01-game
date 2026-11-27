import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, config } from './config.ts';
import { createAppHttpServer, type ServerLifecycleState } from './httpServer.ts';
import { setupWebSocketServer, type RoomsManager } from './wsServer.ts';
import { Room } from './Room.ts';
import { asRoomId, type RoomId } from '@space-game/shared/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Lab 08 Production Readiness, Origin, Faults & SIGTERM', () => {
  const activeServers: http.Server[] = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop()!;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    config.ALLOWED_ORIGINS = ['*'];
  });

  it('validates environment config with Zod and rejects invalid ports', () => {
    const valid = loadConfig({ PORT: '8080', ALLOWED_ORIGINS: 'https://game.example.com,http://localhost:3000' });
    expect(valid.PORT).toBe(8080);
    expect(valid.ALLOWED_ORIGINS).toEqual(['https://game.example.com', 'http://localhost:3000']);

    expect(() => loadConfig({ PORT: '99999' })).toThrow(/Invalid environment configuration/);
  });

  it('exposes /health, /ready (200 vs 503 on shutdown) and /metrics', async () => {
    const lifecycle: ServerLifecycleState = { isShuttingDown: false };
    const rooms = new Map<RoomId, Room>();
    const manager: RoomsManager = {
      getOrCreateRoom: (id) => {
        let r = rooms.get(id);
        if (!r) {
          r = new Room(id);
          rooms.set(id, r);
        }
        return r;
      },
      listRooms: () => Array.from(rooms.entries()).map(([id, r]) => ({ id, playersCount: r.size })),
      shutdownAll: async () => {
        for (const r of rooms.values()) await r.shutdownRoom();
        rooms.clear();
      },
      closeAll: async () => {
        for (const r of rooms.values()) await r.close();
        rooms.clear();
      }
    };

    const srv = createAppHttpServer(manager, path.resolve(__dirname, '../../client/dist'), lifecycle);
    activeServers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as { port: number }).port;

    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string; gitSha: string };
    expect(healthJson.status).toBe('ok');
    expect(typeof healthJson.gitSha).toBe('string');

    const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(readyRes.status).toBe(200);

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('game_active_rooms');
    expect(metricsText).toContain('game_connected_players');
    expect(metricsText).toContain('game_messages_per_second');
    expect(metricsText).toContain('game_bytes_per_second');
    expect(metricsText).toContain('game_step_duration_ms');
    expect(metricsText).toContain('nodejs_event_loop_utilization_percent');
    expect(metricsText).toContain('nodejs_memory_rss_bytes');

    lifecycle.isShuttingDown = true;
    const readyShutdown = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(readyShutdown.status).toBe(503);
    await manager.closeAll();
  });

  it('enforces Origin check on WebSocket handshake and isolates malformed frame floods', async () => {
    config.ALLOWED_ORIGINS = ['https://allowed-space.example.com'];
    const rooms = new Map<RoomId, Room>();
    const manager: RoomsManager = {
      getOrCreateRoom: (id) => {
        let r = rooms.get(id);
        if (!r) {
          r = new Room(id);
          rooms.set(id, r);
        }
        return r;
      },
      listRooms: () => Array.from(rooms.entries()).map(([id, r]) => ({ id, playersCount: r.size })),
      shutdownAll: async () => {
        for (const r of rooms.values()) await r.shutdownRoom();
        rooms.clear();
      },
      closeAll: async () => {
        for (const r of rooms.values()) await r.close();
        rooms.clear();
      }
    };

    const srv = createAppHttpServer(manager, path.resolve(__dirname, '../../client/dist'));
    const wss = setupWebSocketServer(srv, manager);
    activeServers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as { port: number }).port;

    // 1. Disallowed Origin rejected
    const rejected = await new Promise<boolean>((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: 'https://evil-attacker.example.com' }
      });
      badWs.on('error', () => resolve(true));
      badWs.on('open', () => {
        badWs.close();
        resolve(false);
      });
    });
    expect(rejected).toBe(true);

    // 2. Allowed Origin connects + flood of malformed frames closes attacker immediately
    const attackerClosedCode = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Origin: 'https://allowed-space.example.com' }
      });
      ws.on('open', () => {
        for (let i = 0; i < 1000; i++) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('{{{malformed_json_flood');
          }
        }
      });
      ws.on('close', (code) => resolve(code));
    });
    expect([1003, 1008]).toContain(attackerClosedCode);

    wss.close();
    await manager.closeAll();
  });

  it('handles SIGTERM gracefully in < 10s with close code 1001 and exit code 0', async () => {
    const testPort = 39188;
    const serverEntry = path.resolve(__dirname, './index.ts');
    const child = spawn(process.execPath, ['--experimental-strip-types', serverEntry], {
      env: { ...process.env, PORT: String(testPort), BUILD_SHA: 'test-sha-100', LOG_LEVEL: 'silent' },
      stdio: ['pipe', 'ignore', 'ignore']
    });

    // Wait until /health responds
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${testPort}/health`);
        if (res.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const clientEvents = await new Promise<{ gotShutdown: boolean; closeCode: number; exitCode: number | null; elapsedMs: number }>(
      (resolve) => {
        let gotShutdown = false;
        let closeCode = 0;
        const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'join', roomId: asRoomId('sigterm-room'), nickname: 'Tester' }));
        });
        ws.on('message', (raw, isBinary) => {
          if (!isBinary) {
            const msg = JSON.parse(raw.toString()) as { type: string };
            if (msg.type === 'joined') {
              const t0 = performance.now();
              if (process.platform === 'win32') { child.stdin?.write('SHUTDOWN\n'); } else { child.kill('SIGTERM'); }
              child.on('exit', (code) => {
                resolve({
                  gotShutdown,
                  closeCode,
                  exitCode: code,
                  elapsedMs: performance.now() - t0
                });
              });
            } else if (msg.type === 'shutdown') {
              gotShutdown = true;
            }
          }
        });
        ws.on('close', (code) => {
          closeCode = code;
        });
      }
    );

    expect(clientEvents.gotShutdown).toBe(true);
    expect(clientEvents.closeCode).toBe(1001);
    expect(clientEvents.exitCode).toBe(0);
    expect(clientEvents.elapsedMs).toBeLessThan(10000);
  });
});