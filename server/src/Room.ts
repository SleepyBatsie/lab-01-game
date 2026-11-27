import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import {
  type PlayerId,
  type RoomId,
  type PlayerInput,
  asPlayerId
} from '@space-game/shared/types';
import {
  TICK_RATE,
  FIXED_DT,
  createInitialState,
  addPlayerToState,
  removePlayerFromState,
  stepWorld,
  buildWorldSnapshot,
  type WorldState
} from '@space-game/shared/simulation';
import { encodeSnapshotBinary } from '@space-game/shared/protocol';
import { logger } from './logger.ts';
import { serverMetrics } from './metrics.ts';

export interface RoomClientMeta {
  readonly id: PlayerId;
  readonly nickname: string;
  binaryMode: boolean;
}

export interface RoomEvents {
  empty: [roomId: RoomId];
}

export class Room extends EventEmitter<RoomEvents> {
  public readonly id: RoomId;
  private readonly clients = new Map<WebSocket, RoomClientMeta>();
  private readonly state: WorldState;
  private readonly latestInputs = new Map<PlayerId, PlayerInput>();
  private readonly tickInterval: NodeJS.Timeout;
  private closed = false;

  constructor(id: RoomId) {
    super();
    this.id = id;
    const seed = Array.from(id).reduce((acc, ch) => acc + ch.charCodeAt(0), 1000);
    this.state = createInitialState(seed);

    this.tickInterval = setInterval(() => {
      this.stepSimulation();
    }, 1000 / TICK_RATE);
  }

  public get size(): number {
    return this.clients.size;
  }

  public addClient(ws: WebSocket, meta: { readonly id: PlayerId; readonly nickname: string }): void {
    const usedSlots = new Set(Object.values(this.state.players).map((p) => p.slot));
    let slot = 0;
    while (usedSlots.has(slot)) slot++;

    const clientMeta: RoomClientMeta = {
      id: meta.id,
      nickname: meta.nickname,
      binaryMode: true
    };
    this.clients.set(ws, clientMeta);
    addPlayerToState(this.state, meta.id, meta.nickname, slot);

    logger.info({ roomId: this.id, playerId: meta.id, nickname: meta.nickname, slot }, 'Player joined room');

    this.sendJson(ws, {
      type: 'init_world',
      seed: this.state.seed,
      slot,
      tickRate: TICK_RATE,
      asteroids: this.state.asteroids
    });

    this.sendJson(ws, {
      type: 'joined',
      roomId: this.id,
      playerId: meta.id,
      nickname: meta.nickname,
      players: this.getPlayersList()
    });

    this.broadcastJson({
      type: 'system',
      text: `${meta.nickname} приєднався до кімнати`,
      players: this.getPlayersList()
    });
  }

  public setProtocolMode(ws: WebSocket, binary: boolean): void {
    const meta = this.clients.get(ws);
    if (meta) {
      meta.binaryMode = binary;
    }
  }

  public enqueueInput(ws: WebSocket, input: PlayerInput): void {
    const meta = this.clients.get(ws);
    if (!meta) return;
    const prev = this.latestInputs.get(meta.id);
    if (!prev || input.seq > prev.seq) {
      this.latestInputs.set(meta.id, input);
    }
  }

  public removeClient(ws: WebSocket): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    this.clients.delete(ws);
    this.latestInputs.delete(meta.id);
    removePlayerFromState(this.state, meta.id);

    logger.info({ roomId: this.id, playerId: meta.id, nickname: meta.nickname }, 'Player left room');

    if (this.clients.size === 0) {
      void this.close().then(() => {
        this.emit('empty', this.id);
      });
    } else {
      this.broadcastJson({
        type: 'system',
        text: `${meta.nickname} вийшов із кімнати`,
        players: this.getPlayersList()
      });
    }
  }

  public handleChat(ws: WebSocket, text: string): void {
    const meta = this.clients.get(ws);
    if (!meta) return;
    this.broadcastJson({
      type: 'chat',
      id: asPlayerId(`${Date.now()}_${meta.id}`),
      from: meta.nickname,
      text,
      ts: Date.now()
    });
  }

  private stepSimulation(): void {
    const t0 = performance.now();
    stepWorld(this.state, this.latestInputs, FIXED_DT);
    const snapshot = buildWorldSnapshot(this.state, Date.now());
    const binaryBuffer = encodeSnapshotBinary(snapshot);
    let jsonCache: string | null = null;

    for (const [ws, meta] of this.clients.entries()) {
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount > 65536) continue;

      if (meta.binaryMode) {
        ws.send(binaryBuffer);
      } else {
        if (jsonCache === null) {
          jsonCache = JSON.stringify(snapshot);
        }
        ws.send(jsonCache);
      }
    }
    serverMetrics.recordStepDuration(performance.now() - t0);
  }

  public getPlayersList(): Array<{ readonly id: PlayerId; readonly nickname: string; readonly slot: number }> {
    return Object.values(this.state.players).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      slot: p.slot
    }));
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  private broadcastJson(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const ws of this.clients.keys()) {
      if (ws.readyState === 1) {
        ws.send(serialized);
      }
    }
  }

  public async shutdownRoom(reason = 'Server shutting down'): Promise<void> {
    this.broadcastJson({ type: 'shutdown', reason });
    for (const ws of this.clients.keys()) {
      if (ws.readyState === 1) {
        ws.close(1001, reason);
      }
    }
    await this.close();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.tickInterval);
    this.clients.clear();
    this.latestInputs.clear();
  }
}