import {
  DeviceEnrolledSchema,
  DeviceEnrollSchema,
  EnrollmentCreatedSchema,
  EnrollmentCreateSchema,
  GateAccountViewSchema,
  GateDeviceViewSchema,
  IdParamsSchema,
  RevokeDeviceSchema,
  SiteParamsSchema,
} from '@oxrana/contracts';
import { organizationOfToken, schema, withOrganization } from '@oxrana/db';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { enrollmentCode, normalizeEnrollmentCode, randomToken, sha256Hex } from '../../auth/crypto';
import { assertIpNotThrottled } from '../../auth/throttle';
import { ctxOf, type Scope } from '../../core/context';
import { loadGate, loadSite, notFound } from '../../core/loaders';
import { AppError } from '../../errors';
import { insertAudit, recordUserAuth } from './session';

/** Код привязки действует 10 минут и один раз (ADR-007). */
export const ENROLLMENT_TTL_MS = 10 * 60_000;

type DeviceRow = typeof schema.gateDevices.$inferSelect;

function deviceView(d: DeviceRow) {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    enrolledAt: d.enrolledAt.toISOString(),
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    appVersion: d.appVersion,
    revokedAt: d.revokedAt?.toISOString() ?? null,
    revokeReason: d.revokeReason,
  };
}

/**
 * Учётка КПП создаётся вместе с КПП (A11, ADR-018): одна на КПП, роль — шаблон «Пост КПП»
 * организации. Нет такой роли (удалили) — КПП не создаётся: пост без прав бесполезен.
 */
export async function createGateAccount(
  s: Scope,
  gate: { id: string; siteId: string },
): Promise<Record<string, { from: unknown; to: unknown }>> {
  const [role] = await s.db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.organizationId, s.organizationId),
        eq(schema.roles.templateCode, 'gate_post'),
        isNull(schema.roles.deletedAt),
      ),
    );
  if (!role) {
    throw new AppError('conflict', {
      message:
        'В организации нет роли «Пост КПП» — учётку КПП создать не из чего. Восстановите роль в разделе «Роли».',
      settingLink: '/admin/roles',
    });
  }
  await s.db.insert(schema.gateAccounts).values({
    organizationId: s.organizationId,
    siteId: gate.siteId,
    gateId: gate.id,
    roleId: role.id,
  });
  return { gateAccount: { from: null, to: role.name } };
}

async function loadAccount(s: Scope, id: string) {
  const [account] = await s.db
    .select()
    .from(schema.gateAccounts)
    .where(
      and(eq(schema.gateAccounts.organizationId, s.organizationId), eq(schema.gateAccounts.id, id)),
    );
  if (!account) throw notFound('Учётка КПП');
  const gate = await loadGate(s, account.gateId);
  return { account, gate };
}

export function registerDeviceRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['devices'];

  typed.get(
    '/sites/:siteId/gate-accounts',
    {
      config: { permission: 'device.manage' },
      schema: {
        tags,
        summary: 'Учётки КПП объекта и их устройства',
        params: SiteParamsSchema,
        response: { 200: z.object({ items: z.array(GateAccountViewSchema) }) },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const site = await loadSite(s, request.params.siteId);
        const accounts = await s.db
          .select({
            account: schema.gateAccounts,
            gateName: schema.gates.name,
            roleName: schema.roles.name,
          })
          .from(schema.gateAccounts)
          .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
          .innerJoin(schema.roles, eq(schema.roles.id, schema.gateAccounts.roleId))
          .where(
            and(
              eq(schema.gateAccounts.organizationId, s.organizationId),
              eq(schema.gateAccounts.siteId, site.id),
              isNull(schema.gates.deletedAt),
            ),
          )
          .orderBy(asc(schema.gates.sort), asc(schema.gates.name));
        const ids = accounts.map((a) => a.account.id);
        const devices =
          ids.length === 0
            ? []
            : await s.db
                .select()
                .from(schema.gateDevices)
                .where(
                  and(
                    eq(schema.gateDevices.organizationId, s.organizationId),
                    inArray(schema.gateDevices.gateAccountId, ids),
                  ),
                )
                .orderBy(desc(schema.gateDevices.enrolledAt));
        return {
          items: accounts.map((a) => ({
            id: a.account.id,
            gateId: a.account.gateId,
            gateName: a.gateName,
            status: a.account.status,
            roleName: a.roleName,
            devices: devices.filter((d) => d.gateAccountId === a.account.id).map(deviceView),
          })),
        };
      });
    },
  );

  typed.post(
    '/gate-accounts/:id/enrollments',
    {
      config: { permission: 'device.manage' },
      schema: {
        tags,
        summary: 'Код и QR для привязки устройства к учётке КПП: 10 минут, один раз',
        params: IdParamsSchema,
        body: EnrollmentCreateSchema,
        response: { 201: EnrollmentCreatedSchema },
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const code = enrollmentCode();
      const created = await ctx.tx(async (s) => {
        const { account, gate } = await loadAccount(s, request.params.id);
        if (account.status !== 'active') {
          throw new AppError('conflict', {
            message: 'Учётка КПП отключена — привязать устройство нельзя.',
          });
        }
        const expiresAt = new Date(ctx.now() + ENROLLMENT_TTL_MS);
        const [row] = await s.db
          .insert(schema.deviceEnrollments)
          .values({
            organizationId: s.organizationId,
            gateAccountId: account.id,
            kind: request.body.kind,
            codeHash: sha256Hex(normalizeEnrollmentCode(code)),
            expiresAt,
            createdBy: ctx.actor.kind === 'user' ? ctx.actor.id : null,
          })
          .returning();
        if (!row) throw new Error('enrollment insert');
        await s.audit({
          siteId: gate.siteId,
          entity: 'gate_account',
          entityId: account.id,
          action: 'enrollment_issued',
          snapshot: { gate: gate.name, kind: request.body.kind },
        });
        return { id: row.id, expiresAt };
      });
      return reply.status(201).send({
        id: created.id,
        code,
        enrollUrl: `${ctx.deps.auth.gateUrl}/enroll#${code}`,
        expiresAt: created.expiresAt.toISOString(),
      });
    },
  );

  typed.post(
    '/gate-devices/:id/revoke',
    {
      config: { permission: 'device.manage' },
      schema: {
        tags,
        summary: 'Отозвать устройство: действует сразу, следующий запрос устройства — 401',
        params: IdParamsSchema,
        body: RevokeDeviceSchema,
        response: { 200: GateDeviceViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const [device] = await s.db
          .select()
          .from(schema.gateDevices)
          .where(
            and(
              eq(schema.gateDevices.organizationId, s.organizationId),
              eq(schema.gateDevices.id, request.params.id),
            ),
          );
        if (!device) throw notFound('Устройство');
        const { gate } = await loadAccount(s, device.gateAccountId);
        if (device.revokedAt) return deviceView(device);
        const [row = device] = await s.db
          .update(schema.gateDevices)
          .set({
            revokedAt: new Date(ctx.now()),
            revokedBy: ctx.actor.id,
            revokeReason: request.body.reason,
          })
          .where(eq(schema.gateDevices.id, device.id))
          .returning();
        await s.audit({
          siteId: gate.siteId,
          entity: 'gate_device',
          entityId: device.id,
          action: 'revoke',
          reason: request.body.reason,
          snapshot: { gate: gate.name, device: device.name },
        });
        await s.emit('gate_device.revoked', {
          siteId: gate.siteId,
          aggregate: 'gate_device',
          aggregateId: device.id,
          payload: { deviceId: device.id, gateId: gate.id },
        });
        return deviceView(row);
      });
    },
  );

  typed.post(
    '/devices/enroll',
    {
      config: { public: true },
      schema: {
        tags,
        summary: 'Привязать устройство по коду из админки: токен показывается один раз',
        body: DeviceEnrollSchema,
        response: { 201: DeviceEnrolledSchema },
      },
    },
    async (request, reply) => {
      const deps = app.deps;
      const now = deps.clock.now();
      await assertIpNotThrottled(deps.db, request.ip ?? null, now);
      const hash = sha256Hex(normalizeEnrollmentCode(request.body.code));
      const invalid = async () => {
        await recordUserAuth(deps, request, 'enrollment_failed', null);
        return new AppError('code_invalid', {
          field: 'code',
          message:
            'Код привязки неверный или устарел. Попросите новый: админка → Устройства КПП → «Привязать устройство».',
        });
      };
      const organizationId = await organizationOfToken(deps.db, 'enrollment', hash);
      if (!organizationId) throw await invalid();
      const token = randomToken();
      const result = await withOrganization(deps.db, organizationId, async (tx) => {
        const [row] = await tx
          .select({
            enrollment: schema.deviceEnrollments,
            account: schema.gateAccounts,
            gate: schema.gates,
            site: schema.sites,
          })
          .from(schema.deviceEnrollments)
          .innerJoin(
            schema.gateAccounts,
            eq(schema.gateAccounts.id, schema.deviceEnrollments.gateAccountId),
          )
          .innerJoin(schema.gates, eq(schema.gates.id, schema.gateAccounts.gateId))
          .innerJoin(schema.sites, eq(schema.sites.id, schema.gates.siteId))
          .where(
            and(
              eq(schema.deviceEnrollments.codeHash, hash),
              isNull(schema.deviceEnrollments.usedAt),
              gt(schema.deviceEnrollments.expiresAt, new Date(now)),
              eq(schema.gateAccounts.status, 'active'),
              isNull(schema.gates.deletedAt),
            ),
          );
        if (!row) return null;
        const { enrollment, account, gate, site } = row;
        const [device] = await tx
          .insert(schema.gateDevices)
          .values({
            organizationId,
            gateAccountId: account.id,
            name: request.body.name,
            kind: enrollment.kind,
            tokenHash: sha256Hex(token),
            enrolledBy: enrollment.createdBy,
            enrolledAt: new Date(now),
            lastSeenAt: new Date(now),
            lastIp: request.ip ?? null,
            appVersion: request.body.appVersion ?? null,
          })
          .returning();
        if (!device) throw new Error('device insert');
        // Код одноразовый: второй запрос с тем же кодом не найдёт неиспользованную строку.
        const [used] = await tx
          .update(schema.deviceEnrollments)
          .set({ usedAt: new Date(now), usedDeviceId: device.id })
          .where(
            and(
              eq(schema.deviceEnrollments.id, enrollment.id),
              isNull(schema.deviceEnrollments.usedAt),
            ),
          )
          .returning({ id: schema.deviceEnrollments.id });
        if (!used) throw new AppError('code_invalid', { field: 'code' });
        await insertAudit(tx, {
          organizationId,
          at: new Date(now),
          actorType: 'gate_account',
          actorGateAccountId: account.id,
          deviceId: device.id,
          requestId: request.id,
          ip: request.ip ?? null,
          siteId: site.id,
          entity: 'gate_device',
          entityId: device.id,
          action: 'enroll',
          snapshot: { gate: gate.name, device: device.name, issuedBy: enrollment.createdBy },
        });
        return { device, gate, site };
      });
      if (!result) throw await invalid();
      await recordUserAuth(deps, request, 'device_enrolled', null);
      return reply.status(201).send({
        token,
        device: { id: result.device.id, name: result.device.name, kind: result.device.kind },
        gate: { id: result.gate.id, name: result.gate.name },
        site: { id: result.site.id, name: result.site.name, timezone: result.site.timezone },
      });
    },
  );
}
