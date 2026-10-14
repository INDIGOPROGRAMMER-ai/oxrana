import type { FastifyInstance } from 'fastify';
import { registerRealtimeRoutes } from '../realtime/routes';
import { registerAuditModule } from './audit/routes';
import { registerDeviceRoutes } from './auth/devices';
import { registerAuthRoutes } from './auth/routes';
import { registerUserRoutes } from './auth/users';
import { registerBlacklistModule } from './blacklist/routes';
import { registerGateModule } from './gate/routes';
import { registerNotificationRoutes } from './notifications/routes';
import { registerOccupancyModule } from './occupancy/routes';
import { registerOrgModule } from './org/routes';
import { registerPassFormRoutes } from './pass-form/routes';
import { registerPassesModule } from './passes/routes';
import { registerRulesModule } from './rules/routes';
import { registerSandboxModule } from './sandbox/routes';
import { registerTenantsModule } from './tenants/routes';

/** Бизнес-модули API (ARCHITECTURE §2): каждый регистрирует свои маршруты с правами. */
export function registerModules(app: FastifyInstance): void {
  registerAuthRoutes(app);
  registerUserRoutes(app);
  registerDeviceRoutes(app);
  registerOrgModule(app);
  registerTenantsModule(app);
  registerRulesModule(app);
  registerPassesModule(app);
  registerPassFormRoutes(app);
  registerNotificationRoutes(app);
  registerGateModule(app);
  registerOccupancyModule(app);
  registerAuditModule(app);
  registerBlacklistModule(app);
  registerSandboxModule(app);
  registerRealtimeRoutes(app);
}
