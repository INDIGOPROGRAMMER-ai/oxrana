import { randomUUID } from 'node:crypto';
import { type Db, schema } from '../src';

/**
 * Минимальные данные организации для тестов схемы: организация, объект, арендатор, тип транспорта.
 * Пишется под владельцем (`DATABASE_ADMIN_URL`), RLS его не ограничивает. Имена — нейтральные.
 */
export interface OrgFixture {
  organizationId: string;
  siteId: string;
  tenantId: string;
  categoryId: string;
}

export async function createOrgFixture(db: Db, label: string): Promise<OrgFixture> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: `Организация ${label}`, slug: `org-${label}-${suffix}` })
    .returning();
  if (!org) throw new Error('organization not inserted');
  const [site] = await db
    .insert(schema.sites)
    .values({ organizationId: org.id, name: `Объект ${label}`, timezone: 'Asia/Yekaterinburg' })
    .returning();
  if (!site) throw new Error('site not inserted');
  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      organizationId: org.id,
      siteId: site.id,
      legalName: `Арендатор ${label}`,
      shortName: `А-${label}`,
    })
    .returning();
  if (!tenant) throw new Error('tenant not inserted');
  const [category] = await db
    .insert(schema.vehicleCategories)
    .values({ organizationId: org.id, presetCode: 'car', name: 'легковой', sort: 10 })
    .returning();
  if (!category) throw new Error('category not inserted');
  return {
    organizationId: org.id,
    siteId: site.id,
    tenantId: tenant.id,
    categoryId: category.id,
  };
}

/** Одобренный пропуск на машину; поля, нужные exclusion-ограничению, задаются явно. */
export function vehiclePass(
  f: OrgFixture,
  values: {
    plateNorm: string;
    validFrom: Date;
    validTo: Date | null;
    passType?: 'single' | 'multi' | 'permanent';
    status?: (typeof schema.passes.$inferInsert)['status'];
    tenantId?: string;
  },
): typeof schema.passes.$inferInsert {
  return {
    organizationId: f.organizationId,
    siteId: f.siteId,
    tenantId: values.tenantId ?? f.tenantId,
    passType: values.passType ?? 'multi',
    participant: 'vehicle',
    plateRaw: values.plateNorm,
    plateNorm: values.plateNorm,
    plateCountry: 'RU',
    categoryId: f.categoryId,
    validFrom: values.validFrom,
    validTo: values.validTo,
    status: values.status ?? 'approved',
    createdVia: 'web',
  };
}

export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message: string;
}

/**
 * Ждёт отказа запроса и возвращает исходную ошибку PostgreSQL (Drizzle оборачивает её в
 * DrizzleQueryError, оригинал — в `cause`). Запрос, который прошёл, — провал теста.
 */
export async function pgErrorOf(promise: Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    while (
      current instanceof Error &&
      !('code' in current && typeof current.code === 'string') &&
      current.cause
    ) {
      current = current.cause;
    }
    if (current instanceof Error) return current as PgErrorInfo;
    throw error;
  }
  throw new Error('Ожидалась ошибка БД, но запрос выполнен');
}
