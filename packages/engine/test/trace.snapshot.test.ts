import { describe, expect, it } from 'vitest';
import { check, DAY, gateId, pedestrianPass, vehiclePass, visit } from './helpers';

/**
 * Снимки trace (RULES_ENGINE §2: движок детерминирован). Id в снимках — UUIDv5 сида, они
 * стабильны. Изменение порядка или состава проверок меняет снимок осознанно: `vitest -u`.
 */
const semi = (id: string, extra: Partial<Parameters<typeof vehiclePass>[0]> = {}) =>
  vehiclePass({
    id,
    tenant: 'dns',
    category: 'semi',
    window: [`${DAY} 11:00`, `${DAY} 13:00`],
    dock: '12',
    ...extra,
  });

describe('снимки trace', () => {
  it('сценарий 1: фура ДНС, 24/25', () => {
    expect(
      check({ gate: 'kpp2', subject: semi('s1'), occupancy: { 'dns/trucks': 24 } }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 2: фура ДНС, 25/25', () => {
    expect(
      check({ gate: 'kpp2', subject: semi('s2'), occupancy: { 'dns/trucks': 25 } }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 5: малотоннажный ДНС на КПП-2', () => {
    expect(
      check({
        gate: 'kpp2',
        subject: vehiclePass({
          id: 's5',
          tenant: 'dns',
          category: 'light_truck',
          window: [`${DAY} 11:00`, `${DAY} 13:00`],
          dock: '1',
        }),
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 7: опоздание', () => {
    expect(
      check({
        gate: 'kpp2',
        now: `${DAY} 16:30`,
        subject: semi('s7', { window: [`${DAY} 14:00`, `${DAY} 15:00`] }),
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 8: ДЛ-Транс сверх лимита', () => {
    expect(
      check({
        gate: 'kpp1',
        subject: vehiclePass({ id: 's8', tenant: 'dl_trans', category: 'car' }),
        occupancy: { 'dl_trans/cars': 15 },
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 10: фура Континента, лимит 0', () => {
    expect(
      check({
        gate: 'kpp2',
        subject: vehiclePass({
          id: 's10',
          tenant: 'kontinent',
          category: 'semi',
          window: [`${DAY} 11:00`, `${DAY} 13:00`],
        }),
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 13: автобус ДНС по исключению', () => {
    expect(
      check({
        gate: 'kpp1',
        subject: vehiclePass({ id: 's13', tenant: 'dns', category: 'car', plate: 'A001AA174' }),
        occupancy: { 'dns/cars': 30 },
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 14: X5 в 03:00', () => {
    expect(
      check({
        gate: 'kpp2',
        now: `${DAY} 03:00`,
        subject: vehiclePass({ id: 's14', tenant: 'x5', category: 'semi', dock: 'З1' }),
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 16: выезд без отметки въезда', () => {
    expect(
      check({
        gate: 'kpp1',
        direction: 'out',
        subject: vehiclePass({ id: 's16', tenant: 'dns', category: 'car' }),
        openVisit: null,
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 26: выезд после окончания пропуска', () => {
    const pass = vehiclePass({ id: 's26', tenant: 'dns', category: 'car', to: `${DAY} 10:00` });
    expect(
      check({
        gate: 'kpp1',
        direction: 'out',
        subject: pass,
        openVisit: visit(pass, { id: 'v26', gate: 'kpp1' }),
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 34: пешеход Континента на внутреннем посту', () => {
    expect(
      check({
        gate: 'office',
        subject: pedestrianPass({ id: 's34', tenant: 'kontinent', destinationZone: 'office' }),
      }).trace,
    ).toMatchSnapshot();
  });

  it('сценарий 42: одобренное исключение при 25/25', () => {
    const pass = semi('s42');
    expect(
      check({
        gate: 'kpp2',
        subject: pass,
        occupancy: { 'dns/trucks': 25 },
        overrides: [
          {
            id: 'ovr-42',
            passId: 's42',
            plateNorm: null,
            gateId: gateId('kpp2'),
            direction: 'in',
            validUntil: null,
          },
        ],
      }).trace,
    ).toMatchSnapshot();
  });
});
