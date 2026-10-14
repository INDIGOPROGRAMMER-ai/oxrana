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

/**
 * E2E идут на отдельной чистой базе `oxrana_e2e` (только миграции, без демо-сида): сценарий
 * начинается с «чистого старта», как на новом сервере (ADR-016).
 */
function withDatabase(url: string | undefined, database: string): string {
  if (!url) return '';
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
export const E2E_DATABASE_URL = withDatabase(process.env.DATABASE_URL, 'oxrana_e2e');
export const E2E_DATABASE_ADMIN_URL = withDatabase(process.env.DATABASE_ADMIN_URL, 'oxrana_e2e');
export const WEB_URL = `http://127.0.0.1:${PORTS.web}`;
export const GATE_URL = `http://127.0.0.1:${PORTS.gate}`;
const API_URL = `http://127.0.0.1:${PORTS.api}`;

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
      // кабинет арендатора продолжает базу после чистого старта (ADR-022): отдельный проект ниже
      testIgnore: /cabinet\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    {
      // Этап 7a: кабинет и очередь согласования на той же чистой базе после `clean-start.spec.ts`
      // (организация, объект, доки, арендаторы Альфа и Бета, администратор уже есть). Проект идёт после
      // `chromium`: без зависимости файлы шли бы параллельно, а «чистый старт» отказал бы на непустой базе.
      name: 'cabinet',
      testMatch: /cabinet\.spec\.ts/,
      dependencies: ['chromium'],
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: [
    {
      // база пересоздаётся при каждом запуске: сервер не переиспользуется
      command: 'bash scripts/e2e-db.sh && pnpm --filter @oxrana/api exec tsx src/server.ts',
      url: `${API_URL}/healthz`,
      env: {
        PORT: String(PORTS.api),
        HOST: '127.0.0.1',
        DATABASE_URL: E2E_DATABASE_URL,
        E2E_DATABASE_ADMIN_URL,
        PUBLIC_URL: WEB_URL,
        GATE_URL,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @oxrana/web exec vite --host 127.0.0.1 --port ${PORTS.web} --strictPort`,
      url: WEB_URL,
      env: { API_PROXY_TARGET: API_URL },
      reuseExistingServer,
    },
    {
      command: `pnpm --filter @oxrana/gate exec vite --host 127.0.0.1 --port ${PORTS.gate} --strictPort`,
      url: GATE_URL,
      env: { API_PROXY_TARGET: API_URL },
      reuseExistingServer,
    },
  ],
});
