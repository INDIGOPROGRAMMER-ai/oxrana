import { describe, expect, it } from 'vitest';
import { patchOf } from '../src/components/pass-form/editor';

describe('редактор формы: что уходит на сервер', () => {
  it('только изменённые ключи; убранное — null («сбросить к уровню выше»)', () => {
    const saved = {
      fields: { brand: 'required' as const, comment: 'hidden' as const },
      singleHours: 5,
    };
    const draft = {
      fields: { comment: 'hidden' as const, window: 'optional' as const },
      passTypes: ['single' as const],
    };
    expect(patchOf(saved, draft)).toEqual({
      singleHours: null,
      passTypes: ['single'],
      fields: { brand: null, window: 'optional' },
    });
  });

  it('«Время начала — сейчас»: включение, выключение и сброс идут отдельным ключом', () => {
    expect(patchOf({}, { startNow: false })).toEqual({ startNow: false });
    expect(patchOf({ startNow: false }, { startNow: true })).toEqual({ startNow: true });
    expect(patchOf({ startNow: false }, {})).toEqual({ startNow: null });
    expect(patchOf({ startNow: true }, { startNow: true })).toEqual({});
  });

  it('ничего не менялось — пустое изменение', () => {
    const same = { fields: { brand: 'hidden' as const }, categoryIds: ['a'] };
    expect(patchOf(same, { ...same })).toEqual({});
  });
});
