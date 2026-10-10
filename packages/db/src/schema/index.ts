// Схема БД по docs/DATA_MODEL.md: один файл на раздел §2 (ADR-003). Изменение схемы — сначала
// DATA_MODEL.md, потом этот код и `pnpm --filter @oxrana/db generate`.
export * from './billing';
export * from './catalogs';
export * from './events';
export * from './hardware';
export * from './organization';
export * from './passes';
export * from './people';
export * from './rules';
export * from './tenants';
export * from './visits';
