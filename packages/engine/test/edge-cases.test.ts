import { describe, expect, it } from 'vitest';
import {
  applicableQuotas,
  capacityOf,
  collectWaivers,
  countOccupancy,
  overageDays,
  type QuotaView,
  type RoutingRuleView,
  resolveCandidates,
  resolvePedestrian,
} from '../src';
import {
  at,
  categoryId,
  check,
  DAY,
  exceptionId,
  fx,
  gateId,
  pedestrianPass,
  quotaId,
  TZ,
  tenantId,
  traceOf,
  vehiclePass,
  visit,
  zoneId,
} from './helpers';

const semi = (extra: Parameters<typeof vehiclePass>[0] extends infer T ? Partial<T> : never = {}) =>
  vehiclePass({
    tenant: 'dns',
    category: 'semi',
    window: [`${DAY} 11:00`, `${DAY} 13:00`],
    dock: '12',
    ...extra,
  });

describe('смена суток по поясу объекта (UTC+5) при подсчёте сверхлимита', () => {
  it('неполные сутки = полные: 23:59 → 00:01 следующего дня — 2 суток', () => {
    expect(overageDays(at(`${DAY} 23:59`), at('2026-03-11 00:01'), TZ)).toBe(2);
  });

  it('местные сутки, а не UTC: 02:00 → 23:00 того же местного дня — 1 сутки, хотя по UTC это два дня', () => {
    expect(overageDays(at(`${DAY} 02:00`), at(`${DAY} 23:00`), TZ)).toBe(1);
  });

  it('22:00 → 03:00 следующего местного дня — 2 суток, хотя по UTC это один день', () => {
    expect(overageDays(at(`${DAY} 22:00`), at('2026-03-11 03:00'), TZ)).toBe(2);
  });

  it('ровно полночь по местному времени — уже следующие сутки', () => {
    expect(overageDays(at(`${DAY} 10:00`), at('2026-03-11 00:00'), TZ)).toBe(2);
  });

  it('выезд раньше въезда (сбой часов) — 1 сутки, а не 0', () => {
    expect(overageDays(at(`${DAY} 10:00`), at(`${DAY} 09:00`), TZ)).toBe(1);
  });

  it('длинное пребывание: 10.03 → 15.03 — 6 суток', () => {
    expect(overageDays(at(`${DAY} 10:00`), at('2026-03-15 10:00'), TZ)).toBe(6);
  });
});

describe('машина в нескольких лимитах — действует самый строгий', () => {
  const extraQuota: QuotaView = {
    id: 'q-all-vehicles',
    tenantId: tenantId('dns'),
    participant: 'vehicle',
    categoryIds: [categoryId('car'), categoryId('semi')],
    name: 'Все машины',
    capacity: 3,
    capacityFromDocks: false,
    counting: 'on_site',
    enforcement: 'hard',
    overageTariffRub: null,
    overageCap: null,
    schedule: null,
    validFrom: at('2026-01-01 00:00'),
    validTo: null,
    basis: null,
  };
  const rules = { quotas: [...fx.rules.quotas, extraQuota] };

  it('оба лимита проверяются, в quotaStates — оба', () => {
    const v = check({
      gate: 'kpp2',
      subject: semi(),
      occupancy: { 'dns/trucks': 10 },
      rules,
      // occupancy по дополнительному лимиту задаётся отдельно: его нет в ключах фикстуры
    });
    expect(v.quotaStates.map((q) => q.name)).toEqual(['Грузовые', 'Все машины']);
    expect(v.code).toBe('allow');
  });

  it('свободно в «Грузовые», но полно в «Все машины» — ждать', () => {
    const input = {
      gate: 'kpp2',
      subject: semi(),
      occupancy: { 'dns/trucks': 10 },
      rules,
    } as const;
    const v = check({
      ...input,
      overrides: [],
      site: {},
    });
    expect(v.code).toBe('allow');
    const full = check({
      ...input,
      rules: { quotas: [...fx.rules.quotas, { ...extraQuota, capacity: 0 }] },
    });
    expect(full.code).toBe('deny');
    expect(full.headline).toBe('ДНС: все машины — не предусмотрено договором (лимит 0)');
    expect(full.quotaStates).toHaveLength(2);
  });

  it('жёсткий «ждите» строже мягкого «сверх лимита»', () => {
    const soft: QuotaView = {
      ...extraQuota,
      enforcement: 'soft',
      overageTariffRub: 100,
      capacity: 0,
    };
    // лимит 0 всегда запрет, поэтому мягкому ставим вместимость 1 и занятость через countOccupancy не нужна:
    const softOne = { ...soft, capacity: 1 };
    const v = check({
      gate: 'kpp2',
      subject: semi(),
      occupancy: { 'dns/trucks': 25 },
      rules: { quotas: [...fx.rules.quotas, softOne] },
    });
    expect(v.code).toBe('wait');
    expect(v.headline).toBe('ДНС грузовые 25/25 — ждите');
  });

  it('applicableQuotas учитывает расписание лимита и срок действия', () => {
    const scheduled: QuotaView = {
      ...extraQuota,
      id: 'q-night',
      schedule: { mon: [], tue: [['22:00', '24:00']], wed: [], thu: [], fri: [], sat: [], sun: [] },
    };
    const expired: QuotaView = { ...extraQuota, id: 'q-old', validTo: at('2026-02-01 00:00') };
    const future: QuotaView = { ...extraQuota, id: 'q-new', validFrom: at('2027-01-01 00:00') };
    const all = [scheduled, expired, future, extraQuota];
    const target = { categoryId: categoryId('semi') };
    expect(
      applicableQuotas(all, tenantId('dns'), target, at(`${DAY} 12:00`), TZ).map((q) => q.id),
    ).toEqual(['q-all-vehicles']);
    expect(
      applicableQuotas(all, tenantId('dns'), target, at(`${DAY} 22:30`), TZ).map((q) => q.id),
    ).toEqual(['q-night', 'q-all-vehicles']);
    expect(applicableQuotas(all, tenantId('x5'), target, at(`${DAY} 12:00`), TZ)).toEqual([]);
    expect(applicableQuotas(all, tenantId('dns'), 'pedestrian', at(`${DAY} 12:00`), TZ)).toEqual(
      [],
    );
  });
});

describe('лимит 0 и отсутствие лимита', () => {
  it('лимит 0 = «не предусмотрено договором» даже при пустой территории', () => {
    const v = check({ gate: 'kpp1', subject: vehiclePass({ tenant: 'multon', category: 'car' }) });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('Мултон: легковые — не предусмотрено договором (лимит 0)');
  });

  it('нет лимита на тип = без ограничения: оператор объекта едет без лимитов', () => {
    const v = check({
      gate: 'kpp2',
      subject: vehiclePass({
        tenant: 'integratsiya',
        category: 'semi',
        window: [`${DAY} 11:00`, `${DAY} 13:00`],
      }),
    });
    expect(v.code).toBe('allow');
    expect(traceOf(v, 'quota')).toMatchObject({ result: 'pass', details: { reason: 'no_quota' } });
    expect(v.quotaStates).toEqual([]);
    expect(v.headline).toBe('Пропуск действует — впускайте');
  });

  it('исключение снимает и лимит 0 (Q-8)', () => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'multon', category: 'car' }),
      rules: {
        exceptions: [
          {
            id: 'exc-multon',
            tenantId: tenantId('multon'),
            name: 'Директор',
            match: { tenant: true },
            waives: ['quota'],
            validFrom: at('2026-01-01 00:00'),
            validTo: null,
            guardText: null,
            basis: null,
          },
        ],
      },
    });
    expect(v.code).toBe('allow');
    expect(v.infoLines).toContain('Исключение: Директор');
  });

  it('мягкий лимит с потолком сверхлимита: выше потолка — ждать; информирующий — предупреждение', () => {
    const capped = fx.rules.quotas.map((q) =>
      q.id === quotaId('dl_trans/cars') ? { ...q, overageCap: 1 } : q,
    );
    const over = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dl_trans', category: 'car' }),
      occupancy: { 'dl_trans/cars': 16 },
      rules: { quotas: capped },
    });
    expect(over.code).toBe('wait');
    expect(over.headline).toMatch(/потолок сверхлимита \(1\) исчерпан/);
    const within = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dl_trans', category: 'car' }),
      occupancy: { 'dl_trans/cars': 15 },
      rules: { quotas: capped },
    });
    expect(within.code).toBe('allow_overage');

    const info = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dl_trans', category: 'car' }),
      occupancy: { 'dl_trans/cars': 15 },
      rules: {
        quotas: fx.rules.quotas.map((q) =>
          q.id === quotaId('dl_trans/cars') ? { ...q, enforcement: 'warn' as const } : q,
        ),
      },
    });
    expect(info.code).toBe('allow');
    expect(info.reasons[0]?.code).toBe('quota_exceeded_info');
  });

  it('мягкий лимит без тарифа — сверх лимита с тарифом 0', () => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dl_trans', category: 'car' }),
      occupancy: { 'dl_trans/cars': 15 },
      rules: {
        quotas: fx.rules.quotas.map((q) =>
          q.id === quotaId('dl_trans/cars') ? { ...q, overageTariffRub: null } : q,
        ),
      },
    });
    expect(v.overage).toEqual({ quotaId: quotaId('dl_trans/cars'), tariffRub: 0 });
  });

  it('countOccupancy и capacityOf: визит по исключению место не занимает, вместимость «по докам»', () => {
    const trucks = fx.rules.quotas.find((q) => q.id === quotaId('dns/trucks')) as QuotaView;
    const special = fx.rules.quotas.find((q) => q.id === quotaId('dns/special')) as QuotaView;
    const a = semi();
    const b = vehiclePass({ tenant: 'dns', category: 'light_truck' });
    const bus = vehiclePass({ tenant: 'dns', category: 'car', plate: 'A001AA174' });
    const other = vehiclePass({ tenant: 'x5', category: 'semi' });
    const ped = pedestrianPass({ tenant: 'dns' });
    const open = [
      visit(a),
      visit(b),
      visit(bus, { waivesQuota: true }),
      visit(other),
      visit(ped, { gate: 'kpp1' }),
      visit(a, { timeOut: `${DAY} 11:00` }),
    ];
    expect(countOccupancy(open, trucks)).toBe(2);
    expect(countOccupancy(open, special)).toBe(0);
    const pedestrianQuota: QuotaView = {
      ...trucks,
      id: 'q-ped',
      participant: 'pedestrian',
      categoryIds: [],
    };
    expect(countOccupancy(open, pedestrianQuota)).toBe(1);
    expect(capacityOf(trucks, fx.rules.docks)).toBe(25);
    expect(capacityOf({ ...trucks, capacityFromDocks: false, capacity: 7 }, fx.rules.docks)).toBe(
      7,
    );
  });
});

describe('исключения снимают проверки', () => {
  const exception = (
    match: Parameters<typeof collectWaivers>[1][number]['match'],
    waives: Parameters<typeof collectWaivers>[1][number]['waives'],
    extra: Partial<Parameters<typeof collectWaivers>[1][number]> = {},
  ) => ({
    id: 'exc-test',
    tenantId: tenantId('dns'),
    name: 'Тест',
    match,
    waives,
    validFrom: at('2026-01-01 00:00'),
    validTo: null,
    guardText: 'Тестовое исключение',
    basis: null,
    ...extra,
  });

  it('по типу транспорта и по id пропуска; истёкшее исключение не действует', () => {
    const pass = semi();
    const byCategory = collectWaivers(
      pass,
      [exception({ categoryIds: [categoryId('semi')] }, ['inspection'])],
      at(`${DAY} 12:00`),
    );
    expect([...byCategory.waived]).toEqual(['inspection']);
    const byPass = collectWaivers(
      pass,
      [exception({ passIds: [pass.id] }, ['routing', 'quota'])],
      at(`${DAY} 12:00`),
    );
    expect([...byPass.waived].sort()).toEqual(['quota', 'routing']);
    const expired = collectWaivers(
      pass,
      [exception({ passIds: [pass.id] }, ['quota'], { validTo: at(`${DAY} 11:00`) })],
      at(`${DAY} 12:00`),
    );
    expect(expired.applied).toEqual([]);
    const otherTenant = collectWaivers(
      pass,
      [exception({ tenant: true }, ['quota'], { tenantId: tenantId('x5') })],
      at(`${DAY} 12:00`),
    );
    expect(otherTenant.applied).toEqual([]);
    const wrongPlate = collectWaivers(
      pass,
      [exception({ plates: ['X000XX00'] }, ['quota'])],
      at(`${DAY} 12:00`),
    );
    expect(wrongPlate.applied).toEqual([]);
  });

  it('«все КПП» для руководства (Q-54): исключение routing снимает и «кого пропускает», и маршрут', () => {
    const pass = vehiclePass({ tenant: 'integratsiya', category: 'semi' });
    const v = check({
      gate: 'office',
      subject: pass,
      rules: {
        exceptions: [
          exception({ passIds: [pass.id] }, ['routing'], { tenantId: null, name: 'Руководство' }),
        ],
      },
    });
    expect(v.code).toBe('allow');
    expect(traceOf(v, 'gate_admits')).toMatchObject({
      result: 'skipped',
      skippedBy: { exceptionId: 'exc-test' },
    });
    expect(traceOf(v, 'routing')).toMatchObject({ result: 'skipped' });
  });

  it('inspection ничего не проверяет — только строка охраннику', () => {
    const v = check({
      gate: 'kpp2',
      subject: semi(),
      rules: { exceptions: [exception({ categoryIds: [categoryId('semi')] }, ['inspection'])] },
    });
    expect(v.code).toBe('allow');
    expect(v.infoLines).toContain('Исключение: Тестовое исключение');
    expect(v.trace.every((t) => !('exceptionId' in (t.skippedBy ?? {})))).toBe(true);
  });

  it('исключение X5 совпадает только с пропусками X5', () => {
    const v = check({ gate: 'kpp2', now: `${DAY} 03:00`, subject: semi() });
    expect(v.appliedExceptionIds).toEqual([]);
    expect(v.reasons.some((r) => r.code === 'outside_working_hours')).toBe(true);
    expect(exceptionId('x5_24_7')).toBeTruthy();
  });
});

describe('«кого пропускает» КПП и внутренний пост', () => {
  it('машина на посту «только пешеходы» — не тот КПП, подсказать некого', () => {
    const v = check({ gate: 'office', subject: vehiclePass({ tenant: 'dns', category: 'car' }) });
    expect(v.code).toBe('wrong_gate');
    expect(v.headline).toBe('Легковой через этот КПП не проходят');
    expect(v.suggestedGateIds).toEqual([]);
  });

  it('пешеход на КПП «машины и пешеходы» без правил арендатора — проходит', () => {
    const v = check({ gate: 'kpp1', subject: pedestrianPass({ tenant: 'x5' }) });
    expect(v.code).toBe('allow');
    expect(traceOf(v, 'pedestrian_rule')).toMatchObject({ details: { reason: 'no_rule' } });
  });

  it('внутренний пост: место назначения — другая зона → не тот пост', () => {
    const v = check({
      gate: 'office',
      subject: pedestrianPass({ tenant: 'dns', destinationZone: 'warehouse' }),
    });
    expect(v.code).toBe('wrong_gate');
    expect(v.headline).toBe('Место назначения — Основной склад: этот пост туда не ведёт');
  });

  it('внутренний пост: пропуск без места назначения — проход разрешён, визит не меняется', () => {
    const v = check({ gate: 'office', subject: pedestrianPass({ tenant: 'dl_trans' }) });
    expect(v.code).toBe('allow');
    expect(v.primaryAction).toBe('passage');
    expect(traceOf(v, 'routing')).toMatchObject({ details: { reason: 'no_destination' } });
    expect(v.infoLines[0]).toMatch(/откройте дверь 1-го этажа/);
  });

  it('внутренний пост без правил маршрута ведёт по зоне КПП', () => {
    const v = check({
      gate: 'office',
      subject: pedestrianPass({ tenant: 'kontinent', destinationZone: 'office' }),
      rules: { routing: fx.rules.routing.filter((r) => r.participant === 'vehicle') },
    });
    expect(v.code).toBe('allow');
    const other = check({
      gate: 'office',
      subject: pedestrianPass({ tenant: 'kontinent', destinationZone: 'building5' }),
      rules: { routing: fx.rules.routing.filter((r) => r.participant === 'vehicle'), zones: [] },
    });
    expect(other.code).toBe('wrong_gate');
    expect(other.headline).toBe('Место назначения — другая зона: этот пост туда не ведёт');
  });

  it('внутренний пост: статусные проверки идут, лимиты и окно пропущены', () => {
    const v = check({
      gate: 'office',
      subject: pedestrianPass({ tenant: 'dl_trans', status: 'cancelled' }),
    });
    expect(v.code).toBe('deny');
    expect(traceOf(v, 'working_hours')).toMatchObject({ skippedBy: { reason: 'internal_gate' } });
    expect(traceOf(v, 'dock_required')).toMatchObject({ skippedBy: { reason: 'internal_gate' } });
  });

  it('маршрут арендатора приоритетнее маршрута объекта; без правил — любой КПП', () => {
    const tenantRule: RoutingRuleView = {
      id: 'rr-dns-semi-kpp1',
      tenantId: tenantId('dns'),
      participant: 'vehicle',
      categoryId: categoryId('semi'),
      destinationZoneId: null,
      gateId: gateId('kpp1'),
      direction: 'in',
      priority: 10,
    };
    const v = check({
      gate: 'kpp1',
      subject: semi(),
      rules: { routing: [...fx.rules.routing, tenantRule] },
    });
    expect(traceOf(v, 'routing')).toMatchObject({
      result: 'pass',
      details: { ruleIds: ['rr-dns-semi-kpp1'] },
    });
    const atKpp2 = check({
      gate: 'kpp2',
      subject: semi(),
      rules: { routing: [...fx.rules.routing, tenantRule] },
    });
    expect(atKpp2.code).toBe('wrong_gate');
    expect(atKpp2.headline).toBe('Фура — через КПП-1');
    const noRules = check({ gate: 'kpp1', subject: semi(), rules: { routing: [] } });
    expect(traceOf(noRules, 'routing')).toMatchObject({ details: { reason: 'no_rules' } });
  });

  it('пешеход с назначением в офис на КПП-1 — проходит периметр, не тот КПП не показывается', () => {
    const v = check({
      gate: 'kpp1',
      subject: pedestrianPass({ tenant: 'kontinent', destinationZone: 'office' }),
    });
    expect(v.code).toBe('allow');
  });
});

describe('выезд', () => {
  it('выезд через любой КПП; не тот въездной КПП — только подсказка', () => {
    const pass = semi();
    const v = check({ gate: 'kpp1', direction: 'out', subject: pass, openVisit: visit(pass) });
    expect(v.code).toBe('allow');
    expect(v.primaryAction).toBe('check_out');
    expect(v.headline).toBe('Выпускайте');
    expect(v.reasons[0]).toMatchObject({
      code: 'other_gate_on_entry',
      message: 'Въезд для этого типа — через КПП-2; выезд разрешён',
    });
  });

  it('явное правило маршрута на выезд соблюдается', () => {
    const pass = semi();
    const outRule: RoutingRuleView = {
      id: 'rr-out',
      tenantId: null,
      participant: 'vehicle',
      categoryId: categoryId('semi'),
      destinationZoneId: null,
      gateId: gateId('kpp2'),
      direction: 'out',
      priority: 100,
    };
    const wrong = check({
      gate: 'kpp1',
      direction: 'out',
      subject: pass,
      openVisit: visit(pass),
      rules: { routing: [...fx.rules.routing, outRule] },
    });
    expect(wrong.code).toBe('wrong_gate');
    expect(wrong.headline).toBe('Выезд для этого типа — через КПП-2');
    const right = check({
      gate: 'kpp2',
      direction: 'out',
      subject: pass,
      openVisit: visit(pass),
      rules: { routing: [...fx.rules.routing, outRule] },
    });
    expect(right.code).toBe('allow');
  });

  it('чёрный список на выезде — предупреждение, выпускать всегда (Q-10)', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car', plate: 'X666XX66' });
    const rules = {
      blacklist: [
        {
          id: 'bl-1',
          plateNorm: 'X666XX66',
          personName: null,
          reason: 'долг по актам',
          validTo: null,
        },
      ],
    };
    const out = check({
      gate: 'kpp1',
      direction: 'out',
      subject: pass,
      openVisit: visit(pass, { gate: 'kpp1' }),
      rules,
    });
    expect(out.code).toBe('allow');
    expect(out.reasons[0]?.code).toBe('blacklisted_leaving');
    const inbound = check({ gate: 'kpp1', subject: pass, rules });
    expect(inbound.code).toBe('deny');
    expect(inbound.headline).toBe('В чёрном списке: долг по актам');
  });

  it('пешеход в чёрном списке по фамилии; истёкшая запись не действует', () => {
    const pass = pedestrianPass({ tenant: 'dns', name: 'Иванов Иван' });
    const entry = {
      id: 'bl-2',
      plateNorm: null,
      personName: 'иванов иван',
      reason: 'нарушение',
      validTo: null,
    };
    expect(check({ gate: 'kpp1', subject: pass, rules: { blacklist: [entry] } }).code).toBe('deny');
    expect(
      check({
        gate: 'kpp1',
        subject: pass,
        rules: { blacklist: [{ ...entry, validTo: at(`${DAY} 11:00`) }] },
      }).code,
    ).toBe('allow');
  });

  it('пешеход выезжает через КПП «только машины» — предупреждение, выпустить можно', () => {
    const pass = pedestrianPass({ tenant: 'dns' });
    const v = check({
      gate: 'kpp2',
      direction: 'out',
      subject: pass,
      openVisit: visit(pass, { gate: 'kpp1' }),
    });
    expect(v.code).toBe('allow');
    expect(v.reasons[0]?.code).toBe('gate_does_not_admit_out');
  });

  it('выезд по номеру: открытый визит находится по номеру, пропуск — по визиту', () => {
    const pass = semi({ plate: 'H524MC136' });
    const open = visit(pass);
    const v = check({
      gate: 'kpp2',
      direction: 'out',
      subject: { kind: 'plate', plateNorm: 'H524MC136', candidates: [pass], openVisits: [open] },
    });
    expect(v.code).toBe('allow');
    expect(v.passId).toBe(pass.id);
    expect(traceOf(v, 'open_visit')).toMatchObject({ details: { visitId: open.id } });
  });

  it('выезд по номеру без визита: пропуск есть — с отметкой; пропуска нет — с отметкой и похожими', () => {
    const pass = semi({ plate: 'H524MC136' });
    const known = check({
      gate: 'kpp2',
      direction: 'out',
      subject: { kind: 'plate', plateNorm: 'H524MC136', candidates: [pass], openVisits: [] },
    });
    expect(known.code).toBe('no_pass');
    expect(known.primaryAction).toBe('check_out_flagged');
    expect(known.passId).toBe(pass.id);
    const unknown = check({
      gate: 'kpp2',
      direction: 'out',
      subject: { kind: 'plate', plateNorm: 'H524MC130', candidates: [pass], openVisits: [] },
    });
    expect(unknown.code).toBe('no_pass');
    expect(unknown.primaryAction).toBe('check_out_flagged');
    expect(unknown.secondaryActions).toEqual(['check_out_flagged']);
    expect(unknown.infoLines).toEqual(['Похожие: H524MC136 (ДНС)']);
    expect(unknown.candidates[0]?.tenantName).toBe('ДНС');
  });

  it('одобренное исключение на выезд не нужно, если выезд и так разрешён', () => {
    const pass = semi();
    const v = check({
      gate: 'kpp2',
      direction: 'out',
      subject: pass,
      openVisit: visit(pass),
      overrides: [
        {
          id: 'ovr-out',
          passId: pass.id,
          plateNorm: null,
          gateId: gateId('kpp2'),
          direction: 'out',
          validUntil: null,
        },
      ],
    });
    expect(v.appliedOverrideId).toBeUndefined();
    expect(traceOf(v, 'override')).toMatchObject({ result: 'skipped' });
  });
});

describe('статусы, сроки, договор, рабочее время', () => {
  it.each([
    ['pending_approval', 'Пропуск на согласовании — въезд после одобрения'],
    ['draft', 'Пропуск не оформлен (черновик)'],
    ['rejected', 'Пропуск отклонён согласующим'],
    ['cancelled', 'Пропуск отменён'],
    ['expired', 'Пропуск закончился 10.03.2026 23:59'],
  ] as const)('статус %s — отказ «%s»', (status, headline) => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dns', category: 'car', status }),
    });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe(headline);
  });

  it('истёкший постоянный пропуск без даты окончания', () => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({
        tenant: 'dns',
        category: 'car',
        status: 'expired',
        type: 'permanent',
      }),
    });
    expect(v.headline).toBe('Пропуск закончился');
  });

  it('пропуск на машину без типа транспорта — отказ с подсказкой исправить', () => {
    const v = check({
      gate: 'kpp1',
      subject: { ...vehiclePass({ tenant: 'dns', category: 'car' }), categoryId: null },
    });
    expect(v.code).toBe('deny');
    expect(v.reasons[0]?.code).toBe('category_missing');
  });

  it('пропуск ещё не начался — ждать; уже закончился — отказ', () => {
    const early = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dns', category: 'car', from: `${DAY} 14:00` }),
    });
    expect(early.code).toBe('wait');
    expect(early.headline).toBe('Пропуск действует с 10.03.2026 14:00');
    const late = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dns', category: 'car', to: `${DAY} 11:00` }),
    });
    expect(late.code).toBe('deny');
    expect(late.headline).toBe('Пропуск закончился 10.03.2026 11:00');
    const open = check({
      gate: 'kpp1',
      subject: vehiclePass({
        tenant: 'dns',
        category: 'car',
        from: null,
        to: null,
        type: 'permanent',
      }),
    });
    expect(open.code).toBe('allow');
  });

  it('арендатор заблокирован на въезд или в архиве — отказ; блокировка новых пропусков не мешает', () => {
    const tenants = (status: 'blocked_entry' | 'archived' | 'blocked_new_passes') =>
      fx.rules.tenants.map((t) => (t.id === tenantId('dns') ? { ...t, status } : t));
    const pass = vehiclePass({ tenant: 'dns', category: 'car' });
    expect(
      check({ gate: 'kpp1', subject: pass, rules: { tenants: tenants('blocked_entry') } }).headline,
    ).toBe('Въезд арендатору ДНС запрещён администратором');
    expect(
      check({ gate: 'kpp1', subject: pass, rules: { tenants: tenants('archived') } }).headline,
    ).toBe('Арендатор ДНС в архиве');
    expect(
      check({ gate: 'kpp1', subject: pass, rules: { tenants: tenants('blocked_new_passes') } })
        .code,
    ).toBe('allow');
    const missing = check({ gate: 'kpp1', subject: pass, rules: { tenants: [] } });
    expect(missing.code).toBe('deny');
    expect(missing.reasons[0]?.code).toBe('tenant_missing');
    expect(traceOf(missing, 'quota')).toMatchObject({ result: 'skipped' });
  });

  it('договор: закончился вчера — отказ; заканчивается сегодня — ещё действует', () => {
    const withContract = (validTo: string) =>
      fx.rules.tenants.map((t) =>
        t.id === tenantId('dns') ? { ...t, contractValidTo: validTo } : t,
      );
    const pass = vehiclePass({ tenant: 'dns', category: 'car' });
    const expired = check({
      gate: 'kpp1',
      subject: pass,
      rules: { tenants: withContract('2026-03-09') },
    });
    expect(expired.code).toBe('deny');
    expect(expired.headline).toBe('Договор арендатора ДНС закончился 09.03.2026');
    expect(
      check({ gate: 'kpp1', subject: pass, rules: { tenants: withContract('2026-03-10') } }).code,
    ).toBe('allow');
  });

  it('разовый: возврат в течение X минут (Q-22) пропускает повторно', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car', type: 'single' });
    const past = [visit(pass, { timeIn: `${DAY} 09:00`, timeOut: `${DAY} 11:50`, gate: 'kpp1' })];
    const v = check({
      gate: 'kpp1',
      subject: pass,
      pastVisits: past,
      site: { settings: { ...fx.site.settings, singleReturnWindowMin: 15 } },
    });
    expect(v.code).toBe('allow');
    expect(traceOf(v, 'single_used')).toMatchObject({ details: { returnWithinMin: 15 } });
    const multi = check({
      gate: 'kpp1',
      subject: { ...pass, passType: 'multi' },
      pastVisits: past,
    });
    expect(traceOf(multi, 'single_used')).toMatchObject({
      skippedBy: { reason: 'not_applicable' },
    });
  });

  it('машина уже на территории — предупреждение, не блок', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car' });
    const v = check({
      gate: 'kpp1',
      subject: pass,
      openVisit: visit(pass, { gate: 'kpp1', timeIn: `${DAY} 09:00` }),
    });
    expect(v.code).toBe('allow');
    expect(v.reasons[0]?.message).toBe(
      'Уже на территории: въезд 10.03.2026 09:00 через КПП-1 не закрыт выездом',
    );
  });

  it('вне рабочего времени: предупреждение (по умолчанию), запрет или без проверки — по настройке объекта', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car' });
    const warned = check({ gate: 'kpp1', now: `${DAY} 21:00`, subject: pass });
    expect(warned.code).toBe('allow');
    expect(warned.reasons[0]?.message).toBe(
      'Вне рабочего времени объекта (08:00–20:00) — впустить можно',
    );
    const denied = check({
      gate: 'kpp1',
      now: `${DAY} 21:00`,
      subject: pass,
      site: { settings: { ...fx.site.settings, outsideWorkingHours: 'deny' } },
    });
    expect(denied.code).toBe('deny');
    expect(denied.headline).toBe('Вне рабочего времени объекта (08:00–20:00)');
    const allowed = check({
      gate: 'kpp1',
      now: `${DAY} 21:00`,
      subject: pass,
      site: { settings: { ...fx.site.settings, outsideWorkingHours: 'allow' } },
    });
    expect(allowed.reasons).toEqual([]);
    expect(traceOf(allowed, 'working_hours')).toMatchObject({ details: { outside: true } });
    const always = check({
      gate: 'kpp1',
      now: `${DAY} 21:00`,
      subject: pass,
      site: { workingHours: null },
    });
    expect(traceOf(always, 'working_hours')).toMatchObject({ details: { hours: 'always' } });
  });

  it('рабочее время КПП важнее рабочего времени объекта; выходной день', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car' });
    const gateHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    const v = check({ gate: 'kpp1', subject: pass, gateView: { workingHours: gateHours } });
    expect(v.reasons[0]?.message).toBe(
      'Вне рабочего времени объекта (сегодня выходной) — впустить можно',
    );
    const night = { ...gateHours, tue: [['22:00', '24:00']] as [string, string][] };
    expect(
      check({ gate: 'kpp1', now: `${DAY} 23:30`, subject: pass, gateView: { workingHours: night } })
        .reasons,
    ).toEqual([]);
  });
});

describe('окна прибытия: политики', () => {
  it('окно обязательно, а в пропуске его нет — отказ с подсказкой', () => {
    const v = check({ gate: 'kpp2', subject: semi({ window: null }) });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('В пропуске нет окна прибытия — укажите его в пропуске');
  });

  it('политики нет для типа (легковой) — проверка не применяется; окно необязательно — без окна проходит', () => {
    const car = check({ gate: 'kpp1', subject: vehiclePass({ tenant: 'dns', category: 'car' }) });
    expect(traceOf(car, 'time_window')).toMatchObject({ skippedBy: { reason: 'not_applicable' } });
    const optional = check({
      gate: 'kpp2',
      subject: semi({ window: null }),
      rules: { timeWindows: fx.rules.timeWindows.map((w) => ({ ...w, windowRequired: false })) },
    });
    expect(traceOf(optional, 'time_window')).toMatchObject({
      result: 'pass',
      details: { reason: 'no_window' },
    });
  });

  it('опоздание при мягкой политике — предупреждение; без допуска «позже» — до конца пропуска', () => {
    const soft = check({
      gate: 'kpp2',
      now: `${DAY} 16:30`,
      subject: semi({ window: [`${DAY} 14:00`, `${DAY} 15:00`] }),
      rules: {
        timeWindows: fx.rules.timeWindows.map((w) => ({ ...w, onViolation: 'warn' as const })),
      },
    });
    expect(soft.code).toBe('allow');
    expect(soft.reasons[0]?.code).toBe('window_too_late');
    const untilEnd = check({
      gate: 'kpp2',
      now: `${DAY} 16:30`,
      subject: semi({ window: [`${DAY} 14:00`, `${DAY} 15:00`], to: `${DAY} 18:00` }),
      rules: { timeWindows: fx.rules.timeWindows.map((w) => ({ ...w, lateToleranceMin: null })) },
    });
    expect(untilEnd.code).toBe('allow');
    const afterEnd = check({
      gate: 'kpp2',
      now: `${DAY} 18:30`,
      subject: semi({ window: [`${DAY} 14:00`, `${DAY} 15:00`], to: `${DAY} 18:00` }),
      rules: { timeWindows: fx.rules.timeWindows.map((w) => ({ ...w, lateToleranceMin: null })) },
    });
    expect(afterEnd.reasons[0]?.message).toBe('Пропуск закончился 10.03.2026 18:00');
    expect(afterEnd.reasons.map((r) => r.code)).toContain('window_too_late');
    expect(afterEnd.reasons.find((r) => r.code === 'window_too_late')?.message).toBe(
      'Опоздание: окно закрыто в 18:00 (до конца пропуска)',
    );
  });

  it('окно без конца — опоздания нет; допуск «раньше» сдвигает начало', () => {
    const openEnded = check({
      gate: 'kpp2',
      now: `${DAY} 18:00`,
      subject: semi({ window: [`${DAY} 14:00`, null], to: null, type: 'permanent' }),
    });
    expect(traceOf(openEnded, 'time_window')?.result).toBe('pass');
    const tolerant = check({
      gate: 'kpp2',
      now: `${DAY} 13:40`,
      subject: semi({ window: [`${DAY} 14:00`, `${DAY} 15:00`] }),
      rules: { timeWindows: fx.rules.timeWindows.map((w) => ({ ...w, earlyToleranceMin: 30 })) },
    });
    expect(traceOf(tolerant, 'time_window')?.result).toBe('pass');
  });

  it('самая специфичная политика: арендатор + тип > объект', () => {
    const tenantPolicy = {
      id: 'tw-dns-semi',
      tenantId: tenantId('dns'),
      categoryIds: [categoryId('semi')],
      windowRequired: true,
      earlyToleranceMin: 120,
      lateToleranceMin: 0,
      onViolation: 'hard' as const,
    };
    const v = check({
      gate: 'kpp2',
      now: `${DAY} 13:00`,
      subject: semi({ window: [`${DAY} 14:00`, `${DAY} 15:00`] }),
      rules: { timeWindows: [...fx.rules.timeWindows, tenantPolicy] },
    });
    expect(traceOf(v, 'time_window')).toMatchObject({
      result: 'pass',
      details: { policyId: 'tw-dns-semi' },
    });
  });

  it('док: грузовому без дока — предупреждение; не грузовому или без настройки — не применяется', () => {
    const noDock = check({ gate: 'kpp2', subject: semi({ dock: null }) });
    expect(noDock.code).toBe('allow');
    expect(noDock.reasons[0]?.code).toBe('dock_missing');
    expect(noDock.infoLines).toContain('Док не указан');
    const car = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dns', category: 'car', dock: '1' }),
    });
    expect(traceOf(car, 'dock_required')).toMatchObject({
      skippedBy: { reason: 'not_applicable' },
    });
    expect(car.infoLines).toContain('Док №1');
    const unknownDock = check({
      gate: 'kpp1',
      subject: { ...vehiclePass({ tenant: 'dns', category: 'car' }), dockId: 'nope' },
    });
    expect(unknownDock.infoLines).toContain('Док №?');
  });
});

describe('разрешение кандидатов по номеру и фамилии', () => {
  const now = at(`${DAY} 12:00`);

  it('один точный — он; несколько у одного арендатора — ближайшее окно', () => {
    const a = semi({ plate: 'H524MC136', window: [`${DAY} 09:00`, `${DAY} 10:00`], id: 'a' });
    const b = semi({ plate: 'H524MC136', window: [`${DAY} 12:30`, `${DAY} 13:30`], id: 'b' });
    const c = semi({ plate: 'H524MC136', window: null, id: 'c' });
    expect(resolveCandidates({ plateNorm: 'H524MC136', candidates: [a] }, now)).toEqual({
      kind: 'one',
      pass: a,
    });
    expect(resolveCandidates({ plateNorm: 'H524MC136', candidates: [a, c, b] }, now)).toEqual({
      kind: 'one',
      pass: b,
    });
  });

  it('разные арендаторы — «к кому едет?» с кандидатами', () => {
    const a = semi({ plate: 'H524MC136', id: 'a' });
    const b = vehiclePass({
      tenant: 'x5',
      category: 'semi',
      plate: 'H524MC136',
      id: 'b',
      window: [`${DAY} 11:00`, `${DAY} 13:00`],
    });
    const resolved = resolveCandidates({ plateNorm: 'H524MC136', candidates: [a, b] }, now);
    expect(resolved.kind).toBe('choose');
    const v = check({
      gate: 'kpp2',
      subject: { kind: 'plate', plateNorm: 'H524MC136', candidates: [a, b], openVisits: [] },
    });
    expect(v.code).toBe('no_pass');
    expect(v.primaryAction).toBe('request_pass');
    expect(v.secondaryActions).toEqual(['choose_tenant']);
    expect(v.candidates.map((c) => c.tenantName).sort()).toEqual(['Агроторг (X5)', 'ДНС']);
    expect(v.headline).toBe('Номер H524MC136 у нескольких арендаторов — к кому едет?');
  });

  it('точное совпадение, но пропуск не действует — показывается настоящая причина', () => {
    const used = semi({
      plate: 'H524MC136',
      status: 'used',
      from: '2026-03-01 00:00',
      to: '2026-03-01 23:59',
    });
    const old = semi({
      plate: 'H524MC136',
      from: '2026-02-01 00:00',
      to: '2026-02-01 23:59',
      id: 'old',
    });
    const v = check({
      gate: 'kpp2',
      subject: { kind: 'plate', plateNorm: 'H524MC136', candidates: [old, used], openVisits: [] },
    });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('Разовый пропуск использован — нужен новый пропуск');
    expect(v.passId).toBe(used.id);
  });

  it('похожие номера — «пропуска нет» с подсказкой, автопроезд запрещён', () => {
    const a = semi({ plate: 'H524MC136' });
    const v = check({
      gate: 'kpp2',
      subject: { kind: 'plate', plateNorm: 'H524MC13', candidates: [a], openVisits: [] },
    });
    expect(v.code).toBe('no_pass');
    expect(v.infoLines).toEqual(['Похожие: H524MC136 (ДНС)']);
    expect(v.candidates).toHaveLength(1);
    expect(resolveCandidates({ plateNorm: 'A000AA00', candidates: [a] }, now)).toEqual({
      kind: 'none',
      similar: [],
    });
  });

  it('въезд по номеру при открытом визите: пропуск берётся из визита, въезд предупреждает', () => {
    const a = semi({ plate: 'H524MC136' });
    const v = check({
      gate: 'kpp2',
      subject: { kind: 'plate', plateNorm: 'H524MC136', candidates: [a], openVisits: [visit(a)] },
    });
    expect(v.code).toBe('allow');
    expect(v.reasons[0]?.code).toBe('already_inside');
  });

  it('пешеход по фамилии: один, несколько, никого, пустой запрос', () => {
    const ivanov = pedestrianPass({ tenant: 'dns', name: 'Иванов Пётр', id: 'p1' });
    const ivanova = pedestrianPass({ tenant: 'kontinent', name: 'Иванова Анна', id: 'p2' });
    const petrov = pedestrianPass({ tenant: 'dns', name: 'Петров Олег', id: 'p3' });
    const all = [ivanov, ivanova, petrov];
    expect(resolvePedestrian({ nameQuery: 'ов', candidates: all }, now).kind).toBe('choose');
    expect(resolvePedestrian({ nameQuery: 'ПЕТРОВ', candidates: all }, now)).toEqual({
      kind: 'one',
      pass: petrov,
    });
    expect(resolvePedestrian({ nameQuery: '  ', candidates: all }, now)).toEqual({
      kind: 'none',
      similar: [],
    });
    const one = check({
      gate: 'kpp1',
      subject: { kind: 'pedestrian_lookup', nameQuery: 'петров', candidates: all },
    });
    expect(one.code).toBe('allow');
    expect(one.passId).toBe('p3');
    const many = check({
      gate: 'kpp1',
      subject: { kind: 'pedestrian_lookup', nameQuery: 'иванов', candidates: all },
    });
    expect(many.code).toBe('no_pass');
    expect(many.secondaryActions).toEqual(['choose_tenant']);
    expect(many.infoLines).toEqual(['Найдены: Иванов Пётр (ДНС), Иванова Анна (Континент)']);
    const none = check({
      gate: 'kpp1',
      subject: { kind: 'pedestrian_lookup', nameQuery: 'сидоров', candidates: all },
    });
    expect(none.headline).toBe('Пешеход не найден: «сидоров»');
    const inside = check({
      gate: 'kpp1',
      subject: {
        kind: 'pedestrian_lookup',
        nameQuery: 'петров',
        candidates: all,
        openVisits: [visit(petrov, { gate: 'kpp1' })],
      },
    });
    expect(inside.reasons[0]?.code).toBe('already_inside');
  });

  it('одобренное исключение по номеру и истёкшее исключение', () => {
    const pass = semi({ plate: 'H524MC136' });
    const base = { gate: 'kpp2', subject: pass, occupancy: { 'dns/trucks': 25 } } as const;
    const byPlate = check({
      ...base,
      overrides: [
        {
          id: 'o1',
          passId: null,
          plateNorm: 'H524MC136',
          gateId: gateId('kpp2'),
          direction: 'in',
          validUntil: null,
        },
      ],
    });
    expect(byPlate.appliedOverrideId).toBe('o1');
    const expired = check({
      ...base,
      overrides: [
        {
          id: 'o2',
          passId: pass.id,
          plateNorm: null,
          gateId: gateId('kpp2'),
          direction: 'in',
          validUntil: at(`${DAY} 11:00`),
        },
      ],
    });
    expect(expired.code).toBe('wait');
    const otherGate = check({
      ...base,
      overrides: [
        {
          id: 'o3',
          passId: pass.id,
          plateNorm: null,
          gateId: gateId('kpp1'),
          direction: 'in',
          validUntil: null,
        },
      ],
    });
    expect(otherGate.code).toBe('wait');
  });

  it('пешеходный лимит считается по пешеходам', () => {
    const pedestrianQuota: QuotaView = {
      id: 'q-ped',
      tenantId: tenantId('dns'),
      participant: 'pedestrian',
      categoryIds: [],
      name: 'Посетители',
      capacity: 1,
      capacityFromDocks: false,
      counting: 'on_site',
      enforcement: 'hard',
      overageTariffRub: null,
      overageCap: null,
      schedule: null,
      validFrom: at('2026-01-01 00:00'),
      validTo: null,
      basis: null,
    };
    const v = check({
      gate: 'kpp1',
      subject: pedestrianPass({ tenant: 'dns' }),
      rules: { quotas: [...fx.rules.quotas, pedestrianQuota] },
    });
    expect(v.quotaStates.map((q) => q.name)).toEqual(['Посетители']);
    expect(zoneId('office')).toBeTruthy();
  });
});
