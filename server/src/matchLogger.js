import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

export class MatchLogger {
  constructor(roomId) {
    this.roomId = roomId;
    this.filePath = path.join(config.logDir, `match-${roomId}-${Date.now()}.ndjson`);
    
    fs.mkdirSync(config.logDir, { recursive: true });

    this.ndjsonTransform = new Transform({
      writableObjectMode: true,
      transform(event, encoding, callback) {
        try {
          const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
          callback(null, line);
        } catch (err) {
          callback(err);
        }
      }
    });

    this.fileStream = fs.createWriteStream(this.filePath, { flags: 'a' });

    this.pipelinePromise = pipeline(this.ndjsonTransform, this.fileStream).catch((err) => {
      console.error(`[MatchLogger ${roomId}] Pipeline error:`, err);
    });
  }

  logEvent(event) {
    if (!this.ndjsonTransform.writableEnded) {
      const canContinue = this.ndjsonTransform.write(event);
      if (!canContinue) {
        console.warn(`[MatchLogger ${this.roomId}] Backpressure на запис логу`);
      }
    }
  }

  async close() {
    if (!this.ndjsonTransform.writableEnded) {
      this.ndjsonTransform.end();
      await this.pipelinePromise;
    }
  }

  static streamReplay(filePath, res) {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Replay not found' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked'
    });

    const readStream = fs.createReadStream(filePath);
    
    pipeline(readStream, res).catch((err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('[Replay Stream Error]:', err);
      }
    });
  }
}