import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  const logDir = process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.resolve(__dirname, '../../logs');

  const clientDistDir = path.resolve(__dirname, '../../client/dist');

  return Object.freeze({
    port,
    logDir,
    clientDistDir,
    joinTimeoutMs: 5000,
    pingIntervalMs: 15000,
    maxMessagesPerSec: 10,
    maxPayloadBytes: 4096,
    maxBufferedAmount: 64 * 1024
  });
}

export const config = loadConfig();