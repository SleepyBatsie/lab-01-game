import { encodeInputBinary, decodeSnapshotBinary } from '@space-game/shared/protocol';
import type { PlayerInput, WorldSnapshot, PlayerId, RoomId } from '@space-game/shared/types';
import type { AsteroidSimState } from '@space-game/shared/simulation';

export type ServerControlMessage =
  | {
      readonly type: 'init_world';
      readonly seed: number;
      readonly slot: number;
      readonly tickRate: number;
      readonly asteroids?: AsteroidSimState[];
    }
  | {
      readonly type: 'joined';
      readonly roomId: RoomId;
      readonly playerId: PlayerId;
      readonly nickname: string;
      readonly players: ReadonlyArray<{ readonly id: PlayerId; readonly nickname: string; readonly slot: number }>;
    }
  | {
      readonly type: 'system';
      readonly text: string;
      readonly players?: ReadonlyArray<{ readonly id: PlayerId; readonly nickname: string; readonly slot: number }>;
    }
  | {
      readonly type: 'chat';
      readonly from: string;
      readonly playerId: PlayerId;
      readonly text: string;
      readonly ts: number;
    }
  | {
      readonly type: 'pong_rtt';
      readonly clientTs: number;
    };

export type IncomingGameMessage = WorldSnapshot | ServerControlMessage;

export type OutgoingControlMessage =
  | { readonly type: 'join'; readonly roomId: string; readonly nickname: string }
  | { readonly type: 'leave' }
  | { readonly type: 'chat'; readonly text: string }
  | { readonly type: 'protocol_mode'; readonly binary: boolean }
  | { readonly type: 'ping_rtt'; readonly clientTs: number };

export class GameSocket extends EventTarget {
  private readonly url?: string;
  private ws: WebSocket | null = null;
  private readonly sendQueue: string[] = [];
  private reconnectDelay = 500;
  private readonly maxReconnectDelay = 10000;
  private readonly shouldReconnect = true;
  private reconnectTimer: number | null = null;
  private lastJoinPayload: OutgoingControlMessage | null = null;

  public useBinary = true;
  public simDelayMs = 0;
  public simJitterMs = 0;
  public simLossPct = 0;

  public rttMs = 0;
  private txBytesCounter = 0;
  private rxBytesCounter = 0;
  public txBytesPerSec = 0;
  public rxBytesPerSec = 0;

  constructor(url?: string) {
    super();
    this.url = url;

    window.setInterval(() => {
      this.txBytesPerSec = this.txBytesCounter;
      this.rxBytesPerSec = this.rxBytesCounter;
      this.txBytesCounter = 0;
      this.rxBytesCounter = 0;
    }, 1000);

    window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.rawSend(JSON.stringify({ type: 'ping_rtt', clientTs: performance.now() }));
      }
    }, 1000);
  }

  public setProtocolMode(useBinary: boolean): void {
    this.useBinary = useBinary;
    this.send({ type: 'protocol_mode', binary: this.useBinary });
  }

  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = this.url ?? `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      this.reconnectDelay = 500;
      this.dispatchEvent(new CustomEvent<string>('status', { detail: 'connected' }));

      if (this.lastJoinPayload) {
        this.rawSend(JSON.stringify(this.lastJoinPayload));
      }
      this.rawSend(JSON.stringify({ type: 'protocol_mode', binary: this.useBinary }));

      while (this.sendQueue.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
        const msg = this.sendQueue.shift();
        if (msg !== undefined) this.rawSend(msg);
      }
    });

    this.ws.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) {
        this.rxBytesCounter += event.data.byteLength;
        try {
          const snapshot = decodeSnapshotBinary(event.data);
          this.deliverIncoming(snapshot);
        } catch (err: unknown) {
          console.warn('[GameSocket] Помилка декодування бінарного знімка:', err);
        }
        return;
      }

      if (typeof event.data === 'string') {
        this.rxBytesCounter += new TextEncoder().encode(event.data).length;
        try {
          const data = JSON.parse(event.data) as IncomingGameMessage; // Trusted server JSON payload
          if (data.type === 'pong_rtt') {
            this.rttMs = Math.round(performance.now() - data.clientTs);
            return;
          }
          this.deliverIncoming(data);
        } catch (err: unknown) {
          console.warn('[GameSocket] Помилка парсингу JSON:', err);
        }
      }
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this.dispatchEvent(new CustomEvent<string>('status', { detail: 'disconnected' }));
      if (this.shouldReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      }
    });
  }

  private deliverIncoming(data: IncomingGameMessage): void {
    if (data.type === 'snapshot' && (this.simDelayMs > 0 || this.simLossPct > 0)) {
      if (Math.random() * 100 < this.simLossPct) return;
      const jitter = this.simJitterMs > 0 ? (Math.random() * 2 - 1) * this.simJitterMs : 0;
      const delay = Math.max(0, this.simDelayMs / 2 + jitter);
      window.setTimeout(() => {
        this.dispatchEvent(new CustomEvent<IncomingGameMessage>('message', { detail: data }));
      }, delay);
      return;
    }
    this.dispatchEvent(new CustomEvent<IncomingGameMessage>('message', { detail: data }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.dispatchEvent(new CustomEvent<string>('status', { detail: `reconnecting in ${this.reconnectDelay}ms` }));
    this.reconnectTimer = window.setTimeout(() => {
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  public sendInput(input: PlayerInput): void {
    if (this.simLossPct > 0 && Math.random() * 100 < this.simLossPct) {
      return;
    }

    const payload: ArrayBuffer | string = this.useBinary
      ? encodeInputBinary(input)
      : JSON.stringify({ type: 'input', ...input });

    if (this.simDelayMs > 0 || this.simJitterMs > 0) {
      const jitter = this.simJitterMs > 0 ? (Math.random() * 2 - 1) * this.simJitterMs : 0;
      const delay = Math.max(0, this.simDelayMs / 2 + jitter);
      window.setTimeout(() => this.rawSend(payload), delay);
    } else {
      this.rawSend(payload);
    }
  }

  public send(data: OutgoingControlMessage): void {
    if (data.type === 'join') {
      this.lastJoinPayload = data;
    } else if (data.type === 'leave') {
      this.lastJoinPayload = null;
    }

    const raw = JSON.stringify(data);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.rawSend(raw);
    } else {
      this.sendQueue.push(raw);
    }
  }

  private rawSend(payload: ArrayBuffer | string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (payload instanceof ArrayBuffer) {
      this.txBytesCounter += payload.byteLength;
    } else {
      this.txBytesCounter += new TextEncoder().encode(payload).length;
    }
    this.ws.send(payload);
  }
}