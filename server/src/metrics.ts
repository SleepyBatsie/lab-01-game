import { performance } from 'node:perf_hooks';

export class ServerMetrics {
  private msgCount = 0;
  private byteCount = 0;
  private msgsPerSec = 0;
  private bytesPerSec = 0;
  private lastTickMs = 0;
  private maxTickMs = 0;
  private lastElu = performance.eventLoopUtilization();
  private eluPct = 0;
  private readonly timer: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => {
      this.msgsPerSec = this.msgCount;
      this.bytesPerSec = this.byteCount;
      this.msgCount = 0;
      this.byteCount = 0;

      const currentElu = performance.eventLoopUtilization(this.lastElu);
      this.lastElu = performance.eventLoopUtilization();
      this.eluPct = Number((currentElu.utilization * 100).toFixed(2));
    }, 1000);
    this.timer.unref();
  }

  public recordTraffic(bytes: number): void {
    this.msgCount++;
    this.byteCount += bytes;
  }

  public recordStepDuration(ms: number): void {
    this.lastTickMs = ms;
    if (ms > this.maxTickMs) {
      this.maxTickMs = ms;
    }
  }

  public toPrometheus(roomsCount: number, playersCount: number): string {
    const mem = process.memoryUsage();
    return [
      '# HELP game_active_rooms Number of active game rooms',
      '# TYPE game_active_rooms gauge',
      `game_active_rooms ${roomsCount}`,
      '# HELP game_connected_players Number of connected players',
      '# TYPE game_connected_players gauge',
      `game_connected_players ${playersCount}`,
      '# HELP game_messages_per_second Incoming WebSocket messages per second',
      '# TYPE game_messages_per_second gauge',
      `game_messages_per_second ${this.msgsPerSec}`,
      '# HELP game_bytes_per_second Incoming WebSocket bytes per second',
      '# TYPE game_bytes_per_second gauge',
      `game_bytes_per_second ${this.bytesPerSec}`,
      '# HELP game_step_duration_ms Last simulation step duration in ms',
      '# TYPE game_step_duration_ms gauge',
      `game_step_duration_ms ${this.lastTickMs.toFixed(3)}`,
      '# HELP game_step_max_duration_ms Max simulation step duration in ms',
      '# TYPE game_step_max_duration_ms gauge',
      `game_step_max_duration_ms ${this.maxTickMs.toFixed(3)}`,
      '# HELP nodejs_event_loop_utilization_percent Event loop utilization percentage',
      '# TYPE nodejs_event_loop_utilization_percent gauge',
      `nodejs_event_loop_utilization_percent ${this.eluPct}`,
      '# HELP nodejs_memory_rss_bytes Resident Set Size in bytes',
      '# TYPE nodejs_memory_rss_bytes gauge',
      `nodejs_memory_rss_bytes ${mem.rss}`,
      '# HELP nodejs_memory_heap_used_bytes V8 heap used in bytes',
      '# TYPE nodejs_memory_heap_used_bytes gauge',
      `nodejs_memory_heap_used_bytes ${mem.heapUsed}`
    ].join('\n');
  }

  public stop(): void {
    clearInterval(this.timer);
  }
}

export const serverMetrics = new ServerMetrics();