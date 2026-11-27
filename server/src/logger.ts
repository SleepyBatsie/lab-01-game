import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['password', 'token', 'secret', 'authorization', '*.password', '*.token', '*.secret'],
    censor: '[REDACTED]'
  },
  base: {
    service: 'space-arena-server'
  },
  timestamp: pino.stdTimeFunctions.isoTime
});