import { encodeInputBinary, decodeSnapshotBinary } from '@space-game/shared/protocol';

export class GameSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.sendQueue = [];
    this.reconnectDelay = 500;
    this.maxReconnectDelay = 10000;
    this.shouldReconnect = true;
    this.reconnectTimer = null;
    this.lastJoinPayload = null;

    // Режим протоколу: true = Binary (DataView), false = JSON
    this.useBinary = true;

    // Емулятор мережі (для тестування затримки, джитеру та втрати пакетів)
    this.simDelayMs = 0;
    this.simJitterMs = 0;
    this.simLossPct = 0;

    // Метрики для Netgraph
    this.rttMs = 0;
    this.txBytesCounter = 0;
    this.rxBytesCounter = 0;
    this.txBytesPerSec = 0;
    this.rxBytesPerSec = 0;

    setInterval(() => {
      this.txBytesPerSec = this.txBytesCounter;
      this.rxBytesPerSec = this.rxBytesCounter;
      this.txBytesCounter = 0;
      this.rxBytesCounter = 0;
    }, 1000);

    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.rawSend(JSON.stringify({ type: 'ping_rtt', clientTs: performance.now() }));
      }
    }, 1000);
  }

  setProtocolMode(useBinary) {
    this.useBinary = Boolean(useBinary);
    this.send({ type: 'protocol_mode', binary: this.useBinary });
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = this.url || `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.addEventListener('open', () => {
      this.reconnectDelay = 500;
      this.dispatchEvent(new CustomEvent('status', { detail: 'connected' }));

      if (this.lastJoinPayload) {
        this.rawSend(JSON.stringify(this.lastJoinPayload));
      }
      this.rawSend(JSON.stringify({ type: 'protocol_mode', binary: this.useBinary }));

      while (this.sendQueue.length > 0 && this.ws.readyState === WebSocket.OPEN) {
        const msg = this.sendQueue.shift();
        this.rawSend(msg);
      }
    });

    this.ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.rxBytesCounter += event.data.byteLength;
        try {
          const snapshot = decodeSnapshotBinary(event.data);
          this.deliverIncoming(snapshot);
        } catch (err) {
          console.warn('[GameSocket] Помилка декодування бінарного знімка:', err);
        }
        return;
      }

      this.rxBytesCounter += new TextEncoder().encode(event.data).length;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong_rtt') {
          this.rttMs = Math.round(performance.now() - data.clientTs);
          return;
        }
        this.deliverIncoming(data);
      } catch (err) {
        console.warn('[GameSocket] Помилка парсингу JSON:', err);
      }
    });

    this.ws.addEventListener('close', (event) => {
      this.dispatchEvent(new CustomEvent('status', { detail: 'disconnected' }));
      if (this.shouldReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      }
    });
  }

  // Емуляція вхідної затримки, розкиду та втрати пакетів для snapshot
  deliverIncoming(data) {
    if (data.type === 'snapshot' && (this.simDelayMs > 0 || this.simLossPct > 0)) {
      if (Math.random() * 100 < this.simLossPct) return; // Втрата пакета
      const jitter = this.simJitterMs > 0 ? (Math.random() * 2 - 1) * this.simJitterMs : 0;
      const delay = Math.max(0, this.simDelayMs / 2 + jitter);
      setTimeout(() => {
        this.dispatchEvent(new CustomEvent('message', { detail: data }));
      }, delay);
      return;
    }
    this.dispatchEvent(new CustomEvent('message', { detail: data }));
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.dispatchEvent(new CustomEvent('status', { detail: `reconnecting in ${this.reconnectDelay}ms` }));
    this.reconnectTimer = setTimeout(() => {
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  sendInput(input) {
    if (this.simLossPct > 0 && Math.random() * 100 < this.simLossPct) {
      return; // Емуляція втрати вихідного пакета input
    }

    const payload = this.useBinary
      ? encodeInputBinary(input)
      : JSON.stringify({ type: 'input', ...input });

    if (this.simDelayMs > 0 || this.simJitterMs > 0) {
      const jitter = this.simJitterMs > 0 ? (Math.random() * 2 - 1) * this.simJitterMs : 0;
      const delay = Math.max(0, this.simDelayMs / 2 + jitter);
      setTimeout(() => this.rawSend(payload), delay);
    } else {
      this.rawSend(payload);
    }
  }

  send(data) {
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

  rawSend(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (payload instanceof ArrayBuffer) {
      this.txBytesCounter += payload.byteLength;
    } else {
      this.txBytesCounter += new TextEncoder().encode(payload).length;
    }
    this.ws.send(payload);
  }
}
