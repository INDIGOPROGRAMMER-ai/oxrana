import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // порядок важен: сначала генерация дерева маршрутов, затем React
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()],
});
