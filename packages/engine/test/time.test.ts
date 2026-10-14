import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  formatDate,
  formatDateTime,
  formatTime,
  isWithinHours,
  localDate,
  localInstant,
  localParts,
} from '../src';
import { describeTodayHours, formatLocalDate, minutesOf } from '../src/time';
import { at } from './helpers';

const TZ = 'Asia/Yekaterinburg';

describe('локальное время объекта через Intl (ADR-009)', () => {
  it('компоненты и форматы — в поясе объекта', () => {
    const instant = Date.UTC(2026, 2, 10, 9, 5); // 09:05Z = 14:05 UTC+5, вторник
    expect(localParts(instant, TZ)).toEqual({
      year: 2026,
      month: 3,
      day: 10,
      hour: 14,
      minute: 5,
      weekday: 'tue',
      minuteOfDay: 14 * 60 + 5,
    });
    expect(localDate(instant, TZ)).toBe('2026-03-10');
    expect(formatTime(instant, TZ)).toBe('14:05');
    expect(formatDate(instant, TZ)).toBe('10.03.2026');
    expect(formatDateTime(instant, TZ)).toBe('10.03.2026 14:05');
    expect(formatDateTime(instant, 'Europe/Kaliningrad')).toBe('10.03.2026 11:05');
    expect(formatLocalDate('2026-03-09')).toBe('09.03.2026');
  });

  it('полночь — 00:00, а не 24:00', () => {
    expect(formatTime(at('2026-03-11 00:00', TZ), TZ)).toBe('00:00');
    expect(localDate(at('2026-03-11 00:00', TZ), TZ)).toBe('2026-03-11');
  });

  it('неверный пояс — ошибка настройки, а не молчаливая подмена', () => {
    expect(() => localParts(0, 'Mars/Olympus')).toThrow(RangeError);
  });

  it('рабочее время: интервалы, переход через полночь двумя интервалами, 24:00', () => {
    const hours = {
      mon: [['08:00', '20:00']] as [string, string][],
      tue: [
        ['00:00', '06:00'],
        ['22:00', '24:00'],
      ] as [string, string][],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };
    expect(isWithinHours(at('2026-03-09 08:00', TZ), hours, TZ)).toBe(true);
    expect(isWithinHours(at('2026-03-09 20:00', TZ), hours, TZ)).toBe(false);
    expect(isWithinHours(at('2026-03-10 23:59', TZ), hours, TZ)).toBe(true);
    expect(isWithinHours(at('2026-03-10 05:59', TZ), hours, TZ)).toBe(true);
    expect(isWithinHours(at('2026-03-10 12:00', TZ), hours, TZ)).toBe(false);
    expect(isWithinHours(at('2026-03-11 12:00', TZ), hours, TZ)).toBe(false);
    expect(describeTodayHours(at('2026-03-10 12:00', TZ), hours, TZ)).toBe(
      '00:00–06:00, 22:00–24:00',
    );
    expect(describeTodayHours(at('2026-03-11 12:00', TZ), hours, TZ)).toBe('сегодня выходной');
    expect(minutesOf('24:00')).toBe(1440);
  });

  it('хелпер at: местное время переводится в момент', () => {
    expect(at('2026-03-10 14:00', TZ)).toBe(Date.UTC(2026, 2, 10, 9, 0));
    expect(at('2026-03-10 14:00', 'Asia/Kamchatka')).toBe(Date.UTC(2026, 2, 10, 2, 0));
    expect(() => at('вчера', TZ)).toThrow();
  });
});

describe('addLocalDays и localInstant (перенос пропуска на другой день, этап 7a)', () => {
  it('addLocalDays сдвигает календарную дату через границы месяца и года', () => {
    expect(addLocalDays('2026-03-10', -1)).toBe('2026-03-09');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('localInstant: полночь и 14:00 по Екатеринбургу (UTC+5)', () => {
    expect(new Date(localInstant('2026-03-10', 0, 'Asia/Yekaterinburg')).toISOString()).toBe(
      '2026-03-09T19:00:00.000Z',
    );
    expect(new Date(localInstant('2026-03-10', 14 * 60, 'Asia/Yekaterinburg')).toISOString()).toBe(
      '2026-03-10T09:00:00.000Z',
    );
  });

  it('localInstant учитывает переход на летнее время (Берлин, 2026-03-29)', () => {
    expect(new Date(localInstant('2026-03-28', 12 * 60, 'Europe/Berlin')).toISOString()).toBe(
      '2026-03-28T11:00:00.000Z',
    );
    expect(new Date(localInstant('2026-03-29', 12 * 60, 'Europe/Berlin')).toISOString()).toBe(
      '2026-03-29T10:00:00.000Z',
    );
  });
});
