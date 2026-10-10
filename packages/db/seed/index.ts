export { applySeed, type SeedReport } from './apply';
export { seedId } from './ids';
export { RADONEZHSKY } from './radonezhsky';
export type { QuotaSeed, SeedData, TenantSeed } from './types';

import { RADONEZHSKY } from './radonezhsky';

/** Демо-объект по умолчанию: его поднимает `pnpm db:seed`. */
export const DEMO_SEED = RADONEZHSKY;
