import { describe, expect, it } from 'vitest';
import { exportBlockedReason } from '../src/lib/export-access';

const holds =
  (...codes: string[]) =>
  (p: string) =>
    codes.includes(p);

describe('«Выгрузить»: выгружаешь только то, что можешь видеть (Q-89)', () => {
  it('нет права выгрузки — называет его', () => {
    expect(exportBlockedReason(holds('pass.view'))?.text).toBe('Нет права «Выгрузка отчётов».');
  });
  it('бухгалтер с одним report.export: называет право видеть пропуска всех арендаторов', () => {
    const reason = exportBlockedReason(holds('report.export'));
    expect(reason?.text).toContain('Нет права «Просмотр пропусков всех арендаторов»');
    expect(reason?.rolesLink).toBe(false);
  });
  it('ссылка на роли — тому, кто может их менять', () => {
    expect(exportBlockedReason(holds('report.export', 'role.manage'))?.rolesLink).toBe(true);
  });
  it('есть оба права (свои или все арендаторы) — выгружать можно', () => {
    expect(exportBlockedReason(holds('report.export', 'pass.view'))).toBeNull();
    expect(exportBlockedReason(holds('report.export', 'pass.view_all_tenants'))).toBeNull();
  });
});
