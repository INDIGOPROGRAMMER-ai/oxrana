import type { FastifyInstance } from 'fastify';
import { registerRealtimeRoutes } from '../realtime/routes';
import { registerAuditModule } from './audit/routes';
import { registerGateModule } from './gate/routes';
import { registerOccupancyModule } from './occupancy/routes';
import { registerOrgModule } from './org/routes';
import { registerPassesModule } from './passes/routes';
import { registerRulesModule } from './rules/routes';
import { registerTenantsModule } from './tenants/routes';

/** Бизнес-модули API (ARCHITECTURE §2): каждый регистрирует свои маршруты с правами. */
export function registerModules(app: FastifyInstance): void {
  registerOrgModule(app);
  registerTenantsModule(app);
  registerRulesModule(app);
  registerPassesModule(app);
  registerGateModule(app);
  registerOccupancyModule(app);
  registerAuditModule(app);
  registerRealtimeRoutes(app);
}
