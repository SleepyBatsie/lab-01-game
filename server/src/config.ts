import { z } from 'zod';

const EnvConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOGS_DIR: z.string().min(1).default('logs'),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(64 * 1024),
  MAX_BUFFERED_AMOUNT: z.coerce.number().int().positive().default(1024 * 1024),
  PING_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  JOIN_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)
});

const parsed = EnvConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid server environment configuration:', parsed.error.format());
  process.exit(1);
}

export const config = {
  port: parsed.data.PORT,
  host: parsed.data.HOST,
  logsDir: parsed.data.LOGS_DIR,
  maxPayloadBytes: parsed.data.MAX_PAYLOAD_BYTES,
  maxBufferedAmount: parsed.data.MAX_BUFFERED_AMOUNT,
  pingIntervalMs: parsed.data.PING_INTERVAL_MS,
  joinTimeoutMs: parsed.data.JOIN_TIMEOUT_MS
} as const;