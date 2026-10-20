import { describe, expect, it } from 'vitest';
import {
  type CommonTime,
  ownTime,
  parseDateCell,
  parseTimeCell,
  rowTime,
  splitStamp,
  type TimeEnv,
} from '../src/lib/batch-time';
import {
  type BatchCatalog,
  type BatchRow,
  type BatchSettings,
  batchDraft,
  parseBatchRows,
} from '../src/lib/pass-batch';

const TODAY = '2026-10-15';
// 15.10.2026 13:44 по Екатеринбургу (UTC+5)
const NOW = Date.parse('2026-10-15T08:44:00Z');
const env: TimeEnv = {
  todayIso: TODAY,
  nowMs: NOW,
  timezone: 'Asia/Yekaterinburg',
  startNow: true,
  singleHours: 23,
  singleMaxHours: 24,
};
const common: CommonTime = { date: TODAY, start: '', end: '', from: TODAY, to: '' };
const blank = { dateText: '', fromText: '', toText: '' };

describe('ячейки «Дата», «С», «По» из Excel', () => {
  it.each([
    ['15.10.2026', '2026-10-15'],
    ['15.10.26', '2026-10-15'],
    ['15.10', '2026-10-15'],
    ['2026-10-16', '2026-10-16'],
    ['16/10/2026', '2026-10-16'],
    ['46310', '2026-10-15'], // число Excel
  ])('дата «%s»', (text, iso) => {
    expect(parseDateCell(text, TODAY)).toEqual({ value: iso });
  });

  it.each([
    ['13:44', '13:44'],
    ['1344', '13:44'],
    ['13.44', '13:44'],
    ['9', '09:00'],
    ['13:44:00', '13:44'],
    ['0,5', '12:00'], // доля суток Excel
  ])('время «%s»', (text, time) => {
    expect(parseTimeCell(text)).toEqual({ value: time });
  });

  it('пусто — null; непонятное — ошибка с примером формата', () => {
    expect(parseDateCell('  ', TODAY)).toBeNull();
    expect(parseTimeCell('')).toBeNull();
    expect(parseDateCell('вчера', TODAY)).toMatchObject({
      error: expect.stringContaining('15.10.2026'),
    });
    expect(parseTimeCell('25:99')).toMatchObject({ error: expect.stringContaining('13:44') });
  });

  it('в «С» может стоять дата со временем', () => {
    expect(splitStamp('16.10.2026 12:30')).toEqual({ date: '16.10.2026', time: '12:30' });
    expect(splitStamp('12:30')).toEqual({ date: '', time: '12:30' });
    const own = ownTime(
      'single',
      { dateText: '', fromText: '16.10.2026 12:30', toText: '' },
      TODAY,
    );
    expect(own).toMatchObject({ date: '2026-10-16', start: '12:30', end: '' });
  });
});

describe('время строки: своё или общее', () => {
  it('пустые ячейки — общие значения: дата сверху, «сейчас» и окончание = начало + часы', () => {
    const t = rowTime('single', blank, common, env);
    expect(t).toMatchObject({
      date: TODAY,
      startTime: '13:44',
      endTime: '12:44',
      startAuto: true,
      endAuto: true,
      own: false,
    });
  });

  it('свои значения строки важнее общих; общее время подставляется только в пустые ячейки', () => {
    const shared: CommonTime = { ...common, start: '09:00', end: '18:00' };
    expect(rowTime('single', blank, shared, env)).toMatchObject({
      startTime: '09:00',
      endTime: '18:00',
      startAuto: false,
      endAuto: false,
    });
    const own = rowTime(
      'single',
      { dateText: '16.10.2026', fromText: '10:00', toText: '' },
      shared,
      env,
    );
    expect(own).toMatchObject({
      date: '2026-10-16',
      startTime: '10:00',
      endTime: '18:00',
      own: true,
    });
  });

  it('окончание не задано — начало + часы, но не больше максимума объекта', () => {
    const limited = { ...env, singleHours: 23, singleMaxHours: 10 };
    const t = rowTime('single', { dateText: '', fromText: '08:00', toText: '' }, common, limited);
    expect(t).toMatchObject({ startTime: '08:00', endTime: '18:00', endAuto: true });
  });

  it('многоразовый и постоянный: «С» и «По» — даты; пустые — общие; «Дата» годится вместо «С»', () => {
    const shared: CommonTime = { ...common, from: '2026-10-15', to: '2026-10-20' };
    expect(rowTime('multi', blank, shared, env)).toMatchObject({
      from: '2026-10-15',
      to: '2026-10-20',
    });
    expect(
      rowTime('multi', { dateText: '', fromText: '16.10.2026', toText: '18.10.2026' }, shared, env),
    ).toMatchObject({ from: '2026-10-16', to: '2026-10-18', own: true });
    expect(
      rowTime('multi', { dateText: '17.10.2026', fromText: '', toText: '' }, shared, env).from,
    ).toBe('2026-10-17');
  });

  it('нераспознанная ячейка — ошибка строки, а не молчаливая подмена общим значением', () => {
    const t = rowTime('single', { dateText: '', fromText: 'после обеда', toText: '' }, common, env);
    expect(t.error).toContain('после обеда');
  });
});

describe('пакет: у каждой строки свой срок, итог — в поясе объекта', () => {
  const catalog: BatchCatalog = {
    categories: [{ id: 'car', name: 'легковой', dockEligible: false }],
    docks: [],
    defaultCategoryId: 'car',
  };
  const settings: BatchSettings = {
    passType: 'single',
    date: TODAY,
    start: '',
    end: '',
    from: TODAY,
    to: '',
    comment: '',
  };
  const context = {
    timezone: 'Asia/Yekaterinburg',
    today: TODAY,
    nowMs: NOW,
    pastToleranceMin: 5,
    singleMaxHours: 24,
  };
  const HEADER = 'Номер\tТип\tДата\tС\tПо';
  /** Строки под заголовком «Номер · Тип · Дата · С · По» (колонки узнаются по заголовкам, как в Excel). */
  const rows = (text: string): BatchRow[] =>
    parseBatchRows(`${HEADER}\n${text}`, catalog).rows.flatMap((r) => (r.value ? [r.value] : []));

  it('заголовки «Дата», «С», «По» распознаются; три строки с разным временем и одна пустая', () => {
    const imported = rows(
      [
        'А111АА174\tлегковой\t15.10.2026\t14:00\t16:00',
        'А222АА174\tлегковой\t16.10.2026\t09:00\t18:00',
        'А333АА174\tлегковой\t15.10.2026\t22:00\t06:00',
        'А444АА174\tлегковой\t\t\t',
      ].join('\n'),
    );
    expect(imported[0]).toMatchObject({
      dateText: '15.10.2026',
      fromText: '14:00',
      toText: '16:00',
    });
    const span = (row: BatchRow) => {
      const built = batchDraft(row, settings, context);
      if (!built.ok) throw new Error(built.error);
      return built.span;
    };
    expect(span(imported[0] as BatchRow)).toBe('15.10 14:00 → 15.10 16:00');
    expect(span(imported[1] as BatchRow)).toBe('16.10 09:00 → 16.10 18:00');
    expect(span(imported[2] as BatchRow)).toBe('15.10 22:00 → 16.10 06:00');
    // пустая строка — общее время: «сейчас» и +23 ч
    expect(span(imported[3] as BatchRow)).toBe('15.10 13:44 → 16.10 12:44');
  });

  it('общее время сверху — значение по умолчанию для строк с пустой ячейкой', () => {
    const [empty, own] = rows('А111АА174\tлегковой\n' + 'А222АА174\tлегковой\t\t11:00\t20:00');
    const shared = { ...settings, start: '14:00', end: '16:30' };
    const a = batchDraft(empty as BatchRow, shared, context);
    const b = batchDraft(own as BatchRow, { ...shared, start: '14:00' }, context);
    expect(a.ok && a.span).toBe('15.10 14:00 → 15.10 16:30');
    // у второй строки своё время важнее общего (но 11:00 уже прошло — своя ошибка с исправлением)
    expect(b.ok).toBe(false);
  });

  it('начало уже прошло: ошибка называет время, кнопка ставит «сейчас»', () => {
    const [row] = rows('А111АА174\tлегковой\t\t11:00\t15:00');
    const built = batchDraft(row as BatchRow, settings, context);
    expect(built).toMatchObject({ ok: false, error: expect.stringContaining('11:00') });
    if (built.ok) throw new Error('ожидалась ошибка');
    expect(built.fixes).toEqual([{ label: 'Начать с 13:44', patch: { fromText: '13:44' } }]);
  });

  it('срок длиннее максимума объекта: ошибка называет время, кнопка укорачивает до максимума', () => {
    const [row] = rows('А111АА174\tлегковой\t\t14:00\t23:59');
    const built = batchDraft(row as BatchRow, settings, { ...context, singleMaxHours: 8 });
    expect(built).toMatchObject({ ok: false, error: expect.stringContaining('8 ч') });
    if (built.ok) throw new Error('ожидалась ошибка');
    expect(built.fixes).toEqual([{ label: 'Закончить в 22:00', patch: { toText: '22:00' } }]);
  });

  it('дата в прошлом — кнопка «Поставить сегодня»', () => {
    const [row] = rows('А111АА174\tлегковой\t14.10.2026\t\t');
    const built = batchDraft(row as BatchRow, settings, context);
    if (built.ok) throw new Error('ожидалась ошибка');
    expect(built.error).toContain('в прошлом');
    expect(built.fixes).toContainEqual({ label: 'Поставить сегодня', patch: { dateText: TODAY } });
  });

  it('многоразовый: «С» и «По» строки — даты пропуска', () => {
    const multi: BatchSettings = {
      ...settings,
      passType: 'multi',
      to: '2026-10-20',
      comment: 'Ревизия',
    };
    const [own, empty] = rows('А111АА174\tлегковой\t\t16.10.2026\t18.10.2026\nА222АА174\tлегковой');
    const a = batchDraft(own as BatchRow, multi, context);
    expect(a.ok && a.span).toBe('16.10 00:00 → 18.10 23:59');
    const b = batchDraft(empty as BatchRow, multi, context);
    expect(b.ok && b.span).toBe('15.10 13:44 → 20.10 23:59');
  });
});

describe('7b.3: «По» с датой, дата-время Excel числом, «ДД.ММ» без года', () => {
  const catalog: BatchCatalog = {
    categories: [{ id: 'car', name: 'легковой', dockEligible: false }],
    docks: [],
    defaultCategoryId: 'car',
  };
  const settings: BatchSettings = {
    passType: 'single',
    date: TODAY,
    start: '',
    end: '',
    from: TODAY,
    to: '',
    comment: '',
  };
  const context = {
    timezone: 'Asia/Yekaterinburg',
    today: TODAY,
    nowMs: NOW,
    pastToleranceMin: 5,
    singleMaxHours: 24,
  };
  const draft = (cells: string, ctx: Partial<typeof context> = {}) => {
    const [row] = parseBatchRows(`Номер\tТип\tДата\tС\tПо\n${cells}`, catalog).rows.flatMap((r) =>
      r.value ? [r.value] : [],
    );
    return batchDraft(row as BatchRow, settings, { ...context, ...ctx });
  };

  describe('2.1 конец по дате и времени', () => {
    it('«С» 16.10 08:00, «По» 17.10 09:00: дата не теряется — срок 25 ч длиннее максимума, ошибка с кнопкой', () => {
      const built = draft('А111АА174\tлегковой\t\t16.10.2026 08:00\t17.10.2026 09:00');
      if (built.ok) throw new Error('ожидалась ошибка, а пропуск ушёл бы на 1 час');
      expect(built.error).toContain('действует дольше максимума объекта — 24 ч');
      expect(built.error).toContain('16.10.2026 08:00');
      expect(built.error).toContain('17.10.2026 09:00');
      expect(built.fixes).toEqual([
        { label: 'Закончить в 08:00', patch: { toText: '17.10.2026 08:00' } },
      ]);
    });

    it('в пределах максимума объекта конец следующего дня берётся из ячейки', () => {
      const built = draft('А111АА174\tлегковой\t\t16.10.2026 08:00\t17.10.2026 06:00');
      expect(built.ok && built.span).toBe('16.10 08:00 → 17.10 06:00');
      const longer = draft('А111АА174\tлегковой\t\t16.10.2026 08:00\t17.10.2026 09:00', {
        singleMaxHours: 48,
      });
      expect(longer.ok && longer.span).toBe('16.10 08:00 → 17.10 09:00');
    });

    it('дата указана явно, а конец раньше начала — ошибка, а не «завтра»', () => {
      const built = draft('А111АА174\tлегковой\t\t16.10.2026 10:00\t16.10.2026 09:00');
      if (built.ok) throw new Error('ожидалась ошибка');
      expect(built.error).toContain('раньше начала');
      expect(built.error).not.toContain('завтра');
      const earlierDay = draft('А111АА174\tлегковой\t\t16.10.2026 10:00\t15.10.2026 18:00');
      expect(earlierDay.ok).toBe(false);
    });

    it('без даты в «По» поведение прежнее: 22:00 → 06:00 — это следующая ночь', () => {
      const built = draft('А111АА174\tлегковой\t15.10.2026\t22:00\t06:00');
      expect(built.ok && built.span).toBe('15.10 22:00 → 16.10 06:00');
    });

    it('дата конца без времени — ошибка строки, а не молчаливое «начало + N часов»', () => {
      const built = draft('А111АА174\tлегковой\t\t16.10.2026 08:00\t17.10.2026');
      expect(built).toMatchObject({ ok: false, error: expect.stringContaining('без времени') });
    });

    it('rowTime отдаёт день конца; в предпросмотре он правится отдельно', () => {
      const t = rowTime(
        'single',
        { dateText: '', fromText: '16.10.2026 08:00', toText: '17.10.2026 06:00' },
        common,
        env,
      );
      expect(t).toMatchObject({
        date: '2026-10-16',
        startTime: '08:00',
        endTime: '06:00',
        endDate: '2026-10-17',
      });
      expect(rowTime('single', blank, common, env).endDate).toBe('');
    });
  });

  describe('2.2 дата-время Excel одним числом', () => {
    it('46311.33: целая часть — дата, дробная — время', () => {
      expect(splitStamp('46311.33')).toEqual({ date: '2026-10-16', time: '07:55' });
      expect(splitStamp('46311,3333333333')).toEqual({ date: '2026-10-16', time: '08:00' });
      expect(splitStamp('46311')).toEqual({ date: '46311', time: '' });
      // без пяти полночь, округлённая до минуты, — это уже следующий день
      expect(splitStamp('46311.99999')).toEqual({ date: '2026-10-17', time: '00:00' });
    });

    it('в «С» и «По» разового: дата и время берутся оба', () => {
      const own = ownTime(
        'single',
        { dateText: '', fromText: '46311.3333333333', toText: '46311.75' },
        TODAY,
      );
      expect(own).toMatchObject({
        date: '2026-10-16',
        start: '08:00',
        end: '18:00',
        endDate: '2026-10-16',
        error: null,
      });
    });

    it('строка из файла: пропуск 16.10 08:00 → 17.10 06:00', () => {
      const built = draft('А111АА174\tлегковой\t\t46311.3333333333\t46312.25');
      expect(built.ok && built.span).toBe('16.10 08:00 → 17.10 06:00');
    });

    it('многоразовый: число с датой и временем даёт дату', () => {
      const multi = { ...settings, passType: 'multi' as const, to: '2026-10-20' };
      const [row] = parseBatchRows(
        'Номер\tТип\tДата\tС\tПо\nА111АА174\tлегковой\t\t46311.5\t46313.25',
        catalog,
      ).rows.flatMap((r) => (r.value ? [r.value] : []));
      const built = batchDraft(row as BatchRow, multi, context);
      expect(built.ok && built.span).toBe('16.10 00:00 → 18.10 23:59');
    });
  });

  describe('2.3 «ДД.ММ» без года', () => {
    const NEW_YEAR_EVE = '2026-12-31';
    it('31.12 вводят «02.01» — это 2 января следующего года', () => {
      expect(parseDateCell('02.01', NEW_YEAR_EVE)).toEqual({ value: '2027-01-02' });
      expect(parseDateCell('2.1', NEW_YEAR_EVE)).toEqual({ value: '2027-01-02' });
      expect(parseDateCell('31.12', NEW_YEAR_EVE)).toEqual({ value: '2026-12-31' });
    });

    it('сегодня и будущие дни этого года остаются в этом году, прошедшие — в следующем', () => {
      expect(parseDateCell('15.10', TODAY)).toEqual({ value: '2026-10-15' });
      expect(parseDateCell('16.10', TODAY)).toEqual({ value: '2026-10-16' });
      expect(parseDateCell('14.10', TODAY)).toEqual({ value: '2027-10-14' });
    });

    it('допуск объекта: сразу после полуночи «вчера» ещё не прошло', () => {
      const grace = { minutesIntoDay: 3, toleranceMin: 5 };
      expect(parseDateCell('14.10', TODAY, grace)).toEqual({ value: '2026-10-14' });
      expect(parseDateCell('14.10', TODAY, { minutesIntoDay: 6, toleranceMin: 5 })).toEqual({
        value: '2027-10-14',
      });
      expect(parseDateCell('13.10', TODAY, grace)).toEqual({ value: '2027-10-13' });
    });

    it('несуществующий день — ошибка, а не молчаливая подмена', () => {
      expect(parseDateCell('31.02', TODAY)).toMatchObject({ error: expect.any(String) });
    });

    it('в ячейке «Дата» разового: строка 31.12 с датой «02.01» уходит на 02.01 следующего года', () => {
      const ctx = {
        timezone: 'Asia/Yekaterinburg',
        today: NEW_YEAR_EVE,
        nowMs: Date.parse('2026-12-31T08:44:00Z'),
        pastToleranceMin: 5,
        singleMaxHours: 24,
      };
      const [row] = parseBatchRows(
        'Номер\tТип\tДата\tС\tПо\nА111АА174\tлегковой\t02.01\t09:00\t18:00',
        catalog,
      ).rows.flatMap((r) => (r.value ? [r.value] : []));
      const built = batchDraft(row as BatchRow, { ...settings, date: NEW_YEAR_EVE }, ctx);
      expect(built.ok && built.span).toBe('02.01 09:00 → 02.01 18:00');
      if (built.ok) expect(built.draft.validFrom).toBe('2027-01-02T09:00:00.000+05:00');
    });
  });
});
