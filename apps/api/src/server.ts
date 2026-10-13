import { createDb, createPool, pingDb } from '@oxrana/db';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { LocalFileStore } from './files/store';
import { loggerOptions } from './logger';
import { processApprovalTimeouts } from './modules/passes/approvals';
import { EventHub } from './realtime/hub';
import { EventListener } from './realtime/listener';

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: 'oxrana-api' });

const db = createDb(pool);
const hub = new EventHub();
const app = await buildApp({
  logger: loggerOptions(config.LOG_LEVEL),
  version: config.APP_VERSION ?? process.env.npm_package_version ?? '0.0.0',
  trustProxy: config.TRUST_PROXY,
  readiness: () => pingDb(pool),
  exposeOpenApi: config.NODE_ENV !== 'production',
  services: {
    db,
    hub,
    publicUrl: config.PUBLIC_URL,
    gateUrl: config.GATE_URL,
    files: new LocalFileStore(config.FILES_DIR),
    fileMaxBytes: config.FILE_MAX_BYTES,
  },
});
// Outbox → LISTEN/NOTIFY → SSE (ADR-004): одно выделенное соединение на процесс.
const listener = new EventListener({
  connectionString: config.DATABASE_URL,
  db,
  hub,
  ruleSets: app.deps.ruleSets,
  onError: (error) =>
    app.log.error({ err: error }, 'Слушатель событий БД: ошибка, переподключаемся'),
});
await listener.start();

// Сроки согласования (эскалация, автоотклонение) — раз в минуту; pg-boss появится вместе с
// уведомлениями (этап 10), до него — таймер в процессе API.
const approvalTimer = setInterval(() => {
  processApprovalTimeouts(app.deps).catch((error: unknown) =>
    app.log.error({ err: error }, 'Сроки согласования: ошибка, повторим через минуту'),
  );
}, 60_000);
approvalTimer.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Останавливаем сервер');
  clearInterval(approvalTimer);
  await listener.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error({ err: error }, 'Сервер не запустился');
  await listener.stop();
  await pool.end();
  process.exit(1);
}
