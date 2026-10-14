import { describe, expect, it } from 'vitest';
import { type BlacklistEntryView, findBlacklisted } from '../src';
import { at, check, DAY, pedestrianPass, vehiclePass, visit } from './helpers';

const NOW = at(`${DAY} 12:00`);
const entry = (extra: Partial<BlacklistEntryView> = {}): BlacklistEntryView => ({
  id: 'bl-1',
  plateNorm: 'X666XX66',
  personName: null,
  reason: 'долг по актам',
  validTo: null,
  ...extra,
});

describe('findBlacklisted — чистая проверка номера и имени (этап 7a)', () => {
  it('находит по нормализованному номеру', () => {
    expect(findBlacklisted([entry()], { plateNorm: 'X666XX66' }, NOW)?.id).toBe('bl-1');
    expect(findBlacklisted([entry()], { plateNorm: 'X666XX67' }, NOW)).toBeNull();
  });

  it('находит человека по имени без учёта регистра и пробелов по краям', () => {
    const e = entry({ plateNorm: null, personName: 'Иванов Иван' });
    expect(findBlacklisted([e], { personName: '  иванов иван ' }, NOW)?.id).toBe('bl-1');
    expect(findBlacklisted([e], { personName: 'Иванов Пётр' }, NOW)).toBeNull();
  });

  it('пустой номер и пустое имя ничего не находят, даже если в записи тоже пусто', () => {
    const e = entry({ plateNorm: null, personName: null });
    expect(findBlacklisted([e], {}, NOW)).toBeNull();
    expect(findBlacklisted([e], { plateNorm: '', personName: '  ' }, NOW)).toBeNull();
  });

  it('срок записи — время параметром: до конца действует, после — нет', () => {
    const e = entry({ validTo: at(`${DAY} 12:00`) });
    expect(findBlacklisted([e], { plateNorm: 'X666XX66' }, at(`${DAY} 11:59`))).not.toBeNull();
    expect(findBlacklisted([e], { plateNorm: 'X666XX66' }, at(`${DAY} 12:00`))).toBeNull();
  });
});

describe('чёрный список без пропуска (этап 7a)', () => {
  const rules = { blacklist: [entry()] };
  const plateSubject = (plateNorm: string) =>
    ({ kind: 'plate', plateNorm, candidates: [], openVisits: [] }) as const;

  it('номер из списка без пропуска на въезде — красный с причиной, без «запросить пропуск»', () => {
    const v = check({ gate: 'kpp1', subject: plateSubject('X666XX66'), rules });
    expect(v.code).toBe('deny');
    expect(v.color).toBe('red');
    expect(v.headline).toBe('В чёрном списке: долг по актам');
    expect(v.reasons[0]?.code).toBe('blacklisted');
    expect(v.primaryAction).toBe('refuse');
    expect(v.secondaryActions).not.toContain('request_pass');
    expect(v.secondaryActions).not.toContain('override_request');
    expect(v.passId).toBeNull();
    expect(v.trace.map((t) => `${t.check}:${t.result}`)).toEqual([
      'pass_found:fail',
      'blacklist:fail',
    ]);
  });

  it('тот же номер вне списка — обычное «Пропуска нет»', () => {
    const v = check({ gate: 'kpp1', subject: plateSubject('X777XX66'), rules });
    expect(v.code).toBe('no_pass');
  });

  it('истёкшая запись не действует', () => {
    const old = { blacklist: [entry({ validTo: at(`${DAY} 11:00`) })] };
    expect(check({ gate: 'kpp1', subject: plateSubject('X666XX66'), rules: old }).code).toBe(
      'no_pass',
    );
  });

  it('на выезде без пропуска — выпустить с отметкой и предупреждение, не красный', () => {
    const v = check({
      gate: 'kpp1',
      direction: 'out',
      subject: plateSubject('X666XX66'),
      rules,
    });
    expect(v.code).toBe('no_pass');
    expect(v.primaryAction).toBe('check_out_flagged');
    expect(v.infoLines.join(' ')).toContain('В чёрном списке: долг по актам — выпустить');
  });

  it('номер у нескольких арендаторов и в списке — красный, а не «к кому едет»', () => {
    const a = vehiclePass({ tenant: 'dns', category: 'car', plate: 'X666XX66' });
    const b = vehiclePass({ tenant: 'dns', category: 'car', plate: 'X666XX66' });
    const v = check({
      gate: 'kpp1',
      subject: { kind: 'plate', plateNorm: 'X666XX66', candidates: [a, b], openVisits: [] },
      rules,
    });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('В чёрном списке: долг по актам');
  });

  it('есть единственный пропуск — цепочка обычная, чёрный список внутри неё', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car', plate: 'X666XX66' });
    const v = check({
      gate: 'kpp1',
      subject: { kind: 'plate', plateNorm: 'X666XX66', candidates: [pass], openVisits: [] },
      rules,
    });
    expect(v.code).toBe('deny');
    expect(v.passId).toBe(pass.id);
    expect(v.trace.some((t) => t.check === 'tenant_status')).toBe(true);
  });

  it('машина внутри (визит есть, пропуска в кандидатах нет) на выезде выпускается как раньше', () => {
    const pass = vehiclePass({ tenant: 'dns', category: 'car', plate: 'X666XX66' });
    const v = check({
      gate: 'kpp1',
      direction: 'out',
      subject: {
        kind: 'plate',
        plateNorm: 'X666XX66',
        candidates: [pass],
        openVisits: [visit(pass, { gate: 'kpp1' })],
      },
      rules,
    });
    expect(v.code).toBe('allow');
  });

  it('пешеход из списка по имени без пропуска — красный; на выезде — предупреждение', () => {
    const ped = { blacklist: [entry({ plateNorm: null, personName: 'Иванов Иван' })] };
    const subject = {
      kind: 'pedestrian_lookup',
      nameQuery: 'иванов иван',
      candidates: [],
    } as const;
    const v = check({ gate: 'kpp1', subject, rules: ped });
    expect(v.code).toBe('deny');
    expect(v.headline).toBe('В чёрном списке: долг по актам');
    const out = check({ gate: 'kpp1', direction: 'out', subject, rules: ped });
    expect(out.code).toBe('no_pass');
    expect(out.infoLines.join(' ')).toContain('выпустить');
    const other = check({
      gate: 'kpp1',
      subject: { kind: 'pedestrian_lookup', nameQuery: 'Петров Пётр', candidates: [] },
      rules: ped,
    });
    expect(other.code).toBe('no_pass');
  });

  it('пешеход с пропуском и в списке — по-прежнему красный через цепочку', () => {
    const p = pedestrianPass({ tenant: 'dns', name: 'Иванов Иван' });
    const ped = { blacklist: [entry({ plateNorm: null, personName: 'Иванов Иван' })] };
    expect(check({ gate: 'kpp1', subject: p, rules: ped }).code).toBe('deny');
  });
});
