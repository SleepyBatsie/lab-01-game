export class Lobby extends EventTarget {
  constructor(url = '/api/rooms', intervalMs = 2000) {
    super();
    this.url = url;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.abortController = null;
  }

  async fetchRooms() {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      const res = await fetch(this.url, {
        signal: AbortSignal.any([
          this.abortController.signal,
          AbortSignal.timeout(2500)
        ])
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rooms = await res.json();
      this.dispatchEvent(new CustomEvent('roomsUpdated', { detail: rooms }));
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[Lobby] Помилка отримання кімнат:', err.message);
      }
    }
  }

  startPolling() {
    this.stopPolling();
    this.fetchRooms();
    this.timer = setInterval(() => this.fetchRooms(), this.intervalMs);
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}