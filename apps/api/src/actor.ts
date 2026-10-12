/**
 * Кто делает запрос (ADR-007). До этапа 5 актора определяет `resolveActor`, переданный в
 * `buildApp` (тесты — фиктивный актор); на этапе 5 его будут строить сессия пользователя и токен
 * устройства поста из назначений ролей.
 */
export type ActorKind = 'user' | 'gate_account' | 'system';

export interface Actor {
  /** id пользователя или учётки КПП. */
  readonly id: string;
  readonly kind: ActorKind;
  readonly organizationId: string;
  /** Права из всех назначений актора (ADR-007). */
  readonly permissions: ReadonlySet<string>;
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
}

export function hasPermission(actor: Actor, permission: string): boolean {
  return actor.permissions.has(permission);
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
