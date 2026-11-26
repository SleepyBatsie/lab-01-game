export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly playersCount: number;
}

export class Lobby extends EventTarget {
  private readonly apiUrl: string;
  private pollTimer: number | null = null;

  constructor(apiUrl = '/api/rooms') {
    super();
    this.apiUrl = apiUrl;
  }

  public startPolling(intervalMs = 3000): void {
    void this.fetchRooms();
    this.stopPolling();
    this.pollTimer = window.setInterval(() => {
      void this.fetchRooms();
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public async fetchRooms(): Promise<void> {
    try {
      const res = await fetch(this.apiUrl);
      if (!res.ok) return;
      const rooms: unknown = await res.json();
      if (Array.isArray(rooms)) {
        this.dispatchEvent(new CustomEvent<RoomSummary[]>('roomsUpdated', { detail: rooms }));
      }
    } catch {
      // Ігноруємо мережеві помилки опитування лобі
    }
  }
}