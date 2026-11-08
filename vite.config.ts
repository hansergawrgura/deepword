import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

import { createViteMiddleware } from './server/proxy.mjs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'dpdp-word-local-proxy',
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
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
  },
});
