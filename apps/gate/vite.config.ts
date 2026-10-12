import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** API — на том же адресе под `/api` (как за Caddy на сервере): cookie и Origin — свои (ADR-018). */
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
const proxy = {
  '/api': { target: apiTarget, rewrite: (path: string) => path.replace(/^\/api/, '') },
};

/**
 * Пост на рабочем сервере живёт под путём общего домена (`/gate/`, ADR-019): одна A-запись вместо двух.
 * В разработке и E2E — в корне своего порта.
 */
const base = process.env.GATE_BASE ?? '/';

export default defineConfig({
  base,
  // порядок важен: сначала генерация дерева маршрутов, затем React
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()],
  server: { proxy },
  preview: { proxy },
});
