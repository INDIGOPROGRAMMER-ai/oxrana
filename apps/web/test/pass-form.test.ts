import type { CabinetContext, PassView } from '@oxrana/contracts';
import { describe, expect, it } from 'vitest';
import { addDays, instantToLocal } from '../src/lib/dates';
import {
  type BuildContext,
  buildPassBody,
  formField,
  type PassFormValues,
} from '../src/lib/pass-form';
import { describeChanges, statusView } from '../src/lib/pass-text';

const NOW = Date.parse('2026-03-10T07:00:00Z'); // 12:00 по Екатеринбургу
const ctx: BuildContext = {
  tenantId: 't1',
  timezone: 'Asia/Yekaterinburg',
  today: '2026-03-10',
  nowMs: NOW,
  commentRequired: false,
  windowRequired: false,
  dockRequired: false,
};
const base: PassFormValues = {
  participant: 'vehicle',
  plate: 'А123ВС174 ',
  categoryId: 'car',
  brand: '',
  driverName: '',
  driverPhone: '',
  personName: '',
  personDocument: '',
  passType: 'single',
  date: '2026-03-10',
  windowFromTime: '',
  windowToTime: '',
  from: '',
  to: '',
  windowFrom: '',
  windowTo: '',
  dockId: '',
  destinationZoneId: '',
  purposeId: '',
  comment: '',
};

describe('форма пропуска → тело POST /passes', () => {
  it('разовый на сегодня без окна: начало — «сейчас» по часам сервера, конец — 23:59 объекта; номер без пробела', () => {
    const built = buildPassBody(base, ctx);
    expect(built.ok && built.body).toMatchObject({
      tenantId: 't1',
      passType: 'single',
      participant: 'vehicle',
      plate: 'А123ВС174',
      categoryId: 'car',
      validFrom: '2026-03-10T07:00:00.000Z',
    });
    expect(built.ok && new Date(String(built.body.validTo)).toISOString()).toBe(
      '2026-03-10T18:59:00.000Z',
    );
    // пустые необязательные поля в тело не попадают
    expect(built.ok && Object.keys(built.body)).not.toContain('brand');
  });

  it('разовый с окном: начало пропуска — начало окна, окно по времени объекта, а не браузера', () => {
    const built = buildPassBody({ ...base, windowFromTime: '14:00', windowToTime: '16:00' }, ctx);
    expect(built.ok && new Date(String(built.body.validFrom)).toISOString()).toBe(
      '2026-03-10T09:00:00.000Z',
    );
    expect(built.ok && new Date(String(built.body.windowFrom)).toISOString()).toBe(
      '2026-03-10T09:00:00.000Z',
    );
    expect(built.ok && new Date(String(built.body.windowTo)).toISOString()).toBe(
      '2026-03-10T11:00:00.000Z',
    );
  });

  it('будущий день без окна — с 00:00 объекта', () => {
    const built = buildPassBody({ ...base, date: '2026-03-12' }, ctx);
    expect(built.ok && new Date(String(built.body.validFrom)).toISOString()).toBe(
      '2026-03-11T19:00:00.000Z',
    );
  });

  it('ошибки у полей до запроса: номер, тип, окно целиком, дата в прошлом, док и комментарий по правилам', () => {
    const empty = buildPassBody({ ...base, plate: ' ', categoryId: '' }, ctx);
    expect(empty).toMatchObject({
      ok: false,
      errors: { plate: 'Укажите номер машины.', categoryId: 'Выберите тип транспорта.' },
    });
    const half = buildPassBody({ ...base, windowFromTime: '12:00' }, ctx);
    expect(half).toMatchObject({
      ok: false,
      errors: { windowToTime: expect.stringContaining('целиком') },
    });
    const backwards = buildPassBody(
      { ...base, windowFromTime: '14:00', windowToTime: '12:00' },
      ctx,
    );
    expect(backwards).toMatchObject({
      ok: false,
      errors: { windowToTime: expect.stringContaining('позже') },
    });
    const past = buildPassBody({ ...base, date: '2026-03-09' }, ctx);
    expect(past).toMatchObject({
      ok: false,
      errors: { date: expect.stringContaining('в прошлом') },
    });
    const rules = buildPassBody(base, {
      ...ctx,
      commentRequired: true,
      windowRequired: true,
      dockRequired: true,
    });
    expect(rules).toMatchObject({
      ok: false,
      errors: {
        comment: expect.stringContaining('для чего'),
        windowFromTime: expect.stringContaining('обязательно'),
        dockId: 'Укажите док.',
      },
    });
  });

  it('многоразовый: нужны обе даты, конец не раньше начала; постоянный — только начало', () => {
    const multi = buildPassBody(
      { ...base, passType: 'multi', from: '2026-03-10', to: '2026-03-14', comment: 'Ревизия' },
      ctx,
    );
    expect(multi.ok && multi.body).toMatchObject({ passType: 'multi', comment: 'Ревизия' });
    expect(buildPassBody({ ...base, passType: 'multi', from: '2026-03-10' }, ctx)).toMatchObject({
      ok: false,
      errors: { to: expect.stringContaining('по какую') },
    });
    expect(
      buildPassBody({ ...base, passType: 'multi', from: '2026-03-14', to: '2026-03-12' }, ctx),
    ).toMatchObject({ ok: false, errors: { to: 'Окончание раньше начала.' } });
    const permanent = buildPassBody({ ...base, passType: 'permanent', from: '2026-03-10' }, ctx);
    expect(permanent.ok && 'validTo' in permanent.body).toBe(false);
  });

  it('пешеход: имя обязательно, номера и типа в теле нет', () => {
    const built = buildPassBody(
      {
        ...base,
        participant: 'pedestrian',
        plate: 'А1',
        categoryId: 'car',
        personName: 'Петров П. П.',
      },
      ctx,
    );
    expect(built.ok && built.body).toMatchObject({
      participant: 'pedestrian',
      personName: 'Петров П. П.',
    });
    expect(built.ok && Object.keys(built.body)).not.toContain('plate');
    expect(
      buildPassBody({ ...base, participant: 'pedestrian', personName: '' }, ctx),
    ).toMatchObject({
      ok: false,
      errors: { personName: expect.stringContaining('фамилию') },
    });
  });

  it('поле сервера → поле формы зависит от типа пропуска', () => {
    expect(formField('validFrom', 'single')).toBe('date');
    expect(formField('validFrom', 'multi')).toBe('from');
    expect(formField('windowFrom', 'single')).toBe('windowFromTime');
    expect(formField('windowTo', 'permanent')).toBe('windowTo');
    expect(formField('dockId', 'single')).toBe('dockId');
    expect(formField('что-то-неизвестное', 'single')).toBeNull();
  });
});

describe('даты и статусы кабинета', () => {
  it('addDays через границы месяца', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('момент → значение поля «дата и время» в поясе объекта', () => {
    expect(instantToLocal('2026-03-10T09:00:00.000Z', 'Asia/Yekaterinburg')).toBe(
      '2026-03-10T14:00',
    );
    expect(instantToLocal(null, 'Asia/Yekaterinburg')).toBe('');
  });

  const site: CabinetContext = {
    tenant: {
      id: 't',
      name: 'Альфа',
      status: 'active',
      isOperator: false,
      trucksDockRequired: true,
      defaultCategoryId: null,
      contractValidTo: null,
    },
    site: {
      id: 's',
      name: 'Объект',
      timezone: 'Asia/Yekaterinburg',
      timezoneLabel: 'Челябинск, UTC+5',
    },
    categories: [{ id: 'semi', name: 'фура', dockEligible: true, available: true }],
    zones: [],
    purposes: [],
    docks: [
      { id: 'd12', number: '12' },
      { id: 'd14', number: '14' },
    ],
    today: '2026-03-10',
    now: '2026-03-10T07:00:00.000Z',
  };
  const pass = (over: Partial<PassView>): PassView =>
    ({
      status: 'approved',
      approvalChanges: null,
      approvalNote: null,
      cancelledReason: null,
      validFrom: '2026-03-10T05:00:00.000Z',
      ...over,
    }) as PassView;

  it('«одобрено с изменениями: …» называет поле, было и стало по-человечески', () => {
    const view = statusView(
      pass({
        approvalChanges: {
          dockId: { from: 'd12', to: 'd14' },
          validTo: { from: '2026-03-10T15:00:00.000Z', to: '2026-03-10T13:00:00.000Z' },
        },
      }),
      site,
      NOW,
    );
    expect(view.label).toBe('Одобрено с изменениями');
    expect(view.details).toEqual([
      'изменено: док: № 12 → № 14',
      'изменено: окончание: 10.03.2026 20:00 → 10.03.2026 18:00',
    ]);
    expect(describeChanges(null, site)).toEqual([]);
  });

  it('согласование и отказ видны в статусе вместе с причиной', () => {
    expect(statusView(pass({ status: 'pending_approval' }), site, NOW).label).toBe(
      'На согласовании',
    );
    expect(
      statusView(pass({ status: 'rejected', approvalNote: 'Нет места' }), site, NOW),
    ).toMatchObject({
      tone: 'danger',
      label: 'Отклонено',
      details: ['Причина: Нет места'],
    });
    expect(
      statusView(pass({ status: 'cancelled', cancelledReason: 'Ошибка' }), site, NOW).details,
    ).toEqual(['Причина: Ошибка']);
    expect(statusView(pass({ validFrom: '2026-03-11T05:00:00.000Z' }), site, NOW).label).toBe(
      'Одобрен, ещё не начался',
    );
  });
});

describe('компании человека в кабинете', () => {
  it('уникальные арендаторы из назначений ролей; назначения без арендатора не считаются', async () => {
    const { tenantsOf } = await import('../src/components/cabinet/cabinet-context');
    expect(
      tenantsOf([
        { tenantId: 'a', tenantName: 'Альфа' },
        { tenantId: 'b', tenantName: 'Бета' },
        { tenantId: 'a', tenantName: 'Альфа' },
        { tenantId: null, tenantName: null },
      ]),
    ).toEqual([
      { id: 'a', name: 'Альфа' },
      { id: 'b', name: 'Бета' },
    ]);
    expect(tenantsOf([])).toEqual([]);
  });
});
