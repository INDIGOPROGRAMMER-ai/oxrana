import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS, ROLE_TEMPLATES } from '@oxrana/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, createPool, MIGRATIONS_FOLDER, roleTemplatesSyncSql, schema } from '../src';
import { createOrgFixture } from './fixtures';

const owner = createPool({ connectionString: process.env.DATABASE_ADMIN_URL ?? '', max: 2 });
const db = createDb(owner);
afterAll(() => owner.end());

/** Последняя миграция «добор прав ролям по шаблонам» (имя файла — `*_role_templates_sync.sql`). */
function latestSyncMigration(): { file: string; sql: string } {
  const file = readdirSync(MIGRATIONS_FOLDER)
    .filter((f) => f.endsWith('_role_templates_sync.sql'))
    .sort()
    .at(-1);
  if (!file) throw new Error('Нет миграции *_role_templates_sync.sql');
  return { file, sql: readFileSync(join(MIGRATIONS_FOLDER, file), 'utf8') };
}

describe('добор прав ролям по шаблонам (ADR-007, «Новое право»)', () => {
  it('последняя миграция — снимок текущих ROLE_TEMPLATES: новое право без миграции не пройдёт', () => {
    const { sql } = latestSyncMigration();
    expect(sql.endsWith(roleTemplatesSyncSql(ROLE_TEMPLATES))).toBe(true);
  });

  it('роли по шаблонам из старого состояния получают недостающие права, чужие права остаются', async () => {
    const f = await createOrgFixture(db, 'rolesync');
    const old = ['pass.view', 'pass.cancel_own'];
    const created = await db
      .insert(schema.roles)
      .values(
        ROLE_TEMPLATES.map((t) => ({
          organizationId: f.organizationId,
          name: t.name,
          isTemplate: true,
          templateCode: t.code,
          // состояние до 0007: часть прав шаблона, плюс право, которого в шаблоне нет
          permissions: [...old, 'custom.legacy'],
        })),
      )
      .returning();
    const custom = await db
      .insert(schema.roles)
      .values({
        organizationId: f.organizationId,
        name: 'Своя роль',
        isTemplate: false,
        templateCode: null,
        permissions: ['pass.view'],
      })
      .returning();
    expect(created).toHaveLength(ROLE_TEMPLATES.length);

    await owner.query(latestSyncMigration().sql.replaceAll('--> statement-breakpoint', ''));

    const rows = await db.select().from(schema.roles);
    const mine = rows.filter((r) => r.organizationId === f.organizationId);
    for (const t of ROLE_TEMPLATES) {
      const role = mine.find((r) => r.templateCode === t.code);
      expect(new Set(role?.permissions), t.code).toEqual(
        new Set([...t.permissions, ...old, 'custom.legacy']),
      );
    }
    const owned = mine.find((r) => r.templateCode === 'org_owner');
    expect(PERMISSIONS.every((p) => owned?.permissions.includes(p))).toBe(true);
    expect(mine.find((r) => r.id === custom[0]?.id)?.permissions).toEqual(['pass.view']);
  });
});
