import type { FastifyInstance } from 'fastify';
import { registerOrgModule } from './org/routes';

/** Бизнес-модули API (ARCHITECTURE §2): каждый регистрирует свои маршруты с правами. */
export function registerModules(app: FastifyInstance): void {
  registerOrgModule(app);
}
