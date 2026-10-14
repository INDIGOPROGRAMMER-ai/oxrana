import { describe, expect, it } from 'vitest';
import {
  type BatchCatalog,
  type BatchSettings,
  batchDraft,
  parseBatchRows,
  parseFleetRows,
  parseWindow,
} from '../src/lib/pass-batch';

const catalog: BatchCatalog = {
  categories: [
    { id: 'car', name: 'легковой' },
    { id: 'semi', name: 'фура' },
    { id: 'heavy', name: 'грузовой свыше 5 т' },
  ],
  docks: [
    { id: 'd12', number: '12' },
    { id: 'dz1', number: 'З1' },
  ],
  defaultCategoryId: 'car',
};

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

describe('разбор вставленных строк пропусков (08_ «Пакетный ввод»)', () => {
  it('Excel (Tab): разные типы в одной пачке, пробел в номере, тип по умолчанию, заголовок пропускается', () => {
    const text = [
      'Номер\tТип\tМарка\tВодитель\tОкно\tКомментарий\tДок',
      'А123ВС174 \tфура\tVolvo\tИванов И. И.\t12:00-14:00\tразгрузка\t12',
      'В456НР174\t\tKia',
      'О777ОО174\tЛЕГКОВОЙ',
    ].join('\n');
    const rows = parseBatchRows(text, catalog);
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(rows[0]?.value).toMatchObject({
      plate: 'А123ВС174',
      categoryId: 'semi',
      brand: 'Volvo',
      driverName: 'Иванов И. И.',
      dockId: 'd12',
      window: { date: '', from: '12:00', to: '14:00' },
      comment: 'разгрузка',
    });
    expect(rows[1]?.value?.categoryId).toBe('car');
    expect(rows[1]?.note).toBe('тип по умолчанию: легковой');
    expect(rows[2]?.value?.categoryId).toBe('car');
  });

  it('красные строки называют причину: нет номера, неизвестный тип, чужой док, плохое окно', () => {
    const rows = parseBatchRows(
      [
        '\tфура',
        'А111АА174\tсамокат',
        'А222АА174\tфура\t\t\t\t\t99',
        'А333АА174\tфура\t\t\tпозже',
        'А444АА174\tфура',
      ].join('\n'),
      catalog,
    );
    expect(rows.map((r) => r.error ?? 'ok')).toEqual([
      'Нет номера — первая ячейка пуста.',
      expect.stringContaining(
        'Тип «самокат» не найден среди доступных вашей компании: легковой, фура',
      ),
      expect.stringContaining('Док «99» не закреплён за вашей компанией. Ваши доки: 12, З1'),
      expect.stringContaining('не распознано'),
      'ok',
    ]);
  });

  it('без типа у арендатора без типа по умолчанию — ошибка, а не молчаливая подмена', () => {
    const rows = parseBatchRows('А555АА174', { ...catalog, defaultCategoryId: null });
    expect(rows[0]?.error).toContain('Не указан тип транспорта');
  });

  it('запятые вместо табуляции (письмо, CSV)', () => {
    const rows = parseBatchRows('А123ВС174, фура, Volvo\nВ456НР174, легковой', catalog);
    expect(rows.map((r) => r.value?.categoryId)).toEqual(['semi', 'car']);
  });

  it('разделитель «;» и кавычки', () => {
    const rows = parseBatchRows('А123ВС174;фура;"Volvo; FH"', catalog);
    expect(rows[0]?.value?.brand).toBe('Volvo; FH');
  });

  it('тип можно написать сокращённо, если он однозначен', () => {
    const rows = parseBatchRows('А123ВС174\tгрузовой', catalog);
    expect(rows[0]?.value?.categoryId).toBe('heavy');
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
  const line = parseBatchRows('А123ВС174\tфура\t\t\t12:00-14:00\t\t12', catalog)[0]?.value;

  it('разовый с окном: начало — начало окна по времени объекта, конец — 23:59, окно целиком', () => {
    if (!line) throw new Error('строка не разобрана');
    const built = batchDraft(line, settings, context);
    expect(built).toMatchObject({ ok: true });
    expect(built.ok && built.draft).toMatchObject({
      passType: 'single',
      participant: 'vehicle',
      plate: 'А123ВС174',
      categoryId: 'semi',
      dockId: 'd12',
      validFrom: expect.stringMatching(/^2026-03-10T12:00:00/),
    });
    expect(built.ok && 'tenantId' in built.draft).toBe(false);
  });

  it('дата в строке важнее даты пачки; прошлая дата — понятная ошибка', () => {
    const past = parseBatchRows('А123ВС174\tфура\t\t\t01.03.2026 12:00-14:00', catalog)[0]?.value;
    if (!past) throw new Error('строка не разобрана');
    const built = batchDraft(past, settings, context);
    expect(built).toMatchObject({ ok: false, error: expect.stringContaining('в прошлом') });
  });

  it('многоразовый: комментарий пачки подставляется в строки без своего', () => {
    if (!line) throw new Error('строка не разобрана');
    const multi: BatchSettings = {
      passType: 'multi',
      date: '',
      from: '2026-03-10',
      to: '2026-03-14',
      comment: 'Ревизия',
    };
    const built = batchDraft({ ...line, window: null }, multi, context);
    expect(built.ok && built.draft).toMatchObject({ passType: 'multi', comment: 'Ревизия' });
  });
});

describe('вставка автопарка', () => {
  it('Номер · Тип · Марка · Водитель · Телефон; повтор номера внутри списка — ошибка строки', () => {
    const rows = parseFleetRows(
      [
        'А123ВС174\tфура\tVolvo\tИванов\t+7 900 000-00-00',
        'а123вс174 \tфура',
        'В456НР174\t\t',
      ].join('\n'),
      catalog,
    );
    expect(rows[0]?.value).toMatchObject({ categoryId: 'semi', driverPhone: '+7 900 000-00-00' });
    expect(rows[1]?.error).toContain('уже встречается выше');
    expect(rows[2]?.value?.categoryId).toBe('car');
  });
});
