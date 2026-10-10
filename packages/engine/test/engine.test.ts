import { describe, expect, it } from 'vitest';
import { instantToIso } from '../src';

describe('instantToIso', () => {
  it('переводит момент в ISO-строку UTC', () => {
    expect(instantToIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(instantToIso(Date.UTC(2026, 9, 10, 8, 30))).toBe('2026-10-10T08:30:00.000Z');
  });

  it('не принимает нечисловой момент', () => {
    expect(() => instantToIso(Number.NaN)).toThrow(RangeError);
  });
});
