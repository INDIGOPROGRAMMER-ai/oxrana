import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** API — на том же адресе под `/api` (как за Caddy на сервере): cookie и Origin — свои (ADR-018). */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
const proxy = {
  '/api': { target: apiTarget, rewrite: (path: string) => path.replace(/^\/api/, '') },
};

export default defineConfig({
  // порядок важен: сначала генерация дерева маршрутов, затем React
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()],
  server: { proxy },
  preview: { proxy },
});
