import {
  type ApprovedOverride,
  type EvaluationInput,
  evaluate,
  type GateView,
  localParts,
  type PassageDirection,
  type PassStatus,
  type PassType,
  type PassView,
  type RuleSet,
  type SiteView,
  type Subject,
  type Verdict,
  type VisitView,
} from '../src';
import frozen from './fixtures/radonezhsky.ruleset.json';

/**
 * Фикстура демо-объекта (замораживается `pnpm fixture:engine`). Ссылки — по ключам сида:
 * арендатор `dns`, КПП `kpp2`, лимит `dns/trucks`, тип `semi`.
 */
export interface Fixture {
  readonly site: SiteView;
  readonly rules: RuleSet;
  readonly keys: {
    readonly organizationId: string;
    readonly siteId: string;
    readonly tenants: Record<string, string>;
    readonly gates: Record<string, string>;
    readonly zones: Record<string, string>;
    readonly categories: Record<string, string>;
    readonly quotas: Record<string, string>;
    readonly exceptions: Record<string, string>;
    readonly timeWindowPolicies: Record<string, string>;
    readonly docks: Record<string, string>;
  };
}

export const fx: Fixture = frozen as unknown as Fixture;

export const key = (map: Record<string, string>, name: string): string => {
  const id = map[name];
  if (!id) throw new Error(`В фикстуре нет ключа «${name}»`);
  return id;
};
export const tenantId = (k: string) => key(fx.keys.tenants, k);
export const gateId = (k: string) => key(fx.keys.gates, k);
export const zoneId = (k: string) => key(fx.keys.zones, k);
export const categoryId = (k: string) => key(fx.keys.categories, k);
export const quotaId = (k: string) => key(fx.keys.quotas, k);
export const exceptionId = (k: string) => key(fx.keys.exceptions, k);
export const dockId = (number: string) => key(fx.keys.docks, number);

export const gate = (k: string): GateView => {
  const found = fx.rules.gates.find((g) => g.id === gateId(k));
  if (!found) throw new Error(`В фикстуре нет КПП «${k}»`);
  return found;
};

export const TZ = fx.site.timezone;

/** Смещение пояса в миллисекундах на данный момент. */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/** Момент по местному времени пояса: `at('2026-03-10 13:40')`. */
export function at(local: string, timeZone: string = TZ): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error(`Ожидалось «YYYY-MM-DD HH:MM», получено «${local}»`);
  const [, y, m, d, h, mi] = match.map(Number);
  const guess = Date.UTC(y ?? 0, (m ?? 1) - 1, d, h, mi);
  let result = guess - offsetAt(guess, timeZone);
  const again = offsetAt(result, timeZone);
  if (again !== offsetAt(guess, timeZone)) result = guess - again;
  return result;
}

/** Обычный рабочий день демо-объекта: вторник 10.03.2026, лимиты и исключения уже действуют. */
export const DAY = '2026-03-10';
export const NOON = at(`${DAY} 12:00`);

let counter = 0;
export const nextId = (prefix = 'pass'): string =>
  `${prefix}-${String(++counter).padStart(4, '0')}`;

export interface VehiclePassOptions {
  readonly tenant: string;
  readonly category: string;
  readonly plate?: string;
  readonly type?: PassType;
  readonly status?: PassStatus;
  /** Местное время «YYYY-MM-DD HH:MM» или момент. */
  readonly from?: string | number | null;
  readonly to?: string | number | null;
  readonly window?: readonly [string | number, string | number | null] | null;
  readonly dock?: string | null;
  readonly destinationZone?: string | null;
  readonly id?: string;
  readonly tz?: string;
}

const instant = (value: string | number | null | undefined, tz: string): number | null =>
  value === undefined || value === null ? null : typeof value === 'number' ? value : at(value, tz);

export function vehiclePass(o: VehiclePassOptions): PassView {
  const tz = o.tz ?? TZ;
  const type = o.type ?? 'single';
  return {
    id: o.id ?? nextId(),
    tenantId: tenantId(o.tenant),
    passType: type,
    participant: 'vehicle',
    status: o.status ?? 'approved',
    plateNorm: o.plate ?? 'A123BC174',
    categoryId: categoryId(o.category),
    personName: null,
    destinationZoneId:
      o.destinationZone === undefined || o.destinationZone === null
        ? null
        : zoneId(o.destinationZone),
    dockId: o.dock === undefined || o.dock === null ? null : dockId(o.dock),
    validFrom: o.from === undefined ? at(`${DAY} 00:00`, tz) : instant(o.from, tz),
    validTo:
      o.to === undefined
        ? type === 'permanent'
          ? null
          : at(`${DAY} 23:59`, tz)
        : instant(o.to, tz),
    windowFrom: o.window ? instant(o.window[0], tz) : null,
    windowTo: o.window ? instant(o.window[1], tz) : null,
  };
}

export interface PedestrianPassOptions {
  readonly tenant: string;
  readonly name?: string;
  readonly type?: PassType;
  readonly status?: PassStatus;
  readonly destinationZone?: string | null;
  readonly from?: string | number | null;
  readonly to?: string | number | null;
  readonly id?: string;
}

export function pedestrianPass(o: PedestrianPassOptions): PassView {
  const type = o.type ?? 'permanent';
  return {
    id: o.id ?? nextId('ped'),
    tenantId: tenantId(o.tenant),
    passType: type,
    participant: 'pedestrian',
    status: o.status ?? 'approved',
    plateNorm: null,
    categoryId: null,
    personName: o.name ?? 'Тестов Тест',
    destinationZoneId:
      o.destinationZone === undefined || o.destinationZone === null
        ? null
        : zoneId(o.destinationZone),
    dockId: null,
    validFrom: o.from === undefined ? at('2026-01-01 00:00') : instant(o.from, TZ),
    validTo:
      o.to === undefined ? (type === 'permanent' ? null : at(`${DAY} 23:59`)) : instant(o.to, TZ),
    windowFrom: null,
    windowTo: null,
  };
}

export function visit(
  pass: PassView,
  o: {
    readonly timeIn?: string | number;
    readonly timeOut?: string | number | null;
    readonly gate?: string;
    readonly waivesQuota?: boolean;
    readonly id?: string;
  } = {},
): VisitView {
  return {
    id: o.id ?? nextId('visit'),
    passId: pass.id,
    tenantId: pass.tenantId,
    participant: pass.participant,
    categoryId: pass.categoryId,
    plateNorm: pass.plateNorm,
    gateInId: gateId(o.gate ?? 'kpp2'),
    timeIn: instant(o.timeIn ?? `${DAY} 09:00`, TZ),
    timeOut: o.timeOut === undefined ? null : instant(o.timeOut, TZ),
    exceptionWaivesQuota: o.waivesQuota ?? false,
  };
}

export interface CheckOptions {
  readonly gate: string;
  readonly direction?: PassageDirection;
  readonly now?: string | number;
  readonly subject: Subject | PassView;
  readonly openVisit?: VisitView | null;
  readonly pastVisits?: readonly VisitView[];
  /** Занятость по ключам лимитов: `{ 'dns/trucks': 24 }`. */
  readonly occupancy?: Record<string, number>;
  readonly overrides?: readonly ApprovedOverride[];
  readonly site?: Partial<SiteView>;
  readonly rules?: Partial<RuleSet>;
  readonly gateView?: Partial<GateView>;
}

export function buildInput(o: CheckOptions): EvaluationInput {
  const site: SiteView = { ...fx.site, ...o.site };
  const now =
    o.now === undefined ? NOON : typeof o.now === 'number' ? o.now : at(o.now, site.timezone);
  const subject: Subject =
    'kind' in o.subject
      ? o.subject
      : {
          kind: 'pass',
          pass: o.subject,
          ...(o.openVisit !== undefined ? { openVisit: o.openVisit } : {}),
          ...(o.pastVisits !== undefined ? { pastVisits: o.pastVisits } : {}),
        };
  return {
    now,
    site,
    gate: { ...gate(o.gate), ...o.gateView },
    direction: o.direction ?? 'in',
    subject,
    rules: { ...fx.rules, ...o.rules },
    state: {
      occupancy: Object.entries(o.occupancy ?? {}).map(([k, occupied]) => ({
        quotaId: quotaId(k),
        occupied,
      })),
      queue: [],
      asOf: now,
    },
    overrides: o.overrides ?? [],
  };
}

export function check(o: CheckOptions): Verdict {
  return evaluate(buildInput(o));
}

export const traceOf = (v: Verdict, checkKind: string) =>
  v.trace.find((t) => t.check === checkKind);
