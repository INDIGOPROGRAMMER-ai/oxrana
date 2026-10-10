import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

try {
  process.loadEnvFile('.env');
} catch {
  // .env нет (свежий клон) — API возьмёт значения из окружения
}

// Порты не пересекаются с `pnpm dev` (3000 / 5173 / 5174), чтобы E2E не цеплял чужие серверы.
export const PORTS = { api: 3100, web: 5273, gate: 5274 } as const;

// В облачной сессии браузеры лежат в /opt/pw-browsers, `playwright install` не запускаем (ADR-010).
// В CI ставится штатный Chromium, и путь подменять не нужно.
const SESSION_CHROMIUM = '/opt/pw-browsers/chromium';
const executablePath =
  !process.env.CI && existsSync(SESSION_CHROMIUM) ? SESSION_CHROMIUM : undefined;

const reuseExistingServer = !process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @oxrana/api exec tsx src/server.ts',
      url: `http://127.0.0.1:${PORTS.api}/healthz`,
      env: { PORT: String(PORTS.api), HOST: '127.0.0.1' },
      reuseExistingServer,
    },
    {
      command: `pnpm --filter @oxrana/web exec vite --host 127.0.0.1 --port ${PORTS.web} --strictPort`,
      url: `http://127.0.0.1:${PORTS.web}`,
      reuseExistingServer,
    },
    {
      command: `pnpm --filter @oxrana/gate exec vite --host 127.0.0.1 --port ${PORTS.gate} --strictPort`,
      url: `http://127.0.0.1:${PORTS.gate}`,
      reuseExistingServer,
    },
  ],
});
