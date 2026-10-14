import {
  type ApprovalCreatorKind,
  type ApprovalMode,
  type Participant,
  type PassDraft,
  type PassPatch,
  type PassType,
  type SiteSettings,
  SiteSettingsSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import {
  applicableQuotas,
  capacityOf,
  collectWaivers,
  type PassView as EnginePass,
  findBlacklisted,
  formatDateTime,
  localDate,
  overageDays,
  type RuleSet,
  type TimeWindowPolicyView,
} from '@oxrana/engine';
import { normalizePlate, type PlateCountry } from '@oxrana/plates';
import { and, eq } from 'drizzle-orm';
import { isTenantUser } from '../../actor';
import type { Scope } from '../../core/context';
import type { SiteRow, TenantRow } from '../../core/loaders';
import { loadSite } from '../../core/loaders';
import { assertRef } from '../../core/refs';
import { AppError } from '../../errors';
import { siteTimeLabel } from '../org/sites';
import { dockRanges } from './views';

/**
 * Проверки пропуска (10_ §3–5, 16_ A5, A10, сценарии 22, 23, 36, 38): одни и те же для создания,
 * пакета, правки, заявки на изменение и пропуска по запросу с поста. Ошибка называет причину,
 * поле формы и, где можно, — что выбрать («Ваши доки: 1–18, 66–72»).
 */

/** Колонки пропуска, которые задаёт форма. */
export interface PassValues {
  passType: PassType;
  participant: Participant;
  plateRaw: string | null;
  plateNorm: string | null;
  plateCountry: string | null;
  categoryId: string | null;
  brand: string | null;
  personName: string | null;
  personDocument: string | null;
  driverName: string | null;
  driverPhone: string | null;
  purposeId: string | null;
  destinationZoneId: string | null;
  dockId: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  windowFrom: Date | null;
  windowTo: Date | null;
  comment: string | null;
}

export type PassField = keyof PassValues;

const date = (value: string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

function plateValues(
  plate: string | undefined,
  hint: string | undefined,
): Pick<PassValues, 'plateRaw' | 'plateNorm' | 'plateCountry'> | null {
  if (plate === undefined) return null;
  const trimmed = plate.trim();
  if (trimmed === '') return { plateRaw: null, plateNorm: null, plateCountry: null };
  const normalized = normalizePlate(trimmed, hint as PlateCountry | undefined);
  return {
    plateRaw: trimmed,
    plateNorm: normalized.norm === '' ? null : normalized.norm,
    plateCountry: normalized.country,
  };
}

/** Значения нового пропуска из формы: незаполненное — `null`. */
export function valuesFromDraft(draft: PassDraft): PassValues {
  const plate = plateValues(draft.plate, draft.plateCountry) ?? {
    plateRaw: null,
    plateNorm: null,
    plateCountry: null,
  };
  return {
    passType: draft.passType,
    participant: draft.participant,
    ...plate,
    categoryId: draft.categoryId ?? null,
    brand: draft.brand ?? null,
    personName: draft.personName ?? null,
    personDocument: draft.personDocument ?? null,
    driverName: draft.driverName ?? null,
    driverPhone: draft.driverPhone ?? null,
    purposeId: draft.purposeId ?? null,
    destinationZoneId: draft.destinationZoneId ?? null,
    dockId: draft.dockId ?? null,
    validFrom: date(draft.validFrom),
    validTo: date(draft.validTo),
    windowFrom: date(draft.windowFrom),
    windowTo: date(draft.windowTo),
    comment: draft.comment ?? null,
  };
}

/** Только присланные поля правки, в виде колонок (номер нормализуется). */
export function valuesFromPatch(patch: PassPatch): Partial<PassValues> {
  const out: Partial<PassValues> = {};
  const plate = plateValues(patch.plate, patch.plateCountry);
  if (plate) Object.assign(out, plate);
  const simple = [
    'categoryId',
    'brand',
    'personName',
    'personDocument',
    'driverName',
    'driverPhone',
    'purposeId',
    'destinationZoneId',
    'dockId',
    'comment',
  ] as const;
  for (const key of simple) {
    const value = patch[key];
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['validFrom', 'validTo', 'windowFrom', 'windowTo'] as const) {
    const value = patch[key];
    if (value !== undefined) out[key] = date(value);
  }
  return out;
}

export function valuesOf(row: typeof schema.passes.$inferSelect): PassValues {
  return {
    passType: row.passType,
    participant: row.participant,
    plateRaw: row.plateRaw,
    plateNorm: row.plateNorm,
    plateCountry: row.plateCountry,
    categoryId: row.categoryId,
    brand: row.brand,
    personName: row.personName,
    personDocument: row.personDocument,
    driverName: row.driverName,
    driverPhone: row.driverPhone,
    purposeId: row.purposeId,
    destinationZoneId: row.destinationZoneId,
    dockId: row.dockId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    windowFrom: row.windowFrom,
    windowTo: row.windowTo,
    comment: row.comment,
  };
}

export interface PassContext {
  readonly site: SiteRow;
  readonly settings: SiteSettings;
  readonly tenant: TenantRow;
  readonly rules: RuleSet;
  readonly now: number;
  /** «Ваши доки» пользователю арендатора, «доки арендатора» — администратору. */
  readonly tenantUser: boolean;
}

export async function loadPassContext(s: Scope, tenant: TenantRow): Promise<PassContext> {
  const site = await loadSite(s, tenant.siteId);
  const { rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, site.id);
  return {
    site,
    settings: SiteSettingsSchema.parse(site.settings),
    tenant,
    rules,
    now: s.ctx.now(),
    tenantUser: isTenantUser(s.ctx.actor),
  };
}

function fail(code: ConstructorParameters<typeof AppError>[0], field: string, message?: string) {
  return new AppError(code, { field, ...(message ? { message } : {}) });
}

/** Самая специфичная политика окна: арендатор + типы > арендатор > типы > объект (RULES_ENGINE §3). */
export function windowPolicyFor(
  rules: RuleSet,
  tenantId: string,
  categoryId: string | null,
): TimeWindowPolicyView | null {
  const candidates = rules.timeWindows.filter(
    (p) =>
      (p.tenantId === null || p.tenantId === tenantId) &&
      (p.categoryIds.length === 0 || (categoryId !== null && p.categoryIds.includes(categoryId))),
  );
  const score = (p: TimeWindowPolicyView) =>
    (p.tenantId !== null ? 2 : 0) + (p.categoryIds.length > 0 ? 1 : 0);
  return [...candidates].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0] ?? null;
}

/** Доки, закреплённые за арендатором сейчас. */
export function tenantDocks(rules: RuleSet, tenantId: string) {
  return rules.docks.filter((d) => d.tenantId === tenantId);
}

function asEnginePass(values: PassValues, tenantId: string): EnginePass {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    tenantId,
    passType: values.passType,
    participant: values.participant,
    status: 'approved',
    plateNorm: values.plateNorm,
    categoryId: values.categoryId,
    personName: values.personName,
    destinationZoneId: values.destinationZoneId,
    dockId: values.dockId,
    validFrom: values.validFrom?.getTime() ?? null,
    validTo: values.validTo?.getTime() ?? null,
    windowFrom: values.windowFrom?.getTime() ?? null,
    windowTo: values.windowTo?.getTime() ?? null,
  };
}

/** Что мешает оформить новый пропуск арендатору: блокировка или конец договора; `null` — ничего. */
export function tenantPassProblem(
  ctx: PassContext,
): { code: 'tenant_blocked' | 'contract_expired'; message: string; settingLink: string } | null {
  const { tenant } = ctx;
  const settingLink = `/admin/tenants/${tenant.id}`;
  // Блокировка «запретить въезд» новые пропуска не запрещает (Q-73): они оформляются и ждут снятия.
  if (tenant.status !== 'active' && tenant.status !== 'blocked_entry') {
    const why = {
      blocked_new_passes: 'новые пропуска арендатору запрещены',
      blocked_full: 'арендатор заблокирован полностью',
      archived: 'арендатор в архиве',
    }[tenant.status];
    return {
      code: 'tenant_blocked',
      message: `Пропуск не оформлен: ${why}. Решение принимает администратор объекта.`,
      settingLink,
    };
  }
  const view = ctx.rules.tenants.find((t) => t.id === tenant.id);
  const today = localDate(ctx.now, ctx.site.timezone);
  if (view?.contractValidTo && view.contractValidTo < today) {
    return {
      code: 'contract_expired',
      message: `Договор арендатора закончился ${view.contractValidTo.split('-').reverse().join('.')} — новые пропуска не оформляются.`,
      settingLink,
    };
  }
  return null;
}

/** Новые пропуска не оформляются заблокированному арендатору и после конца договора. */
export function assertTenantAcceptsPasses(ctx: PassContext): void {
  const problem = tenantPassProblem(ctx);
  if (problem) throw new AppError(problem.code, problem);
}

/**
 * Номер или человек в чёрном списке на момент начала пропуска (решение Q-76): пропуск не оформляется.
 * Запись, которая кончается раньше начала, не мешает. Арендатору — без причины и с телефоном
 * дежурного администратора, если он задан; администратору — с причиной.
 */
export function blacklistProblem(
  ctx: PassContext,
  who: { plateNorm?: string | null | undefined; personName?: string | null | undefined },
  startsAt: number | null,
): { message: string; settingLink?: string } | null {
  const at = Math.max(startsAt ?? ctx.now, ctx.now);
  const hit = findBlacklisted(ctx.rules.blacklist, who, at);
  if (!hit) return null;
  if (!ctx.tenantUser) {
    return {
      message: `В чёрном списке: ${hit.reason}. Пропуск оформить нельзя — сначала уберите запись из списка.`,
      settingLink: '/admin/blacklist',
    };
  }
  const subject = who.plateNorm ? 'Номер' : 'Человек';
  const phone = ctx.settings.dutyAdminPhone
    ? ` (дежурный администратор: ${ctx.settings.dutyAdminPhone})`
    : '';
  return {
    message: `${subject} в чёрном списке объекта — пропуск оформить нельзя. Обратитесь к администратору объекта${phone}.`,
  };
}

/**
 * Проверка значений пропуска. `changed` — какие поля задаёт этот запрос: «не в прошлом» проверяется
 * только при создании и при изменении начала (ADR-009 п. 6).
 */
export async function validatePass(
  s: Scope,
  ctx: PassContext,
  values: PassValues,
  changed: ReadonlySet<PassField> | 'all',
): Promise<void> {
  const { rules, tenant, settings, site } = ctx;
  const tz = site.timezone;
  const touched = (field: PassField) => changed === 'all' || changed.has(field);

  if (values.participant === 'vehicle') {
    if (!values.plateNorm) throw fail('plate_required', 'plate');
    if (!values.categoryId) throw fail('category_required', 'categoryId');
    const category = rules.categories.find((c) => c.id === values.categoryId);
    if (!category) {
      throw fail(
        'category_unavailable',
        'categoryId',
        'Этот тип транспорта выключен или не настроен на объекте. Выберите тип из списка.',
      );
    }
    const at = values.validFrom?.getTime() ?? ctx.now;
    const quotas = applicableQuotas(rules.quotas, tenant.id, { categoryId: category.id }, at, tz);
    const forbidden = quotas.length > 0 && quotas.every((q) => capacityOf(q, rules.docks) === 0);
    if (forbidden && touched('categoryId')) {
      const waived = collectWaivers(asEnginePass(values, tenant.id), rules.exceptions, at).waived;
      if (!waived.has('quota')) {
        // Q-57: пользователю арендатора — простыми словами и куда обратиться.
        throw new AppError('category_unavailable', {
          field: 'categoryId',
          message: ctx.tenantUser
            ? `Тип «${category.name}» для вашей компании не предусмотрен. Если нужен — обратитесь к администратору объекта.`
            : `Тип «${category.name}» не предусмотрен договором арендатора (лимит 0) — такой пропуск не пропустят на въезд. Изменить: лимиты арендатора или исключение.`,
          ...(ctx.tenantUser ? {} : { settingLink: `/admin/tenants/${tenant.id}/quotas` }),
        });
      }
    }
    const docks = tenantDocks(rules, tenant.id);
    const list = dockRanges(docks.map((d) => d.number));
    const whose = ctx.tenantUser ? 'Ваши доки' : 'Доки арендатора';
    if (tenant.trucksDockRequired && category.dockEligible && !values.dockId) {
      throw fail(
        'dock_required',
        'dockId',
        list
          ? `Укажите док. ${whose}: ${list}`
          : 'Укажите док: грузовые этого арендатора стоят только у доков.',
      );
    }
    if (values.dockId && !docks.some((d) => d.id === values.dockId)) {
      throw fail(
        'dock_not_assigned',
        'dockId',
        list ? `Этот док не закреплён за арендатором. ${whose}: ${list}` : undefined,
      );
    }
  } else {
    if (!values.personName) throw fail('person_required', 'personName');
    if (values.plateNorm || values.categoryId || values.dockId) {
      throw new AppError('validation_failed', {
        field: values.plateNorm ? 'plate' : values.categoryId ? 'categoryId' : 'dockId',
        message: 'У пропуска пешехода нет номера, типа транспорта и дока.',
      });
    }
  }

  if (touched('plateNorm') || touched('personName') || touched('validFrom')) {
    const listed = blacklistProblem(
      ctx,
      values.participant === 'vehicle'
        ? { plateNorm: values.plateNorm }
        : { personName: values.personName },
      values.validFrom?.getTime() ?? null,
    );
    if (listed) {
      throw new AppError('blacklisted', {
        field: values.participant === 'vehicle' ? 'plate' : 'personName',
        message: listed.message,
        ...(listed.settingLink ? { settingLink: listed.settingLink } : {}),
      });
    }
  }

  if (values.destinationZoneId && !rules.zones.some((z) => z.id === values.destinationZoneId)) {
    throw fail('validation_failed', 'destinationZoneId', 'Место назначения не найдено на объекте.');
  }
  if (touched('purposeId')) {
    await assertRef(s, schema.visitPurposes, values.purposeId, {
      siteId: site.id,
      field: 'purposeId',
      title: 'Цель визита',
    });
  }

  // Срок действия (10_ §3).
  const from = values.validFrom;
  const to = values.validTo;
  if (!from) throw fail('invalid_period', 'validFrom', 'Укажите начало действия пропуска.');
  // «На сейчас» из формы приходит с задержкой сети — допуск задаёт объект (Q-58).
  const tolerance = settings.pastStartToleranceMin * 60_000;
  if (touched('validFrom') && from.getTime() < ctx.now - tolerance) {
    throw fail(
      'starts_in_past',
      'validFrom',
      `Начало пропуска в прошлом (${formatDateTime(from.getTime(), tz)}, ${siteTimeLabel(site, ctx.now)}). Укажите время не раньше текущего.`,
    );
  }
  if (values.passType === 'permanent') {
    if (to !== null) {
      throw fail(
        'invalid_period',
        'validTo',
        'У постоянного пропуска нет окончания — оставьте поле пустым.',
      );
    }
  } else {
    if (!to) throw fail('invalid_period', 'validTo', 'Укажите окончание действия пропуска.');
    if (to.getTime() <= from.getTime()) {
      throw fail('invalid_period', 'validTo', 'Окончание должно быть позже начала.');
    }
    if (values.passType === 'single') {
      const hours = (to.getTime() - from.getTime()) / 3_600_000;
      if (hours > settings.singlePassMaxHours) {
        throw fail(
          'invalid_period',
          'validTo',
          `Разовый пропуск — не дольше ${settings.singlePassMaxHours} ч. Для нескольких дней оформите многоразовый.`,
        );
      }
    } else {
      const days = overageDays(from.getTime(), to.getTime(), tz);
      if (days < settings.multiPassMinDays || days > settings.multiPassMaxDays) {
        throw fail(
          'invalid_period',
          'validTo',
          `Многоразовый пропуск — от ${settings.multiPassMinDays} до ${settings.multiPassMaxDays} дней (сейчас ${days}).`,
        );
      }
    }
  }

  // Окно прибытия (10_ §3).
  const wf = values.windowFrom;
  const wt = values.windowTo;
  if ((wf === null) !== (wt === null)) {
    throw fail(
      'validation_failed',
      wf === null ? 'windowFrom' : 'windowTo',
      'Укажите окно прибытия целиком: с и по.',
    );
  }
  if (wf && wt) {
    if (wt.getTime() <= wf.getTime())
      throw fail('invalid_period', 'windowTo', 'Конец окна должен быть позже начала.');
    if (wf.getTime() < from.getTime() || (to !== null && wt.getTime() > to.getTime())) {
      throw fail('window_outside_validity', 'windowFrom');
    }
  }
  if (values.participant === 'vehicle' && !wf && windowRequiredByPolicy(ctx, values)) {
    throw fail('window_required', 'windowFrom');
  }
}

/**
 * Политика окон прибытия требует окно для этого пропуска и исключение не снимает проверку окна.
 * Форма может не требовать окно (ADR-023) — тогда сервер подставляет окно на весь срок пропуска.
 */
export function windowRequiredByPolicy(ctx: PassContext, values: PassValues): boolean {
  if (values.participant !== 'vehicle') return false;
  const policy = windowPolicyFor(ctx.rules, ctx.tenant.id, values.categoryId);
  if (!policy?.windowRequired) return false;
  const at = values.validFrom?.getTime() ?? ctx.now;
  const waived = collectWaivers(
    asEnginePass(values, ctx.tenant.id),
    ctx.rules.exceptions,
    at,
  ).waived;
  return !waived.has('time_window');
}

/** Политика согласования (10_ §6): своя у арендатора важнее политики объекта. */
export async function approvalPolicy(
  s: Scope,
  siteId: string,
  tenantId: string,
  creatorKind: ApprovalCreatorKind,
  passType: PassType,
): Promise<{ mode: ApprovalMode; commentRequired: boolean } | null> {
  const rows = await s.db
    .select()
    .from(schema.approvalPolicies)
    .where(
      and(
        eq(schema.approvalPolicies.organizationId, s.organizationId),
        eq(schema.approvalPolicies.siteId, siteId),
        eq(schema.approvalPolicies.creatorKind, creatorKind),
        eq(schema.approvalPolicies.passType, passType),
      ),
    );
  const own = rows.find((r) => r.tenantId === tenantId);
  const site = rows.find((r) => r.tenantId === null);
  const policy = own ?? site;
  return policy ? { mode: policy.mode, commentRequired: policy.commentRequired } : null;
}

/** Кто создаёт пропуск — для политики: пост, пользователь арендатора или сотрудник оператора. */
export function creatorKindOf(s: Scope): ApprovalCreatorKind {
  if (s.ctx.actor.kind === 'gate_account') return 'gate';
  return isTenantUser(s.ctx.actor) ? 'tenant' : 'admin';
}

export const CREATOR_LABEL: Record<ApprovalCreatorKind, string> = {
  tenant: 'Арендатор',
  gate: 'Охрана',
  admin: 'Администратор',
};
export const PASS_TYPE_LABEL: Record<PassType, string> = {
  single: 'Разовый',
  multi: 'Многоразовый',
  permanent: 'Постоянный',
};
