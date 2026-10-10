import { describe, expect, it } from 'vitest';
import { evaluate, overageDays } from '../src';
import {
  at,
  buildInput,
  check,
  DAY,
  exceptionId,
  fx,
  gateId,
  pedestrianPass,
  quotaId,
  traceOf,
  vehiclePass,
  visit,
} from './helpers';

/**
 * Сценарии приёмки (docs/spec/14_…, 16_ раздел C, RULES_ENGINE §10) на фикстуре демо-объекта.
 * Названия арендаторов и КПП взяты из сида — это тесты на демо-данных, не код приложения.
 */
describe('лимиты', () => {
  it('сценарий 1: 24/25 грузовых, фура ДНС с окном «сейчас» на КПП-2 — зелёный «Грузовые 24/25»', () => {
    const v = check({
      gate: 'kpp2',
      subject: vehiclePass({
        tenant: 'dns',
        category: 'semi',
        window: [`${DAY} 11:30`, `${DAY} 12:30`],
        dock: '12',
      }),
      occupancy: { 'dns/trucks': 24 },
    });
    expect(v.code).toBe('allow');
    expect(v.color).toBe('green');
    expect(v.primaryAction).toBe('check_in');
    expect(v.headline).toBe('Грузовые 24/25 — впускайте');
    expect(v.quotaStates).toEqual([
      expect.objectContaining({
        quotaId: quotaId('dns/trucks'),
        occupied: 24,
        capacity: 25,
        wouldBe: 25,
      }),
    ]);
    expect(v.infoLines).toContain('Док №12');
    expect(traceOf(v, 'quota')?.result).toBe('pass');
  });

  it('сценарий 2: 25/25, ещё фура ДНС — жёлтый «ДНС грузовые 25/25 — ждите», кнопка «Впустить» недоступна', () => {
    const v = check({
      gate: 'kpp2',
      subject: vehiclePass({
        tenant: 'dns',
        category: 'semi',
        window: [`${DAY} 11:30`, `${DAY} 12:30`],
        dock: '12',
      }),
      occupancy: { 'dns/trucks': 25 },
    });
    expect(v.code).toBe('wait');
    expect(v.color).toBe('yellow');
    expect(v.headline).toBe('ДНС грузовые 25/25 — ждите');
    expect(v.primaryAction).toBe('wait');
    expect(v.secondaryActions).toContain('override_request');
    expect(v.reasons[0]).toMatchObject({
      code: 'quota_full',
      settingLink: 'Настройки → Лимиты → ДНС → Грузовые',
    });
  });

  it('сценарий 4: малотоннажный ДНС на КПП-1 при 25/25 — жёлтый: считается в «Грузовые», хотя едет через КПП-1', () => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({
        tenant: 'dns',
        category: 'light_truck',
        window: [`${DAY} 11:00`, `${DAY} 13:00`],
        dock: '1',
      }),
      occupancy: { 'dns/trucks': 25 },
    });
    expect(v.code).toBe('wait');
    expect(traceOf(v, 'routing')?.result).toBe('pass');
    expect(traceOf(v, 'quota')).toMatchObject({ result: 'fail', severity: 'wait' });
    expect(v.quotaStates[0]?.quotaId).toBe(quotaId('dns/trucks'));
  });

  it('сценарий 8: ДЛ-Транс, внутри 15 легковых, приезжает 16-я — оранжевый, 67 ₽/сутки, визит сверх лимита', () => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dl_trans', category: 'car' }),
      occupancy: { 'dl_trans/cars': 15 },
    });
    expect(v.code).toBe('allow_overage');
    expect(v.color).toBe('orange');
    expect(v.primaryAction).toBe('check_in');
    expect(v.overage).toEqual({ quotaId: quotaId('dl_trans/cars'), tariffRub: 67 });
    expect(v.headline).toBe('Сверх лимита: ДЛ-Транс легковые 15/15, 67 ₽/сутки');
  });

  it('сценарий 9: сверхлимитная машина стоит с 22:00 до 09:00 следующего дня — 2 суток', () => {
    expect(overageDays(at(`${DAY} 22:00`), at('2026-03-11 09:00'), fx.site.timezone)).toBe(2);
    expect(overageDays(at(`${DAY} 09:00`), at(`${DAY} 18:00`), fx.site.timezone)).toBe(1);
  });

  it('сценарий 10: фура Континента — красный «не предусмотрено договором (лимит 0)»', () => {
    const v = check({
      gate: 'kpp2',
      subject: vehiclePass({
        tenant: 'kontinent',
        category: 'semi',
        window: [`${DAY} 11:00`, `${DAY} 13:00`],
      }),
    });
    expect(v.code).toBe('deny');
    expect(v.color).toBe('red');
    expect(v.primaryAction).toBe('refuse');
    expect(v.headline).toBe(
      'Континент: фура и грузовой свыше 5 т — не предусмотрено договором (лимит 0)',
    );
    expect(v.reasons[0]?.basis).toBeTruthy();
  });

  it('сценарий 30: Мастервент, малотоннажный — красный «Грузовые не предусмотрены договором»', () => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({
        tenant: 'mastervent',
        category: 'light_truck',
        window: [`${DAY} 11:00`, `${DAY} 13:00`],
      }),
    });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('Мастервент: грузовые — не предусмотрено договором (лимит 0)');
  });

  it('сценарий 33: 2 спецтехники ДНС внутри, грузовые 10/25; третья спецтехника на КПП-2 — «ДНС спецтехника 2/2 — ждите»', () => {
    const v = check({
      gate: 'kpp2',
      subject: vehiclePass({ tenant: 'dns', category: 'special' }),
      occupancy: { 'dns/special': 2, 'dns/trucks': 10 },
    });
    expect(v.code).toBe('wait');
    expect(v.headline).toBe('ДНС спецтехника 2/2 — ждите');
    expect(v.quotaStates.map((q) => q.quotaId)).toEqual([quotaId('dns/special')]);
  });
});

describe('маршруты и «кого пропускает»', () => {
  it('сценарий 5: малотоннажный ДНС на КПП-2 — синий «Малотоннажный — через КПП-1»', () => {
    const v = check({
      gate: 'kpp2',
      subject: vehiclePass({
        tenant: 'dns',
        category: 'light_truck',
        window: [`${DAY} 11:00`, `${DAY} 13:00`],
        dock: '1',
      }),
    });
    expect(v.code).toBe('wrong_gate');
    expect(v.color).toBe('blue');
    expect(v.primaryAction).toBe('redirect');
    expect(v.headline).toBe('Малотоннажный — через КПП-1');
    expect(v.suggestedGateIds).toEqual([gateId('kpp1')]);
  });

  it('сценарий 11: пешеход ДНС на КПП-2 — синий «Пешеходы — через КПП-1»', () => {
    const v = check({ gate: 'kpp2', subject: pedestrianPass({ tenant: 'dns' }) });
    expect(v.code).toBe('wrong_gate');
    expect(v.headline).toBe('Пешеходы — через КПП-1');
    expect(v.suggestedGateIds).toEqual([gateId('kpp1')]);
    expect(traceOf(v, 'gate_admits')).toMatchObject({ result: 'fail', severity: 'wrong_gate' });
  });

  it('сценарий 12: пешеход ДНС на КПП-1 — зелёный, пешеход виден и пропускается', () => {
    const v = check({ gate: 'kpp1', subject: pedestrianPass({ tenant: 'dns' }) });
    expect(v.code).toBe('allow');
    expect(v.primaryAction).toBe('check_in');
    expect(traceOf(v, 'gate_admits')?.result).toBe('pass');
    expect(traceOf(v, 'routing')?.result).toBe('pass');
    expect(traceOf(v, 'quota')?.result).toBe('pass');
  });
});

describe('окна прибытия', () => {
  it('сценарий 6: фура с окном 14:00, на часах 13:40 — жёлтый «Рано: въезд с 14:00, ещё 20 мин»', () => {
    const v = check({
      gate: 'kpp2',
      now: `${DAY} 13:40`,
      subject: vehiclePass({
        tenant: 'dns',
        category: 'semi',
        window: [`${DAY} 14:00`, `${DAY} 15:00`],
        dock: '12',
      }),
    });
    expect(v.code).toBe('wait');
    expect(v.headline).toBe('Рано: въезд с 14:00, ещё 20 мин');
    expect(v.primaryAction).toBe('wait');
  });

  it('сценарий 7: окно 14:00–15:00, на часах 16:30 — красный «Опоздание: окно закрыто в 16:00 (15:00 + 60 мин)» → «Запросить новое окно»', () => {
    const v = check({
      gate: 'kpp2',
      now: `${DAY} 16:30`,
      subject: vehiclePass({
        tenant: 'dns',
        category: 'semi',
        window: [`${DAY} 14:00`, `${DAY} 15:00`],
        dock: '12',
      }),
    });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('Опоздание: окно закрыто в 16:00 (15:00 + 60 мин)');
    expect(v.secondaryActions).toContain('request_window');
  });
});

describe('исключения', () => {
  it('сценарий 13: служебный автобус ДНС при 30/30 легковых — зелёный «Исключение: служебный автобус», вне лимита', () => {
    const v = check({
      gate: 'kpp1',
      subject: vehiclePass({ tenant: 'dns', category: 'car', plate: 'A001AA174' }),
      occupancy: { 'dns/cars': 30 },
    });
    expect(v.code).toBe('allow');
    expect(v.infoLines).toContain('Исключение: Служебный автобус ДНС — без досмотра, вне лимита');
    expect(v.appliedExceptionIds).toEqual([exceptionId('dns_bus')]);
    expect(traceOf(v, 'quota')).toMatchObject({
      result: 'skipped',
      skippedBy: { exceptionId: exceptionId('dns_bus') },
    });
    expect(v.quotaStates).toEqual([
      expect.objectContaining({ quotaId: quotaId('dns/cars'), occupied: 30, wouldBe: 30 }),
    ]);
  });

  it('сценарий 14: фура X5 в 03:00 — зелёный, исключение 24/7 снимает рабочее время и окно', () => {
    const v = check({
      gate: 'kpp2',
      now: `${DAY} 03:00`,
      subject: vehiclePass({ tenant: 'x5', category: 'semi', dock: 'З1' }),
    });
    expect(v.code).toBe('allow');
    expect(traceOf(v, 'working_hours')).toMatchObject({
      result: 'skipped',
      skippedBy: { exceptionId: exceptionId('x5_24_7') },
    });
    expect(traceOf(v, 'time_window')).toMatchObject({ result: 'skipped' });
    expect(v.appliedExceptionIds).toEqual([exceptionId('x5_24_7')]);
  });
});

describe('пропуска нет, разовый, выезд', () => {
  it('сценарий 15 (движок): машина без пропуска на КПП-2 — «Запросить»; после оформления — зелёный', () => {
    const before = check({
      gate: 'kpp2',
      subject: { kind: 'plate', plateNorm: 'H524MC136', candidates: [], openVisits: [] },
    });
    expect(before.code).toBe('no_pass');
    expect(before.color).toBe('yellow');
    expect(before.primaryAction).toBe('request_pass');
    expect(before.headline).toBe('Пропуска нет: H524MC136');
    expect(before.trace).toEqual([
      expect.objectContaining({ check: 'pass_found', result: 'fail' }),
    ]);

    const pass = vehiclePass({
      tenant: 'dns',
      category: 'semi',
      plate: 'H524MC136',
      window: [`${DAY} 11:00`, `${DAY} 13:00`],
      dock: '12',
    });
    const after = check({
      gate: 'kpp2',
      subject: { kind: 'plate', plateNorm: 'H524MC136', candidates: [pass], openVisits: [] },
    });
    expect(after.code).toBe('allow');
    expect(after.passId).toBe(pass.id);
  });

  it('сценарий 16 (движок): выезд машины, въезд которой не отмечен — «Выпустить с отметкой», флаг no_checkin', () => {
    const v = check({
      gate: 'kpp1',
      direction: 'out',
      subject: vehiclePass({ tenant: 'dns', category: 'car' }),
      openVisit: null,
    });
    expect(v.code).toBe('no_pass');
    expect(v.primaryAction).toBe('check_out_flagged');
    expect(v.flags).toEqual(['no_checkin']);
    expect(v.headline).toBe('Въезд не отмечен — выпустите с отметкой, укажите причину');
    expect(traceOf(v, 'quota')).toMatchObject({
      result: 'skipped',
      skippedBy: { reason: 'direction_out' },
    });
  });

  it('сценарий 25: разовый пропуск — въехал, выехал, вернулся через час — красный «Разовый пропуск использован» → «Оформить новый»', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car', type: 'single' });
    const v = check({
      gate: 'kpp1',
      now: `${DAY} 12:00`,
      subject: pass,
      pastVisits: [visit(pass, { timeIn: `${DAY} 09:00`, timeOut: `${DAY} 11:00`, gate: 'kpp1' })],
    });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('Разовый пропуск использован — нужен новый пропуск');
    expect(v.secondaryActions).toContain('request_pass');

    const used = check({ gate: 'kpp1', subject: { ...pass, status: 'used' } });
    expect(used.code).toBe('deny');
    expect(used.reasons[0]?.code).toBe('single_pass_used');
  });

  it('сценарий 26: пропуск истёк, пока машина внутри — выезд разрешён, визит «после окончания»', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car', to: `${DAY} 10:00` });
    const v = check({
      gate: 'kpp1',
      direction: 'out',
      now: `${DAY} 12:00`,
      subject: pass,
      openVisit: visit(pass, { timeIn: `${DAY} 09:00`, gate: 'kpp1' }),
    });
    expect(v.code).toBe('allow');
    expect(v.primaryAction).toBe('check_out');
    expect(v.flags).toEqual(['after_expiry']);
    expect(v.infoLines[0]).toMatch(/^Пропуск закончился 10\.03\.2026 10:00/);
  });
});

describe('пешеходы и внутренний пост', () => {
  it('сценарий 34: пешеход Континента на КПП офис — зелёный, строка «позвоните …», визит не открывается', () => {
    const v = check({
      gate: 'office',
      subject: pedestrianPass({ tenant: 'kontinent', destinationZone: 'office' }),
    });
    expect(v.code).toBe('allow');
    expect(v.primaryAction).toBe('passage');
    expect(v.headline).toBe('Проход разрешён');
    expect(v.infoLines).toEqual([
      'Позвоните в Континент и дождитесь сотрудника — без него дальше не пускать · позвоните +70000000021',
    ]);
    expect(traceOf(v, 'quota')).toMatchObject({
      result: 'skipped',
      skippedBy: { reason: 'internal_gate' },
    });
    expect(traceOf(v, 'time_window')).toMatchObject({
      result: 'skipped',
      skippedBy: { reason: 'internal_gate' },
    });
    expect(traceOf(v, 'routing')?.result).toBe('pass');
  });

  it('сценарий 35: пешеход ДНС без документа на КПП-1 — «без документа — … выйдет ответственный ДНС» с телефоном', () => {
    const v = check({ gate: 'kpp1', subject: pedestrianPass({ tenant: 'dns' }) });
    expect(v.code).toBe('allow');
    expect(v.infoLines).toEqual([
      'Проверьте документ (паспорт, ВУ, Госуслуги) · без документа — позвоните, выйдет ответственный ДНС · позвоните +70000000012',
    ]);
  });
});

describe('исключение с поста', () => {
  it('сценарий 42: фура ДНС при 25/25, запрос исключения одобрен — зелёный, appliedOverrideId', () => {
    const pass = vehiclePass({
      tenant: 'dns',
      category: 'semi',
      window: [`${DAY} 11:00`, `${DAY} 13:00`],
      dock: '12',
    });
    const base = {
      gate: 'kpp2',
      subject: pass,
      occupancy: { 'dns/trucks': 25 },
    } as const;
    expect(check(base).code).toBe('wait');
    const v = check({
      ...base,
      overrides: [
        {
          id: 'ovr-1',
          passId: pass.id,
          plateNorm: null,
          gateId: gateId('kpp2'),
          direction: 'in',
          validUntil: at(`${DAY} 12:15`),
        },
      ],
    });
    expect(v.code).toBe('allow');
    expect(v.color).toBe('green');
    expect(v.primaryAction).toBe('check_in');
    expect(v.appliedOverrideId).toBe('ovr-1');
    expect(v.headline).toBe('Исключение одобрено администратором — впускайте');
    expect(v.trace.at(-1)).toMatchObject({ check: 'override', result: 'pass' });
    expect(v.secondaryActions).not.toContain('override_request');
  });
});

describe('время в поясе объекта', () => {
  it('сценарий 22: тексты причин — в поясе объекта, а не браузера или сервера', () => {
    const pass = vehiclePass({
      tenant: 'dns',
      category: 'semi',
      window: [`${DAY} 14:00`, `${DAY} 15:00`],
      dock: '12',
    });
    const now = at(`${DAY} 13:40`);
    const here = check({ gate: 'kpp2', now, subject: pass });
    expect(here.headline).toBe('Рано: въезд с 14:00, ещё 20 мин');
    // Тот же момент и то же окно, но объект в Чикаго: текст показывает 04:00 (летнее время, UTC−5).
    const elsewhere = check({
      gate: 'kpp2',
      now,
      subject: pass,
      site: { timezone: 'America/Chicago' },
    });
    expect(elsewhere.headline).toBe('Рано: въезд с 04:00, ещё 20 мин');
  });

  it.each(['Asia/Yekaterinburg', 'Europe/Kaliningrad', 'Asia/Kamchatka'])(
    'сценарии 6, 7 и 9 в поясе %s',
    (tz) => {
      const pass = vehiclePass({
        tenant: 'dns',
        category: 'semi',
        window: [`${DAY} 14:00`, `${DAY} 15:00`],
        dock: '12',
        tz,
      });
      const early = check({
        gate: 'kpp2',
        now: at(`${DAY} 13:40`, tz),
        subject: pass,
        site: { timezone: tz },
      });
      expect(early.headline).toBe('Рано: въезд с 14:00, ещё 20 мин');
      const late = check({
        gate: 'kpp2',
        now: at(`${DAY} 16:30`, tz),
        subject: pass,
        site: { timezone: tz },
      });
      expect(late.headline).toBe('Опоздание: окно закрыто в 16:00 (15:00 + 60 мин)');
      expect(overageDays(at(`${DAY} 22:00`, tz), at('2026-03-11 09:00', tz), tz)).toBe(2);
    },
  );
});

describe('детерминизм', () => {
  it('одинаковый вход — одинаковый вердикт', () => {
    const input = buildInput({
      gate: 'kpp2',
      subject: vehiclePass({
        tenant: 'dns',
        category: 'semi',
        window: [`${DAY} 11:00`, `${DAY} 13:00`],
      }),
      occupancy: { 'dns/trucks': 25 },
    });
    expect(evaluate(input)).toEqual(evaluate(JSON.parse(JSON.stringify(input))));
    expect(evaluate(input).engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
