import { NEVER_FOR_GATE_ACCOUNT_PERMISSIONS } from '@oxrana/contracts';

/**
 * Кто делает запрос (ADR-007, ADR-018). Пользователя определяет cookie-сессия, устройство поста —
 * токен устройства (`auth/resolve.ts`); права — из назначений ролей в текущей организации.
 */
export type ActorKind = 'user' | 'gate_account' | 'system';

/**
 * Назначение роли в виде, удобном для проверки: права и область. `siteId` null — вся организация;
 * `tenantId` — назначение пользователя арендатора (его `siteId` — объект арендатора).
 */
export interface Grant {
  readonly permissions: ReadonlySet<string>;
  readonly siteId: string | null;
  readonly tenantId: string | null;
}

export interface Actor {
  /** id пользователя или учётки КПП. */
  readonly id: string;
  readonly kind: ActorKind;
  readonly organizationId: string;
  /** Права из всех назначений актора — для хука маршрута; область уточняет `grants`. */
  readonly permissions: ReadonlySet<string>;
  /** Назначения по отдельности: право проверяется в области записи (ADR-018). */
  readonly grants: readonly Grant[];
  /** Объекты, где действуют права; `null` — вся организация. */
  readonly siteIds: readonly string[] | null;
  /**
   * Арендаторы пользователя арендатора: запросы ограничены ими, чужой `tenantId` — 403.
   * `null` — сотрудник оператора или пост: без ограничения по арендатору.
   */
  readonly tenantIds: readonly string[] | null;
  /** КПП учётки поста: сервер подставляет его сам, клиент другой КПП выбрать не может. */
  readonly gateId: string | null;
  /** Устройство поста, с которого пришёл запрос (журнал: «пост, планшет»). */
  readonly deviceId: string | null;
  /** Сессия пользователя (выход, «выйти на всех устройствах»). */
  readonly sessionId?: string | null;
}

/** Область записи, в которой проверяется право. */
export interface AccessScope {
  readonly siteId?: string;
  readonly tenantId?: string;
}

export function hasPermission(actor: Actor, permission: string): boolean {
  return actor.permissions.has(permission);
}

function covers(grant: Grant, scope: AccessScope): boolean {
  return (
    (scope.siteId === undefined || grant.siteId === null || grant.siteId === scope.siteId) &&
    (scope.tenantId === undefined || grant.tenantId === null || grant.tenantId === scope.tenantId)
  );
}

/** Права актора, действующие в области: объединение назначений, которые её покрывают. */
export function permissionsIn(actor: Actor, scope: AccessScope): Set<string> {
  const out = new Set<string>();
  for (const grant of actor.grants) {
    if (covers(grant, scope)) for (const p of grant.permissions) out.add(p);
  }
  return out;
}

/** Пользователь арендатора: видит и создаёт только у своих арендаторов. */
export function isTenantUser(actor: Actor): boolean {
  return actor.kind === 'user' && actor.tenantIds !== null;
}

/** Есть ли у актора доступ к объекту (область назначения). */
export function coversSite(actor: Actor, siteId: string): boolean {
  return actor.siteIds === null || actor.siteIds.includes(siteId);
}

/** Есть ли у актора доступ к арендатору. */
export function coversTenant(actor: Actor, tenantId: string): boolean {
  return actor.tenantIds === null || actor.tenantIds.includes(tenantId);
}

/**
 * Актор из назначений ролей одной организации (ADR-018):
 *  - есть назначения сотрудника оператора (без арендатора) — актор-сотрудник, назначения в
 *    арендаторах не учитываются (иначе право арендатора расширялось бы до всего объекта);
 *  - только назначения в арендаторах — пользователь арендатора: его арендаторы и их объекты.
 */
export function actorFromGrants(base: {
  id: string;
  kind: ActorKind;
  organizationId: string;
  grants: readonly Grant[];
  gateId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
}): Actor {
  const staff = base.grants.filter((g) => g.tenantId === null);
  const own = staff.length > 0 ? staff : base.grants;
  // Учётка КПП не получает часть прав никогда, даже если их добавили в её роль (ADR-007, 7b.3).
  const grants =
    base.kind === 'gate_account'
      ? own.map((g) => ({
          ...g,
          permissions: new Set(
            [...g.permissions].filter(
              (p) => !(NEVER_FOR_GATE_ACCOUNT_PERMISSIONS as readonly string[]).includes(p),
            ),
          ),
        }))
      : own;
  const permissions = new Set<string>();
  for (const g of grants) for (const p of g.permissions) permissions.add(p);
  const tenantUser = staff.length === 0 && base.kind === 'user';
  const siteIds = grants.some((g) => g.siteId === null)
    ? null
    : [...new Set(grants.map((g) => g.siteId).filter((s): s is string => s !== null))];
  return {
    id: base.id,
    kind: base.kind,
    organizationId: base.organizationId,
    permissions,
    grants,
    siteIds,
    tenantIds: tenantUser
      ? [...new Set(grants.map((g) => g.tenantId).filter((t): t is string => t !== null))]
      : null,
    gateId: base.gateId ?? null,
    deviceId: base.deviceId ?? null,
    sessionId: base.sessionId ?? null,
  };
}
