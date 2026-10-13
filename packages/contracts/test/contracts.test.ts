import { describe, expect, it } from 'vitest';
import {
  DOMAIN_EVENT_TYPES,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES,
  ErrorBodySchema,
  PERMISSIONS,
} from '../src';

describe('коды ошибок', () => {
  it('у каждого кода есть русский текст и HTTP-статус', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code], code).toMatch(/[А-Яа-яЁё]/);
      expect(ERROR_HTTP_STATUS[code], code).toBeGreaterThanOrEqual(400);
    }
  });

  it('тело ошибки содержит code, message, field, settingLink', () => {
    const body = {
      code: 'validation_failed',
      message: 'Поле «Номер» заполнено неверно',
      field: 'plate',
      settingLink: null,
      requestId: 'req-1',
    };
    expect(ErrorBodySchema.parse(body)).toEqual(body);
  });

  it('неизвестный код и пустой текст не принимаются', () => {
    const ok = { message: 'x', field: null, settingLink: null, requestId: 'r' };
    expect(ErrorBodySchema.safeParse({ ...ok, code: 'oops' }).success).toBe(false);
    expect(ErrorBodySchema.safeParse({ ...ok, code: 'internal', message: '' }).success).toBe(false);
  });
});

describe('списки без дублей', () => {
  it.each([
    ['ERROR_CODES', ERROR_CODES],
    ['PERMISSIONS', PERMISSIONS],
    ['DOMAIN_EVENT_TYPES', DOMAIN_EVENT_TYPES],
  ] as const)('%s', (_name, list) => {
    expect(new Set<string>(list).size).toBe(list.length);
  });
});

describe('группы прав для редактора ролей', () => {
  it('каждое право входит ровно в одну группу', async () => {
    const { PERMISSION_GROUPS, PERMISSIONS } = await import('../src');
    const grouped = PERMISSION_GROUPS.flatMap((g) => g.codes);
    expect([...grouped].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('русская локаль zod подключена импортом contracts', async () => {
    const { TenantCreateSchema } = await import('../src');
    const result = TenantCreateSchema.safeParse({ legalName: 1 });
    expect(result.success).toBe(false);
    const message = result.error?.issues[0]?.message ?? '';
    expect(message).not.toMatch(/Invalid|expected/i);
  });
});
