import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

import { createViteMiddleware } from './server/proxy.mjs';

export default defineConfig({
  plugins: [
    react(),
    {
      // Phase A 本地同源代理：dev server 挂 /api（见 docs/phase-a-contract.md）。
      name: 'deepword-local-proxy',
      configureServer(server) {
        server.middlewares.use(createViteMiddleware());
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.mjs'],
  },
});
