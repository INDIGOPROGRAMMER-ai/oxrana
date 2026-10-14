import type { CabinetContext } from '@oxrana/contracts';
import { describe, expect, it } from 'vitest';
import { extensionLimitMs, extensionOutcome } from '../src/lib/pass-extension';
import { endAfter, endsNextDay, minutesOfTime, timeOf } from '../src/lib/pass-time';
import { stayText } from '../src/lib/stay';

const site: CabinetContext['site'] = {
  id: 's',
  name: 'Объект',
  timezone: 'Asia/Yekaterinburg',
  timezoneLabel: 'Челябинск, UTC+5',
  pastStartToleranceMin: 10,
  singlePassMaxHours: 24,
  multiPassMaxDays: 31,
};

describe('время формы пропуска', () => {
  it('текущее время — в поясе объекта по заданному моменту, а не браузера', () => {
    expect(timeOf(Date.parse('2026-03-10T07:05:00Z'), site.timezone)).toBe('12:05');
    expect(timeOf(Date.parse('2026-03-10T19:30:00Z'), site.timezone)).toBe('00:30');
  });

  it('окончание по умолчанию — начало + N часов, не больше максимума; за полночь — «завтра»', () => {
    expect(endAfter('12:00', 6, 24)).toEqual({ time: '18:00', nextDay: false });
    expect(endAfter('12:00', 23, 24)).toEqual({ time: '11:00', nextDay: true });
    expect(endAfter('12:00', 30, 24)).toEqual({ time: '12:00', nextDay: true });
    expect(endAfter('23:30', 1, 24)).toEqual({ time: '00:30', nextDay: true });
    expect(minutesOfTime('09:30')).toBe(570);
  });

  it('окончание не позже начала — следующие сутки; пустое — нет', () => {
    expect(endsNextDay('20:00', '09:00')).toBe(true);
    expect(endsNextDay('09:00', '18:00')).toBe(false);
    expect(endsNextDay('', '18:00')).toBe(false);
    expect(endsNextDay('09:00', '')).toBe(false);
  });

  it('время на территории: минуты, часы, сутки', () => {
    const t = Date.parse('2026-03-10T07:00:00Z');
    expect(stayText(t, t + 40 * 60_000)).toBe('40 мин');
    expect(stayText(t, t + 135 * 60_000)).toBe('2 ч 15 мин');
    expect(stayText(t, t + (2 * 24 + 4) * 3_600_000)).toBe('2 сут 4 ч');
    expect(stayText(t, t - 1000)).toBe('0 мин');
  });
});

describe('продление «действует до» после въезда (Q-85)', () => {
  const single = {
    passType: 'single' as const,
    validFrom: '2026-03-10T07:00:00.000Z',
    validTo: '2026-03-10T15:00:00.000Z',
  };
  it('разовый: предел — максимум разового пропуска от начала', () => {
    expect(extensionLimitMs(single, site)).toBe(Date.parse('2026-03-11T07:00:00Z'));
    expect(extensionOutcome(single, site, '2026-03-10T10:00:00.000Z')).toBe('shorten');
    expect(extensionOutcome(single, site, '2026-03-11T07:00:00.000Z')).toBe('within');
    expect(extensionOutcome(single, site, '2026-03-11T07:01:00.000Z')).toBe('beyond');
    expect(extensionOutcome(single, site, single.validTo)).toBe('same');
    expect(extensionOutcome(single, site, null)).toBe('same');
  });
  it('многоразовый: предел — конец последнего из разрешённых дней объекта; постоянный — без предела', () => {
    const multi = {
      passType: 'multi' as const,
      validFrom: '2026-03-10T07:00:00.000Z',
      validTo: '2026-03-14T15:00:00.000Z',
    };
    // 31 день от 10.03 → до 10.04 00:00 по Челябинску (09.04 19:00 UTC) не включая
    expect(extensionLimitMs(multi, site)).toBe(Date.parse('2026-04-09T19:00:00Z') - 1);
    expect(extensionOutcome(multi, site, '2026-04-09T18:00:00.000Z')).toBe('within');
    expect(extensionOutcome(multi, site, '2026-04-09T19:00:00.000Z')).toBe('beyond');
    expect(
      extensionLimitMs({ passType: 'permanent', validFrom: multi.validFrom }, site),
    ).toBeNull();
  });
});
