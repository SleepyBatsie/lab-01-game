import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@space-game\/shared\/(.+?)(?:\.(?:js|ts))?$/,
        replacement: fileURLToPath(new URL('../shared/src/$1.ts', import.meta.url))
      },
      {
        find: '@space-game/shared',
        replacement: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url))
      }
    ]
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true
      }
    }
  }
});