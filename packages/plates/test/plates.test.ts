import { describe, expect, it } from 'vitest';
import { plateDigits } from '../src';

describe('plateDigits', () => {
  it('оставляет только цифры', () => {
    expect(plateDigits('А123ВС 174')).toBe('123174');
    expect(plateDigits('a 123 bc-74')).toBe('12374');
  });

  it('пустая строка и строка без цифр дают пустую строку', () => {
    expect(plateDigits('')).toBe('');
    expect(plateDigits('АВС')).toBe('');
  });
});
