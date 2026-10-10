import type { FastifyInstance } from 'fastify';
import { registerCatalogRoutes } from './catalogs';
import { registerCategoryRoutes } from './categories';
import { registerMeRoutes } from './me';
import { registerSiteRoutes } from './sites';

/** Модуль org: организация, объекты и пояса, зоны, КПП, доки, типы транспорта, свои настройки. */
export function registerOrgModule(app: FastifyInstance): void {
  registerSiteRoutes(app);
  registerCatalogRoutes(app);
  registerCategoryRoutes(app);
  registerMeRoutes(app);
}
