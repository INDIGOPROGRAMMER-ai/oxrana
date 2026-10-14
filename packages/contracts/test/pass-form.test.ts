import { describe, expect, it } from 'vitest';
import {
  applyPassFormPatch,
  DEFAULT_SINGLE_HOURS,
  defaultSingleEnd,
  fieldIsRequired,
  PASS_FORM_DEFAULTS,
  PassFormSettingsPatchSchema,
  PassFormSettingsSchema,
  passFormFieldKeys,
  resolvePassForm,
} from '../src';

const CAR = '11111111-1111-4111-8111-111111111111';
const SEMI = '22222222-2222-4222-8222-222222222222';

describe('настройка формы пропуска по уровням (этап 7b)', () => {
  it('по умолчанию: ФИО и телефон водителя скрыты, окно — по политике, разовый — 23 часа', () => {
    const form = resolvePassForm({});
    expect(form.fields.driverName).toBe('hidden');
    expect(form.fields.driverPhone).toBe('hidden');
    expect(form.fields.window).toBe('policy');
    expect(form.singleHours).toBe(DEFAULT_SINGLE_HOURS);
    expect(form.passTypes).toEqual(['single', 'multi', 'permanent']);
    expect(form.categoryIds).toBeNull();
    expect(Object.values(form.sources.fields).every((s) => s === 'default')).toBe(true);
    expect(PASS_FORM_DEFAULTS.defaultPassType).toBe('single');
  });

  it('нижний уровень переопределяет верхний по каждому ключу; источник указан', () => {
    const form = resolvePassForm({
      site: { fields: { driverName: 'optional', brand: 'required' }, singleHours: 12 },
      tenant: { fields: { driverName: 'required' }, categoryIds: [CAR, SEMI] },
      user: { categoryIds: [CAR], passTypes: ['single'] },
    });
    expect(form.fields.driverName).toBe('required');
    expect(form.sources.fields.driverName).toBe('tenant');
    expect(form.fields.brand).toBe('required');
    expect(form.sources.fields.brand).toBe('site');
    expect(form.fields.driverPhone).toBe('hidden');
    expect(form.sources.fields.driverPhone).toBe('default');
    expect(form.categoryIds).toEqual([CAR]);
    expect(form.sources.categoryIds).toBe('user');
    expect(form.passTypes).toEqual(['single']);
    expect(form.singleHours).toBe(12);
    expect(form.sources.singleHours).toBe('site');
  });

  it('вид по умолчанию вне списка видов и тип по умолчанию вне списка типов не остаются: пояснение в notes', () => {
    const form = resolvePassForm({
      tenant: { passTypes: ['multi'], categoryIds: [CAR], defaultCategoryId: SEMI },
    });
    expect(form.defaultPassType).toBe('multi');
    expect(form.defaultCategoryId).toBeNull();
    expect(form.notes).toHaveLength(2);
  });

  it('PATCH: null сбрасывает ключ к уровню выше, пустые поля формы не остаются; лишний ключ — ошибка', () => {
    const stored = PassFormSettingsSchema.parse({
      fields: { brand: 'required', comment: 'hidden' },
      singleHours: 5,
      passTypes: ['single'],
    });
    const next = applyPassFormPatch(stored, {
      fields: { brand: null },
      singleHours: null,
      defaultPassType: 'single',
    });
    expect(next).toEqual({
      fields: { comment: 'hidden' },
      passTypes: ['single'],
      defaultPassType: 'single',
    });
    expect(
      applyPassFormPatch(next, {
        fields: { comment: null },
        passTypes: null,
        defaultPassType: null,
      }),
    ).toEqual({});
    expect(PassFormSettingsPatchSchema.safeParse({ fields: { колхоз: 'hidden' } }).success).toBe(
      false,
    );
    expect(PassFormSettingsPatchSchema.safeParse({ categoryIds: [] }).success).toBe(false);
  });

  it('обязательность: «по политике» зависит от политики, остальное — от режима', () => {
    expect(fieldIsRequired('policy', true)).toBe(true);
    expect(fieldIsRequired('policy', false)).toBe(false);
    expect(fieldIsRequired('required')).toBe(true);
    expect(fieldIsRequired('optional', true)).toBe(false);
    expect(passFormFieldKeys).toContain('window');
  });

  it('окончание разового: начало + N часов, но не больше максимума объекта', () => {
    const start = Date.parse('2026-03-10T07:00:00Z');
    expect(defaultSingleEnd(start, 23, 24)).toBe(start + 23 * 3_600_000);
    expect(defaultSingleEnd(start, 23, 12)).toBe(start + 12 * 3_600_000);
  });
});
