import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import type { RoomId } from '@space-game/shared/types';

export class MatchLogger {
  public readonly filePath: string;
  private readonly stream: fs.WriteStream;

  constructor(roomId: RoomId) {
    fs.mkdirSync(config.logsDir, { recursive: true });
    const safeId = roomId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(config.logsDir, `match-${safeId}-${stamp}.ndjson`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });

    this.stream.on('error', (err: unknown) => {
      console.error(`[MatchLogger ${roomId}] Write stream error:`, err);
    });
  }

  public logEvent(event: Record<string, unknown>): void {
    if (this.stream.writableEnded) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    this.stream.write(line);
  }

  public async close(): Promise<void> {
    if (this.stream.writableEnded) return;
    await new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}