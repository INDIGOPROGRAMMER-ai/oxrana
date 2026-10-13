import type { RoleTemplate } from '@oxrana/contracts';

/**
 * SQL миграции «добор прав ролям по шаблонам» (ADR-007, п. «Новое право»): каждой роли с
 * `template_code` добавляются права её шаблона, которых в роли нет. Права, которых в шаблоне нет,
 * не трогаются. Снимок шаблонов вшит в SQL (миграция не зависит от кода приложения); последняя
 * такая миграция обязана совпадать с этим выводом — следит `test/role-sync.integration.test.ts`.
 * Вывод: `pnpm --filter @oxrana/db role-sync-sql`.
 */
export function roleTemplatesSyncSql(templates: readonly RoleTemplate[]): string {
  const rows = templates
    .map(
      (t) => `    ('${t.code}', ARRAY[${t.permissions.map((p) => `'${p}'`).join(', ')}]::text[])`,
    )
    .join(',\n');
  return `UPDATE roles SET permissions = roles.permissions || ARRAY(
    SELECT p FROM unnest(t.permissions) AS p WHERE NOT (p = ANY (roles.permissions))
  )
  FROM (VALUES
${rows}
  ) AS t(code, permissions)
 WHERE roles.template_code = t.code
   AND EXISTS (SELECT 1 FROM unnest(t.permissions) AS p WHERE NOT (p = ANY (roles.permissions)));
`;
}
