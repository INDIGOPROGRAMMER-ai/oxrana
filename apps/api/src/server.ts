import { createPool, pingDb } from '@oxrana/db';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { loggerOptions } from './logger';

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

const app = await buildApp({
  logger: loggerOptions(config.LOG_LEVEL),
  version: process.env.npm_package_version ?? '0.0.0',
  readiness: () => pingDb(pool),
  exposeOpenApi: config.NODE_ENV !== 'production',
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'Останавливаем сервер');
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
  await pool.end();
  process.exit(1);
}
