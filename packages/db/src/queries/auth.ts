import { sql } from 'drizzle-orm';
import type { Db, DbTx } from '../client';

/**
 * Поиск организации по хэшу токена, который приходит без неё (DATA_MODEL §9 п. 7). Функции БД —
 * `SECURITY DEFINER` и возвращают только id организации; всё остальное читается обычным путём,
 * в контексте этой организации и под RLS.
 */
export type TokenKind = 'device' | 'enrollment' | 'invitation';

export async function organizationOfToken(
  db: Db | DbTx,
  kind: TokenKind,
  hash: string,
): Promise<string | null> {
  const result = await db.execute<{ id: string | null }>(
    sql`select auth_org_of_token(${kind}, ${hash}) as id`,
  );
  return result.rows[0]?.id ?? null;
}

/** Организации, где у пользователя есть назначения ролей: первая — самая ранняя. */
export async function userOrganizations(db: Db | DbTx, userId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(
    sql`select auth_user_organizations(${userId}::uuid) as id`,
  );
  return result.rows.map((r) => r.id);
}

/** Все организации — для фоновых задач, которые обходят их по одной. */
export async function allOrganizationIds(db: Db | DbTx): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`select app_organization_ids() as id`);
  return result.rows.map((r) => r.id);
}
