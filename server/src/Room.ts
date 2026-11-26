import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { MatchLogger } from './matchLogger.ts';
import { config } from './config.ts';
import type { PlayerId, RoomId, PlayerInput } from '@space-game/shared/types';
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

const STEP_MS = 1000 / TICK_RATE;

export interface RoomClientInfo {
  readonly id: PlayerId;
  readonly nickname: string;
  readonly slot: number;
  useBinary: boolean;
  readonly inputQueue: PlayerInput[];
  lastInput: PlayerInput | null;
}

export interface RoomEvents {
  empty: [roomId: RoomId];
  error: [err: unknown];
}

export class Room extends EventEmitter<RoomEvents> {
  public readonly id: RoomId;
  public readonly name: string;
  private readonly clients = new Map<WebSocket, RoomClientInfo>();
  private readonly logger: MatchLogger;
  private readonly state: WorldState;
  private running = true;
  private tickTimer: NodeJS.Timeout | null = null;
  private nextTickAt: number;

  constructor(id: RoomId, name = `Room ${id}`) {
    super();
    this.id = id;
    this.name = name;
    this.logger = new MatchLogger(id);

    const seed = Math.floor(Math.random() * 1000000);
    this.state = createInitialState(seed);
    this.nextTickAt = performance.now() + STEP_MS;

    this.on('error', (err: unknown) => {
      console.error(`[Room ${this.id}] Error:`, err);
    });

    this.logger.logEvent({ type: 'room_created', roomId: this.id, name: this.name, seed });
    this.scheduleNextTick();
  }

  public get size(): number {
    return this.clients.size;
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    const now = performance.now();
    const delay = Math.max(0, this.nextTickAt - now);

    this.tickTimer = setTimeout(() => {
      if (!this.running) return;
      this.stepSimulation();
      this.nextTickAt += STEP_MS;
      if (performance.now() - this.nextTickAt > 200) {
        this.nextTickAt = performance.now() + STEP_MS;
      }
      this.scheduleNextTick();
    }, delay);
  }

  private stepSimulation(): void {
    if (this.clients.size === 0) return;

    const inputsByPlayerId = new Map<PlayerId, PlayerInput>();
    for (const info of this.clients.values()) {
      const nextInput = info.inputQueue.shift();
      if (nextInput) {
        inputsByPlayerId.set(info.id, nextInput);
      } else if (info.lastInput) {
        inputsByPlayerId.set(info.id, { ...info.lastInput, fire: false });
      }
    }

    stepWorld(this.state, inputsByPlayerId, FIXED_DT);
    this.broadcastSnapshot();
  }

  public enqueueInput(ws: WebSocket, input: PlayerInput): void {
    const info = this.clients.get(ws);
    if (!info) return;
    if (info.inputQueue.length < 15) {
      info.inputQueue.push(input);
    }
    info.lastInput = input;
  }

  public setProtocolMode(ws: WebSocket, useBinary: boolean): void {
    const info = this.clients.get(ws);
    if (info) {
      info.useBinary = useBinary;
    }
  }

  public addClient(ws: WebSocket, playerInfo: { readonly id: PlayerId; readonly nickname: string }): void {
    const usedSlots = new Set(Array.from(this.clients.values()).map((c) => c.slot));
    const slot = usedSlots.has(0) ? 1 : 0;

    const fullInfo: RoomClientInfo = {
      id: playerInfo.id,
      nickname: playerInfo.nickname,
      slot,
      useBinary: true,
      inputQueue: [],
      lastInput: null
    };

    this.clients.set(ws, fullInfo);
    addPlayerToState(this.state, playerInfo.id, playerInfo.nickname, slot);
    this.logger.logEvent({ type: 'join', player: { id: playerInfo.id, nickname: playerInfo.nickname, slot } });

    ws.send(JSON.stringify({
      type: 'init_world',
      seed: this.state.seed,
      slot,
      tickRate: TICK_RATE,
      asteroids: this.state.asteroids
    }));

    this.broadcast({
      type: 'system',
      text: `${playerInfo.nickname} (Slot ${slot + 1}) приєднався до кімнати`,
      players: this.getPlayersList()
    });
  }

  public removeClient(ws: WebSocket): void {
    const player = this.clients.get(ws);
    if (!player) return;

    this.clients.delete(ws);
    removePlayerFromState(this.state, player.id);
    this.logger.logEvent({ type: 'leave', player: { id: player.id, nickname: player.nickname } });

    if (this.clients.size === 0) {
      void this.close().then(() => {
        this.emit('empty', this.id);
      });
    } else {
      this.broadcast({
        type: 'system',
        text: `${player.nickname} вийшов із кімнати`,
        players: this.getPlayersList()
      });
    }
  }

  public handleChat(ws: WebSocket, text: string): void {
    const player = this.clients.get(ws);
    if (!player) return;

    const payload = {
      type: 'chat',
      from: player.nickname,
      playerId: player.id,
      text,
      ts: Date.now()
    };

    this.logger.logEvent(payload);
    this.broadcast(payload);
  }

  private broadcastSnapshot(): void {
    const snapshot = buildWorldSnapshot(this.state, performance.now());

    let binaryBuf: ArrayBuffer | null = null;
    let jsonStr: string | null = null;

    for (const [clientWs, info] of this.clients) {
      if (clientWs.readyState !== 1) continue;
      if (clientWs.bufferedAmount > config.maxBufferedAmount) continue;

      if (info.useBinary) {
        if (!binaryBuf) binaryBuf = encodeSnapshotBinary(snapshot);
        clientWs.send(binaryBuf);
      } else {
        if (!jsonStr) jsonStr = JSON.stringify(snapshot);
        clientWs.send(jsonStr);
      }
    }
  }

  public broadcast(data: unknown, excludeWs: WebSocket | null = null): void {
    const raw = JSON.stringify(data);
    for (const clientWs of this.clients.keys()) {
      if (clientWs === excludeWs || clientWs.readyState !== 1) continue;
      if (clientWs.bufferedAmount > config.maxBufferedAmount) continue;
      clientWs.send(raw);
    }
  }

  public getPlayersList(): Array<{ id: PlayerId; nickname: string; slot: number }> {
    return Array.from(this.clients.values()).map(({ id, nickname, slot }) => ({ id, nickname, slot }));
  }

  public toJSON(): { id: RoomId; name: string; playersCount: number; logFile: string } {
    return {
      id: this.id,
      name: this.name,
      playersCount: this.clients.size,
      logFile: this.logger.filePath
    };
  }

  public async close(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.logger.logEvent({ type: 'room_closed', roomId: this.id });
    await this.logger.close();
  }
}