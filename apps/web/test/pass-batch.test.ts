import { describe, expect, it } from 'vitest';
import {
  type BatchCatalog,
  type BatchRow,
  type BatchSettings,
  batchDraft,
  matchCategory,
  parseBatchRows,
  parseFleetRows,
  parseWindow,
  stem,
} from '../src/lib/pass-batch';

const catalog: BatchCatalog = {
  categories: [
    { id: 'car', name: 'легковой', dockEligible: false },
    { id: 'light', name: 'малотоннажный', dockEligible: true },
    { id: 'semi', name: 'фура', dockEligible: true },
    { id: 'heavy', name: 'грузовой свыше 5 т', dockEligible: true },
    { id: 'heavy2', name: 'грузовой до 5 т', dockEligible: true },
  ],
  docks: [
    { id: 'd12', number: '12' },
    { id: 'dz1', number: 'З1' },
  ],
  zones: [
    { id: 'z1', name: 'Склад А' },
    { id: 'z2', name: 'Офис' },
  ],
  defaultCategoryId: 'car',
};

const rowsOf = (text: string, cat = catalog) => parseBatchRows(text, cat).rows;

describe('окно прибытия из ячейки таблицы', () => {
  it.each([
    ['12:00-14:00', '', '12:00', '14:00'],
    ['с 12:00 до 14:30', '', '12:00', '14:30'],
    ['12.00–14.00', '', '12:00', '14:00'],
    ['12-14', '', '12:00', '14:00'],
    ['10.03.2026 9:30-11:00', '2026-03-10', '09:30', '11:00'],
  ])('«%s»', (text, date, from, to) => {
    expect(parseWindow(text)).toEqual({ date, from, to });
  });

  it('пусто — окна нет; непонятное и перевёрнутое — ошибка с подсказкой формата', () => {
    expect(parseWindow('  ')).toBeNull();
    expect(parseWindow('после обеда')).toMatchObject({
      error: expect.stringContaining('12:00-14:00'),
    });
    expect(parseWindow('14:00-12:00')).toMatchObject({
      error: expect.stringContaining('позже начала'),
    });
    expect(parseWindow('25:00-26:00')).toMatchObject({ error: expect.any(String) });
  });
});

describe('тип транспорта: регистр, формы слова, неоднозначность (этап 7b)', () => {
  it('основа слова: окончания падежей и родов отброшены', () => {
    expect(stem('Легковые')).toBe(stem('легковой'));
    expect(stem('малотоннажные')).toBe(stem('Малотоннажный'));
    expect(stem('фуры')).toBe(stem('фура'));
  });

  it.each([
    ['легковые', 'car'],
    ['ЛЕГКОВОЙ', 'car'],
    ['Легковая', 'car'],
    ['малотоннажные', 'light'],
    ['Малотоннажный', 'light'],
    ['фуры', 'semi'],
    ['Фура', 'semi'],
    ['грузовой свыше 5 т', 'heavy'],
    ['грузовые свыше 5 т', 'heavy'],
  ])('«%s» → %s', (text, id) => {
    expect(matchCategory(text, catalog.categories)).toMatchObject({ kind: 'ok', id });
  });

  it('«грузовой» при двух грузовых типах — не угадывается: предлагаются оба', () => {
    const match = matchCategory('грузовой', catalog.categories);
    expect(match).toMatchObject({ kind: 'ambiguous' });
    expect(match.kind === 'ambiguous' && match.candidates.map((c) => c.id).sort()).toEqual([
      'heavy',
      'heavy2',
    ]);
  });

  it('неизвестный тип — none', () => {
    expect(matchCategory('самокат', catalog.categories)).toEqual({ kind: 'none' });
  });
});

describe('разбор таблицы пропусков (08_ «Пакетный ввод»)', () => {
  it('Excel (Tab): разные типы в одной пачке, пробелы в номере, тип по умолчанию, заголовок пропускается', () => {
    const text = [
      'Номер\tТип\tМарка\tВодитель\tОкно\tКомментарий\tДок',
      'А 123 ВС 174 \tфуры\tVolvo\tИванов И. И.\t12:00-14:00\tразгрузка\t12',
      'В456НР174\t\tKia',
      'О777ОО174\tЛЕГКОВЫЕ',
    ].join('\n');
    const imported = parseBatchRows(text, catalog);
    expect(imported.headerFound).toBe(true);
    const rows = imported.rows;
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(rows[0]?.value).toMatchObject({
      plate: 'А 123 ВС 174',
      categoryId: 'semi',
      brand: 'Volvo',
      driverName: 'Иванов И. И.',
      dockId: 'd12',
      windowText: '12:00-14:00',
      comment: 'разгрузка',
    });
    expect(rows[1]?.value).toMatchObject({
      categoryId: 'car',
      note: 'тип по умолчанию: легковой',
    });
    expect(rows[2]?.value?.categoryId).toBe('car');
  });

  it('колонки по заголовку: порядок любой, лишние колонки игнорируются', () => {
    const imported = parseBatchRows(
      ['Док\tГос. номер\tТип ТС\tПримечание\tНЕНУЖНОЕ', '12\tА123ВС174\tфура\tсрочно\tх'].join(
        '\n',
      ),
      catalog,
    );
    expect(imported.headerFound).toBe(true);
    expect(imported.rows[0]?.value).toMatchObject({
      plate: 'А123ВС174',
      categoryId: 'semi',
      dockId: 'd12',
      comment: 'срочно',
    });
  });

  it('первая строка с номером — это данные, а не заголовок', () => {
    const imported = parseBatchRows('А123ВС174\tТип\tфура', catalog);
    expect(imported.headerFound).toBe(false);
    expect(imported.rows).toHaveLength(1);
  });

  it('неоднозначный и неизвестный тип, чужой док — строка остаётся, с замечанием и без угадывания', () => {
    const rows = rowsOf(
      [
        '\tфура',
        'А111АА174\tсамокат',
        'А222АА174\tгрузовой',
        'А333АА174\tфура\t\t\t\t\t99',
        'А444АА174\tфура',
      ].join('\n'),
    );
    expect(rows[0]?.error).toBe('Нет номера — ячейка с номером пуста.');
    expect(rows[1]?.value).toMatchObject({ categoryId: '' });
    expect(rows[1]?.value?.problems.category).toContain('не найден среди доступных');
    expect(rows[2]?.value).toMatchObject({ categoryId: '' });
    expect([...(rows[2]?.value?.candidates ?? [])].sort()).toEqual(['heavy', 'heavy2']);
    expect(rows[2]?.value?.problems.category).toContain('подходит к нескольким типам');
    expect(rows[3]?.value?.problems.dock).toContain('Ваши доки: 12, З1');
    expect(rows[4]?.value?.problems).toEqual({});
  });

  it('без типа у арендатора без типа по умолчанию — строка просит выбрать тип, подмены нет', () => {
    const rows = rowsOf('А555АА174', { ...catalog, defaultCategoryId: null });
    expect(rows[0]?.value).toMatchObject({ categoryId: '' });
    expect(rows[0]?.value?.problems.category).toContain('выберите');
  });

  it('единственный доступный тип подставляется с пометкой', () => {
    const one: BatchCatalog = {
      ...catalog,
      categories: [{ id: 'car', name: 'легковой' }],
      defaultCategoryId: null,
    };
    expect(rowsOf('А555АА174', one)[0]?.value).toMatchObject({
      categoryId: 'car',
      note: 'единственный доступный тип: легковой',
    });
  });

  it('запятые вместо табуляции (письмо, CSV) и «;» с кавычками', () => {
    expect(
      rowsOf('А123ВС174, фура, Volvo\nВ456НР174, легковой').map((r) => r.value?.categoryId),
    ).toEqual(['semi', 'car']);
    expect(rowsOf('А123ВС174;фура;"Volvo; FH"')[0]?.value?.brand).toBe('Volvo; FH');
  });

  it('колонки, отключённые формой, игнорируются — и об этом сообщается', () => {
    const imported = parseBatchRows('А123ВС174\tфура\tVolvo\tИванов И. И.\t12:00-14:00', catalog, {
      brand: 'optional',
      driverName: 'hidden',
      driverPhone: 'hidden',
      window: 'hidden',
      destination: 'optional',
      purpose: 'optional',
      comment: 'optional',
    });
    expect([...imported.ignoredColumns].sort()).toEqual(['Водитель', 'Окно']);
    expect(imported.rows[0]?.value).toMatchObject({
      brand: 'Volvo',
      driverName: '',
      windowText: '',
    });
  });

  it('место назначения из колонки сопоставляется со справочником', () => {
    const imported = parseBatchRows('Номер\tТип\tМесто\nА123ВС174\tфура\tсклад а', catalog);
    expect(imported.rows[0]?.value?.zoneId).toBe('z1');
    const bad = parseBatchRows('Номер\tТип\tМесто\nА123ВС174\tфура\tгараж', catalog);
    expect(bad.rows[0]?.value?.problems.zone).toContain('не найдено');
  });
});

describe('строка пачки → тело для сервера', () => {
  const settings: BatchSettings = {
    passType: 'single',
    date: '2026-03-10',
    from: '2026-03-10',
    to: '',
    comment: '',
  };
  const context = {
    timezone: 'Asia/Yekaterinburg',
    today: '2026-03-10',
    nowMs: Date.parse('2026-03-10T07:00:00Z'),
  };
  const line = (text: string): BatchRow => {
    const value = rowsOf(text)[0]?.value;
    if (!value) throw new Error('строка не разобрана');
    return value;
  };

  it('разовый с окном позже «сейчас»: начало — начало окна по времени объекта, док и окно в теле', () => {
    const built = batchDraft(line('А123ВС174\tфура\t\t\t14:00-16:00\t\t12'), settings, context);
    expect(built).toMatchObject({ ok: true });
    expect(built.ok && built.draft).toMatchObject({
      passType: 'single',
      participant: 'vehicle',
      plate: 'А123ВС174',
      categoryId: 'semi',
      dockId: 'd12',
      validFrom: expect.stringMatching(/^2026-03-10T14:00:00/),
    });
    expect(built.ok && 'tenantId' in built.draft).toBe(false);
  });

  it('окно началось раньше «сейчас»: конкретная ошибка и кнопка «Начать окно с …» меняет окно строки', () => {
    // сейчас 12:00, окно 11:00–14:00: пропуск начинается «сейчас», окно — раньше него
    const built = batchDraft(line('А123ВС174\tлегковой\t\t\t11:00-14:00'), settings, context);
    expect(built).toMatchObject({
      ok: false,
      error: 'Окно 11:00–14:00 начинается раньше начала пропуска (12:00).',
    });
    if (built.ok) throw new Error('ожидалась ошибка');
    expect(built.fixes).toEqual([
      { label: 'Начать окно с 12:00', patch: { windowText: '12:00–14:00' } },
    ]);
    // применили исправление — строка проходит
    const fixed = batchDraft(
      { ...line('А123ВС174\tлегковой'), windowText: '12:00–14:00' },
      settings,
      context,
    );
    expect(fixed.ok).toBe(true);
  });

  it('дата в строке важнее даты пачки; прошлая дата — понятная ошибка', () => {
    const built = batchDraft(
      line('А123ВС174\tфура\t\t\t01.03.2026 12:00-14:00'),
      settings,
      context,
    );
    expect(built).toMatchObject({ ok: false, error: expect.stringContaining('в прошлом') });
  });

  it('строка без выбранного типа не уходит на сервер: причина — выберите тип', () => {
    const row = line('А123ВС174\tсамокат');
    expect(batchDraft(row, settings, context)).toMatchObject({
      ok: false,
      error: expect.stringContaining('не найден'),
    });
    // выбрал тип в предпросмотре — замечание снимается и строка готова
    const fixed = batchDraft({ ...row, categoryId: 'car', problems: {} }, settings, context);
    expect(fixed).toMatchObject({ ok: true });
  });

  it('док нужен грузовому: без него — ошибка у строки, после выбора в предпросмотре — готово', () => {
    const row = line('А123ВС174\tфура');
    const needs = { ...context, dockRequiredFor: (id: string) => id === 'semi' };
    expect(batchDraft(row, settings, needs)).toMatchObject({ ok: false, error: 'Укажите док.' });
    expect(batchDraft({ ...row, dockId: 'dz1' }, settings, needs)).toMatchObject({ ok: true });
  });

  it('док нужен только разовому пропуску: пакет многоразовых и постоянных идёт без дока', () => {
    const row = line('А123ВС174\tфура');
    const needs = { ...context, dockRequiredFor: (id: string) => id === 'semi' };
    const multi: BatchSettings = {
      passType: 'multi',
      date: '',
      from: '2026-03-10',
      to: '2026-03-14',
      comment: 'Ревизия',
    };
    expect(batchDraft(row, multi, needs).ok).toBe(true);
    const permanent: BatchSettings = { ...multi, passType: 'permanent', to: '' };
    expect(batchDraft(row, permanent, needs).ok).toBe(true);
  });

  it('многоразовый: комментарий пачки подставляется в строки без своего', () => {
    const multi: BatchSettings = {
      passType: 'multi',
      date: '',
      from: '2026-03-10',
      to: '2026-03-14',
      comment: 'Ревизия',
    };
    const built = batchDraft(line('А123ВС174\tфура'), multi, context);
    expect(built.ok && built.draft).toMatchObject({ passType: 'multi', comment: 'Ревизия' });
  });
});

describe('вставка автопарка', () => {
  it('Номер · Тип · Марка · Водитель · Телефон; повтор номера внутри списка — ошибка строки', () => {
    const rows = parseFleetRows(
      [
        'А123ВС174\tфуры\tVolvo\tИванов\t+7 900 000-00-00',
        'а123вс 174 \tфура',
        'В456НР174\t\t',
        'С789ТУ174\tгрузовой',
      ].join('\n'),
      catalog,
    );
    expect(rows[0]?.value).toMatchObject({ categoryId: 'semi', driverPhone: '+7 900 000-00-00' });
    expect(rows[1]?.error).toContain('уже встречается выше');
    expect(rows[2]?.value?.categoryId).toBe('car');
    expect(rows[3]?.error).toContain('подходит к нескольким типам');
  });
});
