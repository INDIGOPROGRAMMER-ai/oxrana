import type { FastifyInstance } from 'fastify';
import { registerOrgModule } from './org/routes';
import { registerRulesModule } from './rules/routes';
import { registerTenantsModule } from './tenants/routes';

/** Бизнес-модули API (ARCHITECTURE §2): каждый регистрирует свои маршруты с правами. */
export function registerModules(app: FastifyInstance): void {
  registerOrgModule(app);
  registerTenantsModule(app);
  registerRulesModule(app);
}
