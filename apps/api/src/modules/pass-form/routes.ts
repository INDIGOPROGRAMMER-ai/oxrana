import {
  applyPassFormPatch,
  PASS_TYPES,
  PassFormEditorQuerySchema,
  PassFormEditorSchema,
  type PassFormLevel,
  PassFormMineSchema,
  type PassFormSettings,
  PassFormSettingsPatchSchema,
  PassFormSettingsSchema,
  PassFormSavedSchema,
  type PassType,
  SiteParamsSchema,
  TenantParamsSchema,
  TenantUserParamsSchema,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { actorFromGrants, permissionsIn } from '../../actor';
import { grantsOf } from '../../auth/resolve';
import { can, ctxOf, type Scope } from '../../core/context';
import { type AuditDiff, diffOf } from '../../core/diff';
import { loadSite, loadTenant, notFound, type SiteRow, type TenantRow } from '../../core/loaders';
import { AppError } from '../../errors';
import { availableCategories } from '../passes/hints';
import { approvalPolicy } from '../passes/validate';
import { loadActorForm, loadFormLayers } from './service';

// Настройка формы пропуска по уровням (этап 7b, ADR-023): форма пользователя, редактор с
// предпросмотром, сохранение уровня «объект», «арендатор», «сотрудник».

const VIEW = ['pass.view', 'pass.view_all_tenants'] as const;
const EDITOR = ['pass_form.manage', 'pass_form.manage_users'] as const;

/** Плоский вид настроек уровня для журнала «было → стало». */
function flatten(settings: PassFormSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {
    categoryIds: settings.categoryIds ?? null,
    defaultCategoryId: settings.defaultCategoryId ?? null,
    passTypes: settings.passTypes ?? null,
    defaultPassType: settings.defaultPassType ?? null,
    singleHours: settings.singleHours ?? null,
  };
  for (const [key, value] of Object.entries(settings.fields ?? {})) out[`fields.${key}`] = value;
  return out;
}

function auditDiff(before: PassFormSettings, after: PassFormSettings): AuditDiff {
  const a = flatten(before);
  const b = flatten(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return diffOf(a, { ...Object.fromEntries(keys.map((k) => [k, null])), ...b }, keys);
}

interface LevelTarget {
  readonly level: PassFormLevel;
  readonly site: SiteRow;
  readonly tenant: TenantRow | null;
  readonly userId: string | null;
}

async function loadRow(s: Scope, t: LevelTarget) {
  const rows = await s.db
    .select()
    .from(schema.passFormSettings)
    .where(
      and(
        eq(schema.passFormSettings.organizationId, s.organizationId),
        eq(schema.passFormSettings.siteId, t.site.id),
        eq(schema.passFormSettings.level, t.level),
        t.tenant
          ? eq(schema.passFormSettings.tenantId, t.tenant.id)
          : isNull(schema.passFormSettings.tenantId),
        t.userId
          ? eq(schema.passFormSettings.userId, t.userId)
          : isNull(schema.passFormSettings.userId),
      ),
    );
  return rows[0] ?? null;
}

/** Сотрудник — в этой компании (иначе настраивать нечего). */
async function loadTenantUser(s: Scope, tenant: TenantRow, userId: string) {
  const [row] = await s.db
    .select({ id: schema.users.id, name: schema.users.fullName })
    .from(schema.users)
    .innerJoin(schema.roleAssignments, eq(schema.roleAssignments.userId, schema.users.id))
    .where(
      and(
        eq(schema.roleAssignments.organizationId, s.organizationId),
        eq(schema.roleAssignments.tenantId, tenant.id),
        eq(schema.users.id, userId),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Сотрудник этой компании');
  return row;
}

/** Проверка значений уровня по справочникам: типы транспорта, тип по умолчанию, часы разового. */
async function assertSettingsValid(
  s: Scope,
  t: LevelTarget,
  settings: PassFormSettings,
): Promise<void> {
  const { rules } = await s.ctx.deps.ruleSets.get(s.db, s.organizationId, t.site.id);
  const known = t.tenant
    ? availableCategories(rules, t.tenant.id, s.ctx.now(), t.site.timezone)
    : rules.categories;
  const knownIds = new Set(known.map((c) => c.id));
  for (const id of settings.categoryIds ?? []) {
    if (!knownIds.has(id)) {
      throw new AppError('category_unavailable', {
        field: 'categoryIds',
        message: t.tenant
          ? 'Этот тип транспорта арендатору недоступен (лимит 0 или тип выключен) — выберите из доступных ему.'
          : 'Этот тип транспорта выключен на объекте.',
      });
    }
  }
  if (settings.defaultCategoryId && !knownIds.has(settings.defaultCategoryId)) {
    throw new AppError('category_unavailable', {
      field: 'defaultCategoryId',
      message: 'Тип транспорта по умолчанию должен быть среди доступных.',
    });
  }
  if (
    settings.categoryIds &&
    settings.defaultCategoryId &&
    !settings.categoryIds.includes(settings.defaultCategoryId)
  ) {
    throw new AppError('validation_failed', {
      field: 'defaultCategoryId',
      message: 'Тип по умолчанию должен входить в список разрешённых типов этого уровня.',
    });
  }
  if (
    settings.passTypes &&
    settings.defaultPassType &&
    !settings.passTypes.includes(settings.defaultPassType)
  ) {
    throw new AppError('validation_failed', {
      field: 'defaultPassType',
      message: 'Вид пропуска по умолчанию должен входить в список разрешённых видов этого уровня.',
    });
  }
  const max = t.site.settings ? ((t.site.settings as { singlePassMaxHours?: number }).singlePassMaxHours ?? 24) : 24;
  if (settings.singleHours !== undefined && settings.singleHours > max) {
    throw new AppError('invalid_period', {
      field: 'singleHours',
      message: `Разовый пропуск на объекте — не дольше ${max} ч (Настройки → Сроки и рабочее время). Укажите не больше.`,
      settingLink: '/admin/policies',
    });
  }
}

async function saveLevel(
  s: Scope,
  t: LevelTarget,
  patch: ReturnType<typeof PassFormSettingsPatchSchema.parse>,
  userName: string | null,
) {
  const { reason, ...changes } = patch;
  const row = await loadRow(s, t);
  const before = PassFormSettingsSchema.catch({}).parse(row?.settings ?? {});
  const after = applyPassFormPatch(before, changes);
  const diff = auditDiff(before, after);
  if (Object.keys(diff).length === 0) return after;
  await assertSettingsValid(s, t, after);

  const empty = Object.keys(after).length === 0;
  let entityId = row?.id ?? '';
  if (empty && row) {
    await s.db.delete(schema.passFormSettings).where(eq(schema.passFormSettings.id, row.id));
  } else if (row) {
    await s.db
      .update(schema.passFormSettings)
      .set({ settings: after, updatedBy: s.ctx.actor.id })
      .where(eq(schema.passFormSettings.id, row.id));
  } else {
    const [created] = await s.db
      .insert(schema.passFormSettings)
      .values({
        organizationId: s.organizationId,
        siteId: t.site.id,
        level: t.level,
        tenantId: t.tenant?.id ?? null,
        userId: t.userId,
        settings: after,
        updatedBy: s.ctx.actor.id,
      })
      .returning({ id: schema.passFormSettings.id });
    entityId = created?.id ?? '';
  }
  await s.audit({
    siteId: t.site.id,
    entity: 'pass_form_settings',
    entityId,
    action: row ? (empty ? 'delete' : 'update') : 'create',
    diff,
    reason: reason ?? null,
    snapshot: {
      level: t.level,
      site: t.site.name,
      ...(t.tenant ? { tenant: t.tenant.shortName } : {}),
      ...(userName ? { user: userName } : {}),
    },
  });
  await s.emit('pass_form.changed', {
    siteId: t.site.id,
    aggregate: 'pass_form',
    aggregateId: entityId || t.site.id,
    payload: { level: t.level, ...(t.tenant ? { tenantId: t.tenant.id } : {}) },
  });
  return after;
}

export function registerPassFormRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['pass-form'];

  typed.get(
    '/tenants/:tenantId/pass-form',
    {
      config: { permission: VIEW },
      schema: {
        tags,
        summary: 'Форма пропуска для текущего пользователя: итог уровней объект → арендатор → сотрудник',
        params: TenantParamsSchema,
        response: { 200: PassFormMineSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        const site = await loadSite(s, tenant.siteId);
        const { form, enforced } = await loadActorForm(s, tenant);
        const max = (site.settings as { singlePassMaxHours?: number }).singlePassMaxHours ?? 24;
        return { form, enforced, singlePassMaxHours: max };
      });
    },
  );

  typed.get(
    '/tenants/:tenantId/pass-form/editor',
    {
      config: { permission: EDITOR },
      schema: {
        tags,
        summary:
          'Редактор формы: слои как сохранены, сотрудники компании и права выбранного сотрудника',
        params: TenantParamsSchema,
        querystring: PassFormEditorQuerySchema,
        response: { 200: PassFormEditorSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        const site = await loadSite(s, tenant.siteId);
        const userId = request.query.userId ?? null;
        const subjectUser = userId ? await loadTenantUser(s, tenant, userId) : null;
        const layers = await loadFormLayers(s, site.id, tenant.id, userId);

        const people = await s.db
          .selectDistinct({ id: schema.users.id, name: schema.users.fullName })
          .from(schema.users)
          .innerJoin(schema.roleAssignments, eq(schema.roleAssignments.userId, schema.users.id))
          .where(
            and(
              eq(schema.roleAssignments.organizationId, s.organizationId),
              eq(schema.roleAssignments.tenantId, tenant.id),
            ),
          )
          .orderBy(asc(schema.users.fullName));

        // Права сотрудника в этой компании: «не шире прав роли».
        let passTypes: PassType[] = [...PASS_TYPES];
        if (userId) {
          const grants = await grantsOf(s.db, s.organizationId, userId);
          const target = actorFromGrants({
            id: userId,
            kind: 'user',
            organizationId: s.organizationId,
            grants,
          });
          const held = permissionsIn(target, { siteId: site.id, tenantId: tenant.id });
          passTypes = PASS_TYPES.filter((t) => held.has(`pass.create.${t}`));
        }
        const allowed: PassType[] = [];
        for (const type of passTypes) {
          const policy = await approvalPolicy(s, site.id, tenant.id, 'tenant', type);
          if (policy?.mode !== 'deny') allowed.push(type);
        }
        const max = (site.settings as { singlePassMaxHours?: number }).singlePassMaxHours ?? 24;
        return {
          tenant: { id: tenant.id, name: tenant.shortName },
          singlePassMaxHours: max,
          layers: {
            site: layers.site,
            tenant: layers.tenant,
            user: layers.user,
          },
          subject: {
            userId: subjectUser?.id ?? null,
            name: subjectUser?.name ?? null,
            passTypes: allowed,
          },
          users: people,
          canEdit: {
            site: can(ctx, 'pass_form.manage'),
            tenant: can(ctx, 'pass_form.manage'),
            user: can(ctx, 'pass_form.manage') || can(ctx, 'pass_form.manage_users'),
          },
        };
      });
    },
  );

  typed.patch(
    '/sites/:siteId/pass-form',
    {
      config: { permission: 'pass_form.manage' },
      schema: {
        tags,
        summary: 'Форма пропуска, уровень «объект»: только изменённые ключи; null — сбросить',
        params: SiteParamsSchema,
        body: PassFormSettingsPatchSchema,
        response: { 200: PassFormSavedSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const settings = await saveLevel(
          s,
          { level: 'site', site, tenant: null, userId: null },
          request.body,
          null,
        );
        return { settings };
      });
    },
  );

  typed.patch(
    '/tenants/:tenantId/pass-form',
    {
      config: { permission: 'pass_form.manage' },
      schema: {
        tags,
        summary: 'Форма пропуска, уровень «арендатор»: только изменённые ключи; null — сбросить',
        params: TenantParamsSchema,
        body: PassFormSettingsPatchSchema,
        response: { 200: PassFormSavedSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        const site = await loadSite(s, tenant.siteId);
        const settings = await saveLevel(
          s,
          { level: 'tenant', site, tenant, userId: null },
          request.body,
          null,
        );
        return { settings };
      });
    },
  );

  typed.patch(
    '/tenants/:tenantId/users/:userId/pass-form',
    {
      config: { permission: EDITOR },
      schema: {
        tags,
        summary:
          'Форма пропуска, уровень «сотрудник»: администратор объекта или ответственный своей компании',
        params: TenantUserParamsSchema,
        body: PassFormSettingsPatchSchema,
        response: { 200: PassFormSavedSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const tenant = await loadTenant(s, request.params.tenantId);
        const site = await loadSite(s, tenant.siteId);
        const user = await loadTenantUser(s, tenant, request.params.userId);
        const settings = await saveLevel(
          s,
          { level: 'user', site, tenant, userId: user.id },
          request.body,
          user.name,
        );
        return { settings };
      });
    },
  );
}

