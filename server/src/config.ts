import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ALLOWED_ORIGINS: z
    .string()
    .default('*')
    .transform((val) =>
      val === '*'
        ? ['*']
        : val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    ),
  MAX_CONNS_PER_IP: z.coerce.number().int().min(1).max(1000).default(12),
  MAX_ROOMS: z.coerce.number().int().min(1).max(1000).default(50),
  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(2).max(256).default(16),
  BUILD_SHA: z.string().min(1).default('dev-local')
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const config: AppConfig = loadConfig();