import { type CabinetContext, resolvePassForm } from '@oxrana/contracts';
import { describe, expect, it } from 'vitest';
import { buildFormView } from '../src/lib/pass-form-view';

const ctx: Pick<CabinetContext, 'tenant' | 'categories' | 'zones' | 'purposes' | 'docks'> = {
  tenant: {
    id: 't',
    name: 'Альфа',
    status: 'active',
    isOperator: false,
    trucksDockRequired: true,
    defaultCategoryId: null,
    contractValidTo: null,
  },
  categories: [
    { id: 'car', name: 'легковой', dockEligible: false, available: true },
    { id: 'light', name: 'малотоннажный', dockEligible: true, available: true },
    { id: 'semi', name: 'фура', dockEligible: true, available: true },
    { id: 'zero', name: 'спецтехника', dockEligible: false, available: false },
  ],
  zones: [{ id: 'z1', name: 'Склад А' }],
  purposes: [],
  docks: [{ id: 'd1', number: '1' }],
};

describe('что показывает форма пропуска (ADR-023)', () => {
  it('типы транспорта: доступные арендатору ∩ разрешённые формой; единственный тип подставлен', () => {
    const open = buildFormView({ form: resolvePassForm({}), ctx, enforced: true });
    expect(open.categories.map((c) => c.id)).toEqual(['car', 'light', 'semi']);
    expect(open.defaultCategoryId).toBe('');
    const limited = buildFormView({
      form: resolvePassForm({ user: { categoryIds: ['light'] } }),
      ctx,
      enforced: true,
    });
    expect(limited.categories.map((c) => c.id)).toEqual(['light']);
    expect(limited.defaultCategoryId).toBe('light');
    // сотрудников оператора форма арендатора не сужает
    const staff = buildFormView({
      form: resolvePassForm({ user: { categoryIds: ['light'] } }),
      ctx,
      enforced: false,
    });
    expect(staff.categories).toHaveLength(3);
  });

  it('тип по умолчанию: из настройки, потом тип арендатора; чужого типа нет', () => {
    const byForm = buildFormView({
      form: resolvePassForm({ tenant: { defaultCategoryId: 'semi' } }),
      ctx,
      enforced: true,
    });
    expect(byForm.defaultCategoryId).toBe('semi');
    const byTenant = buildFormView({
      form: resolvePassForm({}),
      ctx: { ...ctx, tenant: { ...ctx.tenant, defaultCategoryId: 'car' } },
      enforced: true,
    });
    expect(byTenant.defaultCategoryId).toBe('car');
    const gone = buildFormView({
      form: resolvePassForm({ tenant: { categoryIds: ['car'] } }),
      ctx: { ...ctx, tenant: { ...ctx.tenant, defaultCategoryId: 'semi' } },
      enforced: true,
    });
    expect(gone.defaultCategoryId).toBe('car');
  });

  it('одно место назначения подставлено и пункта «Не указано» нет; два — «Не указано»; скрытое поле не подставляется', () => {
    const one = buildFormView({ form: resolvePassForm({}), ctx, enforced: true });
    expect(one.defaultZoneId).toBe('z1');
    expect(one.zoneUnspecified).toBe(false);
    const two = buildFormView({
      form: resolvePassForm({}),
      ctx: { ...ctx, zones: [...ctx.zones, { id: 'z2', name: 'Офис' }] },
      enforced: true,
    });
    expect(two.defaultZoneId).toBe('');
    expect(two.zoneUnspecified).toBe(true);
    const hidden = buildFormView({
      form: resolvePassForm({ tenant: { fields: { destination: 'hidden' } } }),
      ctx,
      enforced: true,
    });
    expect(hidden.defaultZoneId).toBe('');
  });

  it('док обязателен и у арендатора он один — подставлен; несколько доков — выбор человека', () => {
    const one = buildFormView({
      form: resolvePassForm({}),
      ctx,
      enforced: true,
      dockRequired: true,
    });
    expect(one.defaultDockId).toBe('d1');
    const optional = buildFormView({
      form: resolvePassForm({}),
      ctx,
      enforced: true,
      dockRequired: false,
    });
    expect(optional.defaultDockId).toBe('');
    const many = buildFormView({
      form: resolvePassForm({}),
      ctx: { ...ctx, docks: [...ctx.docks, { id: 'd2', number: '2' }] },
      enforced: true,
      dockRequired: true,
    });
    expect(many.defaultDockId).toBe('');
  });

  it('виды пропусков: права роли ∩ форма; вид по умолчанию — из настройки, иначе первый доступный', () => {
    const view = buildFormView({
      form: resolvePassForm({
        user: { passTypes: ['multi', 'permanent'], defaultPassType: 'permanent' },
      }),
      ctx,
      enforced: true,
      allowedPassTypes: ['single', 'multi'],
    });
    expect(view.passTypes).toEqual(['multi']);
    expect(view.defaultPassType).toBe('multi');
    expect(
      buildFormView({ form: resolvePassForm({}), ctx, enforced: true }).passTypes,
    ).toBeUndefined();
  });

  it('режимы полей: окно «по политике» берёт требование у политики; комментарий политики форма скрыть не может', () => {
    const base = resolvePassForm({ tenant: { fields: { comment: 'hidden' } } });
    const policy = buildFormView({
      form: base,
      ctx,
      enforced: true,
      windowRequiredByPolicy: true,
      commentRequiredByPolicy: true,
    });
    expect(policy.fields.window).toBe('required');
    expect(policy.fields.comment).toBe('required');
    const free = buildFormView({
      form: resolvePassForm({ site: { fields: { window: 'optional' } } }),
      ctx,
      enforced: true,
      windowRequiredByPolicy: true,
    });
    expect(free.fields.window).toBe('optional');
    expect(free.fields.driverName).toBe('hidden');
  });
});
