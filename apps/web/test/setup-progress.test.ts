import { describe, expect, it } from 'vitest';
import type { CategoryView, GateView, SiteView, TenantView } from '../src/lib/data';
import { computeSetupProgress, type SetupData, STEPS } from '../src/lib/steps';

const site = {
  id: 's1',
  name: 'Объект',
  address: 'г. Пример, ул. Тестовая, 1',
  timezone: 'Asia/Yekaterinburg',
  timezoneLabel: 'Екатеринбург, UTC+5',
  workingHours: null,
} as SiteView;
const gate = (id: string, over: Partial<GateView> = {}): GateView =>
  ({
    id,
    name: id,
    kind: 'perimeter',
    admits: 'vehicles_and_pedestrians',
    sort: 1,
    ...over,
  }) as GateView;
const type = (id: string, enabled = true): CategoryView =>
  ({
    id,
    name: id,
    enabled,
    sort: 1,
    dockEligible: false,
    presetCode: null,
    siteId: 's1',
  }) as CategoryView;
const tenant = (id: string, over: Partial<TenantView> = {}): TenantView =>
  ({ id, shortName: id, isOperator: false, ...over }) as TenantView;
const all = () => true;
const base = (over: Partial<SetupData> = {}): SetupData => ({ site, can: all, ...over });

describe('готовность шагов мастера считается по данным', () => {
  it('на чистой базе: объекта нет, остальные шаги ждут первого', () => {
    const p = computeSetupProgress({ site: null, can: all });
    expect(p.site?.state).toBe('empty');
    for (const s of STEPS.slice(1)) expect(p[s.slug]?.state).toBe('blocked');
  });

  it('объект без адреса — частично, с причиной', () => {
    const p = computeSetupProgress(base({ site: { ...site, address: null } }));
    expect(p.site).toMatchObject({ state: 'partial' });
    expect(p.site?.missing[0]).toContain('адрес');
  });

  it('КПП: нет — пусто; только внутренние — частично; есть периметр — готово', () => {
    expect(computeSetupProgress(base({ gates: [] })).gates?.state).toBe('empty');
    expect(
      computeSetupProgress(base({ gates: [gate('a', { kind: 'internal' })] })).gates?.state,
    ).toBe('partial');
    expect(computeSetupProgress(base({ gates: [gate('a')] })).gates?.state).toBe('done');
  });

  it('типы: выключенные не считаются', () => {
    expect(computeSetupProgress(base({ categories: [type('t', false)] })).types?.state).toBe(
      'empty',
    );
    expect(computeSetupProgress(base({ categories: [type('t')] })).types?.state).toBe('done');
  });

  it('маршруты: без КПП и типов — ждут; один КПП для машин — не нужны; несколько — по покрытию типов', () => {
    expect(computeSetupProgress(base({ gates: [], categories: [] })).routes?.state).toBe('blocked');
    const one = computeSetupProgress(
      base({ gates: [gate('a')], categories: [type('t')], routing: [] }),
    );
    expect(one.routes?.state).toBe('done');
    const gates = [gate('a'), gate('b')];
    const none = computeSetupProgress(
      base({ gates, categories: [type('t1'), type('t2')], routing: [] }),
    );
    expect(none.routes?.state).toBe('empty');
    const some = computeSetupProgress(
      base({
        gates,
        categories: [type('t1'), type('t2')],
        routing: [
          { tenantId: null, participant: 'vehicle', categoryId: 't1', gateId: 'a' } as never,
        ],
      }),
    );
    expect(some.routes).toMatchObject({ state: 'partial' });
    expect(some.routes?.missing[0]).toContain('t2');
  });

  it('лимиты: у арендаторов без лимитов — частично; оператор не в счёт', () => {
    const tenants = [tenant('x'), tenant('y'), tenant('op', { isOperator: true })];
    const p = computeSetupProgress(base({ tenants, quotas: [{ tenantId: 'x' } as never] }));
    expect(p.limits).toMatchObject({ state: 'partial', summary: 'без лимитов: 1 из 2' });
    const full = computeSetupProgress(
      base({ tenants, quotas: [{ tenantId: 'x' } as never, { tenantId: 'y' } as never] }),
    );
    expect(full.limits?.state).toBe('done');
  });

  it('нет права читать раздел — состояние «нет данных», а не «пусто»', () => {
    const p = computeSetupProgress(base({ can: () => false, tenants: [tenant('x')] }));
    expect(p.limits?.state).toBe('unknown');
    expect(p.routes?.state).toBe('unknown');
    expect(p.devices?.state).toBe('unknown');
  });

  it('политики: незаданные сочетания — частично, со списком', () => {
    const p = computeSetupProgress(
      base({ gaps: [{ creatorKind: 'gate', passType: 'multi', message: 'не задана' }] }),
    );
    expect(p.policies).toMatchObject({ state: 'partial', missing: ['не задана'] });
    expect(computeSetupProgress(base({ gaps: [] })).policies?.state).toBe('done');
  });

  it('устройства: привязаны не ко всем КПП — частично; отозванные не считаются', () => {
    const gates = [gate('a'), gate('b')];
    const p = computeSetupProgress(
      base({
        gates,
        accounts: [{ devices: [{ revokedAt: null }] }, { devices: [{ revokedAt: '2026-01-01' }] }],
      }),
    );
    expect(p.devices).toMatchObject({ state: 'partial', summary: 'привязано на 1 из 2 КПП' });
  });

  it('проверка: готово, когда выполнены все обязательные шаги', () => {
    const p = computeSetupProgress(
      base({
        gates: [gate('a')],
        categories: [type('t')],
        routing: [],
        docks: [],
        tenants: [tenant('x')],
        quotas: [{ tenantId: 'x' } as never],
        gaps: [],
        users: [{}, {}],
        accounts: [{ devices: [{ revokedAt: null }] }],
      }),
    );
    expect(p.check?.state).toBe('done');
  });
});
