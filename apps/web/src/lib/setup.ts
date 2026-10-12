import type { Me } from '@oxrana/contracts';
import {
  useApi,
  useApprovalGaps,
  useCategories,
  useDocks,
  useGates,
  useQuotas,
  useRoutingRules,
  useTenants,
} from './data';
import { useSite } from './site-context';

/**
 * Шаги мастера настройки объекта (09_, ADR-020). Шаг — это карточка справочника; готовность
 * считается **по данным** и нигде не хранится: можно уйти и вернуться, шаг можно пропустить.
 */
export interface StepDef {
  readonly n: number;
  readonly slug: string;
  readonly title: string;
  readonly short: string;
  /** Право, без которого шаг недоступен пользователю. */
  readonly permission: string | readonly string[];
  /** Обязателен для работы поста (без него охранник не получит вердикт). */
  readonly required: boolean;
  /** Куда ведёт карточка вне мастера. */
  readonly href: (siteId: string | null) => string;
}

export const STEPS: readonly StepDef[] = [
  {
    n: 1,
    slug: 'site',
    title: 'Объект',
    short: 'название, адрес, пояс, часы',
    permission: 'site.manage',
    required: true,
    href: (id) => (id ? `/admin/sites/${id}` : '/admin/setup/site'),
  },
  {
    n: 2,
    slug: 'gates',
    title: 'КПП',
    short: 'кого пропускает и когда',
    permission: 'site.manage',
    required: true,
    href: () => '/admin/gates',
  },
  {
    n: 3,
    slug: 'types',
    title: 'Типы транспорта',
    short: 'пресеты и свои типы',
    permission: 'site.manage',
    required: true,
    href: () => '/admin/categories',
  },
  {
    n: 4,
    slug: 'routes',
    title: 'Маршруты',
    short: 'тип × КПП и пешеходы',
    permission: 'rule.manage',
    required: true,
    href: () => '/admin/routing',
  },
  {
    n: 5,
    slug: 'docks',
    title: 'Доки и зоны',
    short: 'номера диапазоном',
    permission: 'site.manage',
    required: false,
    href: () => '/admin/docks',
  },
  {
    n: 6,
    slug: 'tenants',
    title: 'Арендаторы',
    short: 'по одному и из Excel',
    permission: 'tenant.manage',
    required: true,
    href: () => '/admin/tenants',
  },
  {
    n: 7,
    slug: 'limits',
    title: 'Назначения и лимиты',
    short: 'доки и лимиты арендаторов',
    permission: ['tenant.manage', 'quota.manage'],
    required: true,
    href: () => '/admin/tenants',
  },
  {
    n: 8,
    slug: 'policies',
    title: 'Политики',
    short: 'окна, сроки, согласование, исключения',
    permission: 'rule.manage',
    required: true,
    href: () => '/admin/policies',
  },
  {
    n: 9,
    slug: 'people',
    title: 'Люди',
    short: 'сотрудники и роли',
    permission: ['user.manage', 'tenant_user.manage'],
    required: false,
    href: () => '/admin/users',
  },
  {
    n: 10,
    slug: 'devices',
    title: 'Устройства КПП',
    short: 'привязка постов',
    permission: 'device.manage',
    required: false,
    href: () => '/admin/devices',
  },
  {
    n: 11,
    slug: 'check',
    title: 'Проверка',
    short: 'что настроено, чего не хватает',
    permission: 'site.manage',
    required: false,
    href: () => '/admin/setup/check',
  },
];

export function stepBySlug(slug: string): StepDef | undefined {
  return STEPS.find((s) => s.slug === slug);
}

export function canOpenStep(step: StepDef, can: (p: string) => boolean): boolean {
  const needed = typeof step.permission === 'string' ? [step.permission] : step.permission;
  return needed.some((p) => can(p));
}

export type StepState = 'done' | 'partial' | 'empty' | 'blocked' | 'unknown';

export interface StepStatus {
  readonly state: StepState;
  /** Одна строка: что есть. */
  readonly summary: string;
  /** Чего не хватает (пусто, если всё есть). */
  readonly missing: string[];
}

export type SetupProgress = Record<string, StepStatus>;

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
export const count = (n: number, one: string, few: string, many: string) =>
  `${n} ${plural(n, one, few, many)}`;

interface AccountsView {
  items: { devices: { revokedAt: string | null }[] }[];
}
interface UsersView {
  items: unknown[];
}

/** Состояние всех шагов по данным объекта; пока данные грузятся, `loading`. */
export function useSetupProgress(me: Me | null | undefined): {
  loading: boolean;
  progress: SetupProgress;
} {
  const { site } = useSite();
  const siteId = site?.id ?? null;
  const can = (p: string) => me?.permissions.includes(p) ?? false;
  const gates = useGates(siteId);
  const categories = useCategories(siteId, true);
  const routing = useRoutingRules(can('rule.manage') ? siteId : null);
  const docks = useDocks(siteId);
  const tenants = useTenants(siteId);
  const quotas = useQuotas(can('quota.manage') ? siteId : null);
  const gaps = useApprovalGaps(can('rule.manage') ? siteId : null);
  const accounts = useApi<AccountsView>(
    siteId && can('device.manage') ? `/sites/${siteId}/gate-accounts` : null,
  );
  const users = useApi<UsersView>(
    can('user.manage') || can('tenant_user.manage') ? '/users' : null,
  );

  const loading = [gates, categories, docks, tenants].some((q) => q.isLoading);
  const progress: SetupProgress = {};
  const set = (slug: string, status: StepStatus) => {
    progress[slug] = status;
  };

  if (!site) {
    set('site', { state: 'empty', summary: 'Объект не создан', missing: ['создайте объект'] });
    for (const s of STEPS.slice(1)) {
      set(s.slug, { state: 'blocked', summary: 'Сначала создайте объект', missing: ['шаг 1'] });
    }
    return { loading, progress };
  }

  set(
    'site',
    site.address
      ? { state: 'done', summary: `${site.name} · ${site.timezoneLabel}`, missing: [] }
      : {
          state: 'partial',
          summary: `${site.name} · ${site.timezoneLabel}`,
          missing: ['адрес объекта — по нему проверяется часовой пояс'],
        },
  );

  const g = gates.items ?? [];
  const perimeter = g.filter((x) => x.kind === 'perimeter');
  set(
    'gates',
    g.length === 0
      ? { state: 'empty', summary: 'КПП не добавлены', missing: ['добавьте хотя бы один КПП'] }
      : perimeter.length === 0
        ? {
            state: 'partial',
            summary: count(g.length, 'КПП', 'КПП', 'КПП'),
            missing: ['нет КПП на периметре: въезд на территорию некому отмечать'],
          }
        : {
            state: 'done',
            summary: `${count(g.length, 'КПП', 'КПП', 'КПП')}, на периметре — ${perimeter.length}`,
            missing: [],
          },
  );

  const enabled = (categories.items ?? []).filter((c) => c.enabled);
  set(
    'types',
    enabled.length === 0
      ? {
          state: 'empty',
          summary: 'Типы не включены',
          missing: ['включите типы транспорта из готового набора'],
        }
      : { state: 'done', summary: enabled.map((c) => c.name).join(', '), missing: [] },
  );

  if (!can('rule.manage')) {
    set('routes', { state: 'unknown', summary: 'Нет доступа к маршрутам', missing: [] });
  } else if (g.length === 0 || enabled.length === 0) {
    set('routes', {
      state: 'blocked',
      summary: 'Сначала КПП и типы транспорта',
      missing: ['шаги 2 и 3'],
    });
  } else {
    const siteWide = (routing.items ?? []).filter(
      (r) => r.tenantId === null && r.participant === 'vehicle',
    );
    const covered = new Set(siteWide.map((r) => r.categoryId));
    const uncovered = enabled.filter((c) => !covered.has(c.id));
    set(
      'routes',
      uncovered.length === 0
        ? {
            state: 'done',
            summary: `маршруты заданы для ${count(enabled.length, 'типа', 'типов', 'типов')}`,
            missing: [],
          }
        : uncovered.length === enabled.length
          ? {
              state: 'empty',
              summary: 'Маршруты не заданы',
              missing: [
                `ни для одного типа не выбран КПП: ${uncovered.map((c) => c.name).join(', ')}`,
              ],
            }
          : {
              state: 'partial',
              summary: `заданы для ${enabled.length - uncovered.length} из ${enabled.length} типов`,
              missing: [`нет КПП для: ${uncovered.map((c) => c.name).join(', ')}`],
            },
    );
  }

  const d = docks.items ?? [];
  set(
    'docks',
    d.length === 0
      ? {
          state: 'empty',
          summary: 'Доков нет',
          missing: [
            'если на объекте есть доки — добавьте номера диапазоном; иначе шаг можно пропустить',
          ],
        }
      : { state: 'done', summary: count(d.length, 'док', 'дока', 'доков'), missing: [] },
  );

  const t = tenants.items ?? [];
  set(
    'tenants',
    t.length === 0
      ? {
          state: 'empty',
          summary: 'Арендаторов нет',
          missing: ['добавьте арендаторов по одному или вставкой из Excel'],
        }
      : {
          state: 'done',
          summary: count(t.length, 'арендатор', 'арендатора', 'арендаторов'),
          missing: [],
        },
  );

  if (t.length === 0) {
    set('limits', { state: 'blocked', summary: 'Сначала арендаторы', missing: ['шаг 6'] });
  } else if (!can('quota.manage')) {
    set('limits', { state: 'unknown', summary: 'Нет доступа к лимитам', missing: [] });
  } else {
    const limited = new Set((quotas.items ?? []).map((q) => q.tenantId));
    const without = t.filter((x) => !x.isOperator && !limited.has(x.id));
    set(
      'limits',
      without.length === 0
        ? { state: 'done', summary: `лимиты есть у всех арендаторов`, missing: [] }
        : {
            state: without.length === t.filter((x) => !x.isOperator).length ? 'empty' : 'partial',
            summary: `без лимитов: ${without.length} из ${t.filter((x) => !x.isOperator).length}`,
            missing: [
              `нет лимита — значит без ограничения: ${without
                .slice(0, 5)
                .map((x) => x.shortName)
                .join(', ')}${without.length > 5 ? '…' : ''}`,
            ],
          },
    );
  }

  if (!can('rule.manage')) {
    set('policies', { state: 'unknown', summary: 'Нет доступа к политикам', missing: [] });
  } else if (gaps.items === undefined) {
    set('policies', { state: 'unknown', summary: 'Загрузка…', missing: [] });
  } else {
    set(
      'policies',
      gaps.items.length === 0
        ? { state: 'done', summary: 'согласование задано для всех сочетаний', missing: [] }
        : {
            state: 'partial',
            summary: `не задано сочетаний: ${gaps.items.length}`,
            missing: gaps.items.map((x) => x.message),
          },
    );
  }

  if (users.data === undefined) {
    set('people', {
      state: 'unknown',
      summary: can('user.manage') || can('tenant_user.manage') ? 'Загрузка…' : 'Нет доступа',
      missing: [],
    });
  } else {
    const n = users.data.items.length;
    set(
      'people',
      n > 1
        ? {
            state: 'done',
            summary: count(n, 'пользователь', 'пользователя', 'пользователей'),
            missing: [],
          }
        : {
            state: 'empty',
            summary: 'Кроме вас никого нет',
            missing: ['пригласите администратора объекта и сотрудников арендаторов'],
          },
    );
  }

  if (!can('device.manage')) {
    set('devices', { state: 'unknown', summary: 'Нет доступа к устройствам', missing: [] });
  } else if (g.length === 0) {
    set('devices', { state: 'blocked', summary: 'Сначала КПП', missing: ['шаг 2'] });
  } else {
    const items = accounts.data?.items ?? [];
    const withDevice = items.filter((a) => a.devices.some((x) => x.revokedAt === null)).length;
    set(
      'devices',
      withDevice === g.length && g.length > 0
        ? { state: 'done', summary: 'на каждом КПП есть устройство', missing: [] }
        : withDevice === 0
          ? {
              state: 'empty',
              summary: 'Устройства не привязаны',
              missing: ['привяжите устройство поста к каждому КПП'],
            }
          : {
              state: 'partial',
              summary: `привязано на ${withDevice} из ${g.length} КПП`,
              missing: ['привяжите устройство к остальным КПП'],
            },
    );
  }

  const required = STEPS.filter((s) => s.required && s.slug !== 'check');
  const ready = required.filter((s) => progress[s.slug]?.state === 'done').length;
  set('check', {
    state: ready === required.length ? 'done' : ready === 0 ? 'empty' : 'partial',
    summary: `готово ${ready} из ${required.length} обязательных шагов`,
    missing: required
      .filter((s) => progress[s.slug]?.state !== 'done')
      .map((s) => `шаг ${s.n}. ${s.title}`),
  });
  return { loading, progress };
}
