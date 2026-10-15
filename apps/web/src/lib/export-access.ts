import { PERMISSION_LABELS } from '@oxrana/contracts';

/**
 * Почему «Выгрузить» неактивна (Q-89): выгружаешь только то, что можешь видеть. Нужны право выгрузки
 * (`report.export`) и право видеть пропуска; без любого из них кнопка не даёт неожиданный 403 после
 * нажатия, а называет право и, если можно настроить роли, ведёт на них. `null` — можно выгружать.
 */
export function exportBlockedReason(
  can: (permission: string) => boolean,
): { text: string; rolesLink: boolean } | null {
  const rolesLink = can('role.manage');
  if (!can('report.export')) {
    return { text: `Нет права «${PERMISSION_LABELS['report.export']}».`, rolesLink };
  }
  if (!can('pass.view') && !can('pass.view_all_tenants')) {
    return {
      text: `Нет права «${PERMISSION_LABELS['pass.view_all_tenants']}»: выгрузить можно только то, что вы видите.`,
      rolesLink,
    };
  }
  return null;
}
