import { EventEmitter } from 'node:events';
import { MatchLogger } from './matchLogger.js';
import { config } from './config.js';
import {
  TICK_RATE,
  FIXED_DT,
  createInitialState,
  addPlayerToState,
  removePlayerFromState,
  stepWorld
} from '@space-game/shared/simulation';
import { encodeSnapshotBinary } from '@space-game/shared/protocol';

const STEP_MS = 1000 / TICK_RATE;

export class Room extends EventEmitter {
  constructor(id, name = `Room ${id}`) {
    super();
    this.id = id;
    this.name = name;
    this.clients = new Map();
    this.logger = new MatchLogger(id);

    const seed = Math.floor(Math.random() * 1000000);
    this.state = createInitialState(seed);

    this.running = true;
    this.tickTimer = null;
    this.nextTickAt = performance.now() + STEP_MS;

    this.on('error', (err) => {
      console.error(`[Room ${this.id}] Error:`, err);
    });

    this.logger.logEvent({ type: 'room_created', roomId: this.id, name: this.name, seed });
    this.scheduleNextTick();
  }

  get size() {
    return this.clients.size;
  }

  scheduleNextTick() {
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

  stepSimulation() {
    if (this.clients.size === 0) return;

    const inputsByPlayerId = new Map();
    for (const [, info] of this.clients) {
      if (info.inputQueue.length > 0) {
        inputsByPlayerId.set(info.id, info.inputQueue.shift());
      } else if (info.lastInput) {
        inputsByPlayerId.set(info.id, { ...info.lastInput, fire: false });
      }
    }

    stepWorld(this.state, inputsByPlayerId, FIXED_DT);
    this.broadcastSnapshot();
  }

  enqueueInput(ws, input) {
    const info = this.clients.get(ws);
    if (!info) return;
    if (info.inputQueue.length < 15) {
      info.inputQueue.push(input);
    }
    info.lastInput = input;
  }

  setProtocolMode(ws, useBinary) {
    const info = this.clients.get(ws);
    if (info) {
      info.useBinary = Boolean(useBinary);
    }
  }

  addClient(ws, playerInfo) {
    const usedSlots = new Set(Array.from(this.clients.values()).map((c) => c.slot));
    const slot = usedSlots.has(0) ? 1 : 0;

    const fullInfo = {
      ...playerInfo,
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

  removeClient(ws) {
    const player = this.clients.get(ws);
    if (!player) return;

    this.clients.delete(ws);
    removePlayerFromState(this.state, player.id);
    this.logger.logEvent({ type: 'leave', player: { id: player.id, nickname: player.nickname } });

    if (this.clients.size === 0) {
      this.close().then(() => {
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

  handleChat(ws, text) {
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

  broadcastSnapshot() {
    const snapshotObj = {
      type: 'snapshot',
      tick: this.state.tick,
      serverTime: performance.now(),
      players: Object.values(this.state.players),
      bullets: this.state.bullets
    };

    let binaryBuf = null;
    let jsonStr = null;

    for (const [clientWs, info] of this.clients) {
      if (clientWs.readyState !== 1) continue;
      if (clientWs.bufferedAmount > config.maxBufferedAmount) continue;

      if (info.useBinary) {
        if (!binaryBuf) binaryBuf = encodeSnapshotBinary(snapshotObj);
        clientWs.send(binaryBuf);
      } else {
        if (!jsonStr) jsonStr = JSON.stringify(snapshotObj);
        clientWs.send(jsonStr);
      }
    }
  }

  broadcast(data, excludeWs = null) {
    const raw = JSON.stringify(data);
    for (const [clientWs] of this.clients) {
      if (clientWs === excludeWs || clientWs.readyState !== 1) continue;
      if (clientWs.bufferedAmount > config.maxBufferedAmount) continue;
      clientWs.send(raw);
    }
  }

  getPlayersList() {
    return Array.from(this.clients.values()).map(({ id, nickname, slot }) => ({ id, nickname, slot }));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      playersCount: this.clients.size,
      logFile: this.logger.filePath
    };
  }

  async close() {
    this.running = false;
    clearTimeout(this.tickTimer);
    this.logger.logEvent({ type: 'room_closed', roomId: this.id });
    await this.logger.close();
  }
}