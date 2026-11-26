import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/src/**/*.test.ts', 'server/src/**/*.test.ts', 'client/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['shared/src/**/*.ts'],
      exclude: ['shared/src/**/*.test.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85
      }
    }
  }
});