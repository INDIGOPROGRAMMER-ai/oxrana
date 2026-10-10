import { describe, expect, it } from 'vitest';
import * as contracts from '../src';
import {
  ExceptionMatchSchema,
  GATE_POST_ONLY_PERMISSIONS,
  PERMISSIONS,
  ROLE_TEMPLATES,
  roleTemplate,
  SiteSettingsPatchSchema,
  SiteSettingsSchema,
  VEHICLE_CATEGORY_PRESET_CODES,
  VEHICLE_CATEGORY_PRESETS,
  vehicleCategoryPreset,
  WorkingHoursSchema,
} from '../src';

/** Все экспортированные списки-перечисления (`UPPER_CASE`-массивы строк). */
const lists = Object.entries(contracts as Record<string, unknown>).filter(
  (entry): entry is [string, readonly string[]] =>
    /^[A-Z][A-Z0-9_]+$/.test(entry[0]) &&
    Array.isArray(entry[1]) &&
    entry[1].every((v) => typeof v === 'string'),
);

describe('перечисления', () => {
  it.each(lists)('%s: без дублей, значения в snake_case', (_name, list) => {
    expect(new Set(list).size).toBe(list.length);
    for (const value of list) expect(value).toMatch(/^[a-z][a-z0-9_.]*$/);
  });
});

describe('рекомендованные типы транспорта (ADR-012)', () => {
  it('у каждого кода есть пресет, порядок совпадает', () => {
    expect(VEHICLE_CATEGORY_PRESETS.map((p) => p.code)).toEqual([...VEHICLE_CATEGORY_PRESET_CODES]);
  });

  it('названия — по-русски и со строчной буквы (из них собирается имя лимита)', () => {
    for (const preset of VEHICLE_CATEGORY_PRESETS) {
      expect(preset.name).toMatch(/^[а-яё]/);
    }
  });

  it('«к доку» едут грузовые типы, легковой и спецтехника — нет', () => {
    expect(vehicleCategoryPreset('semi').dockEligible).toBe(true);
    expect(vehicleCategoryPreset('light_truck').dockEligible).toBe(true);
    expect(vehicleCategoryPreset('car').dockEligible).toBe(false);
    expect(vehicleCategoryPreset('special').dockEligible).toBe(false);
  });
});

describe('права и шаблоны ролей (ADR-007)', () => {
  it('шаблоны ссылаются только на известные права, без дублей', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const template of ROLE_TEMPLATES) {
      expect(new Set(template.permissions).size, template.code).toBe(template.permissions.length);
      for (const p of template.permissions)
        expect(known.has(p), `${template.code}: ${p}`).toBe(true);
    }
    expect(new Set(ROLE_TEMPLATES.map((t) => t.code)).size).toBe(ROLE_TEMPLATES.length);
  });

  it('администратор объекта не нажимает «Впустить» и другие действия поста (A7)', () => {
    const admin = new Set<string>(roleTemplate('site_admin').permissions);
    for (const p of GATE_POST_ONLY_PERMISSIONS) expect(admin.has(p), p).toBe(false);
    expect(admin.has('pass.edit')).toBe(true);
  });

  it('пост КПП впускает, но не правит пропуска; старший смены — пост + исключение', () => {
    const post = roleTemplate('gate_post').permissions;
    expect(post).toContain('visit.check_in');
    expect(post).not.toContain('pass.edit');
    expect(post).not.toContain('gate.override');
    expect(roleTemplate('shift_senior').permissions).toEqual([...post, 'gate.override']);
  });

  it('владелец организации имеет все права', () => {
    expect(roleTemplate('org_owner').permissions).toEqual(PERMISSIONS);
  });
});

describe('настройки объекта (DATA_MODEL §3)', () => {
  it('пустой объект даёт значения по умолчанию', () => {
    const settings = SiteSettingsSchema.parse({});
    expect(settings).toMatchObject({
      singlePassMaxHours: 24,
      multiPassMinDays: 2,
      multiPassMaxDays: 31,
      singleReturnWindowMin: null,
      outsideWorkingHours: 'warn',
      undoWindowSec: 120,
      retentionDays: { visits: 1095, photos: 30, audit: 1095 },
      plateFuzzyThreshold: 0.85,
    });
  });

  it('неизвестный ключ — ошибка, а не молчаливый пропуск', () => {
    expect(SiteSettingsSchema.safeParse({ singlePassMaxHourz: 12 }).success).toBe(false);
  });

  it('рабочее время: все дни явно, интервал «с» раньше «до»', () => {
    const day = [['08:00', '20:00']];
    const week = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] };
    expect(WorkingHoursSchema.safeParse(week).success).toBe(true);
    expect(WorkingHoursSchema.safeParse({ ...week, sun: undefined }).success).toBe(false);
    expect(WorkingHoursSchema.safeParse({ ...week, mon: [['20:00', '08:00']] }).success).toBe(
      false,
    );
    expect(WorkingHoursSchema.safeParse({ ...week, mon: [['8:00', '20:00']] }).success).toBe(false);
  });
});

describe('совпадение исключения (RULES_ENGINE §5)', () => {
  it('ровно один вариант', () => {
    expect(ExceptionMatchSchema.safeParse({ tenant: true }).success).toBe(true);
    expect(ExceptionMatchSchema.safeParse({ plates: ['A001BC174'] }).success).toBe(true);
    expect(ExceptionMatchSchema.safeParse({ plates: [] }).success).toBe(false);
    expect(ExceptionMatchSchema.safeParse({ tenant: true, plates: ['A001BC174'] }).success).toBe(
      false,
    );
    expect(ExceptionMatchSchema.safeParse({ categoryIds: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('настройки объекта: PATCH', () => {
  it('те же ключи, что у SiteSettingsSchema, и без значений по умолчанию', () => {
    expect(Object.keys(SiteSettingsPatchSchema.shape).sort()).toEqual(
      Object.keys(SiteSettingsSchema.shape).sort(),
    );
    expect(SiteSettingsPatchSchema.parse({ singlePassMaxHours: 12 })).toEqual({
      singlePassMaxHours: 12,
    });
  });
});
