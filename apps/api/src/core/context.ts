import {
  DOMAIN_EVENT_PAYLOADS,
  type DomainEventPayload,
  type DomainEventType,
  PII_PAYLOAD_KEYS,
} from '@oxrana/contracts';
import { type Db, type DbTx, schema, withOrganization } from '@oxrana/db';
import type { FastifyRequest } from 'fastify';
import { type AccessScope, type Actor, coversSite, coversTenant, permissionsIn } from '../actor';
import type { AuthMessenger } from '../auth/messenger';
import type { Clock } from '../clock';
import { AppError } from '../errors';
import { forbiddenFor, permissionList } from '../permission-guard';
import type { EventHub } from '../realtime/hub';
import type { AuditDiff } from './diff';
import type { RuleSetCache } from './ruleset-cache';

/** Точки внедрения для тестов (гонка ADR-006): в рабочем сервере пусты. */
export interface ServiceHooks {
  /** Вызывается в транзакции въезда после чтения занятости, до записи визита. */
  afterOccupancyRead?: (tx: DbTx) => Promise<void>;
}

/** Вход и ссылки (ADR-018): адреса веба и поста, доставка сообщений, флаг Secure у cookie. */
export interface AuthDeps {
  /** Адрес веб-кабинета: ссылки приглашений и установки пароля. */
  readonly publicUrl: string;
  /** Адрес приложения поста: QR привязки устройства. */
  readonly gateUrl: string;
  readonly secureCookies: boolean;
  readonly messenger: AuthMessenger;
}

/** Зависимости сервисов: одна копия на процесс. */
export interface AppDeps {
  readonly auth: AuthDeps;
  readonly db: Db;
  readonly clock: Clock;
  readonly hub: EventHub;
  readonly ruleSets: RuleSetCache;
  readonly hooks: ServiceHooks;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

/** События, после которых срез правил объекта устарел. */
const RULESET_EVENTS = new Set<DomainEventType>([
  'rules.changed',
  'site.changed',
  'site.timezone_changed',
  'tenant.changed',
]);

/**
 * Контекст запроса для сервисов (ARCHITECTURE §2): актор, часы, зависимости. Всё, что меняет
 * данные, выполняется в `ctx.tx(scope => …)` — одна транзакция с RLS по организации; аудит и
 * события пишутся через `scope` в той же транзакции (ADR-004).
 */
export class Ctx {
  /** Права, которые потребовал запрос (группы «любое из»): маршрут и уточнения сервиса. */
  private readonly demanded: (readonly string[])[] = [];
  /** Области записей, которых коснулся запрос: объекты и арендаторы. */
  private readonly entered: AccessScope[] = [];

  constructor(
    readonly actor: Actor,
    readonly deps: AppDeps,
    readonly requestId: string,
    readonly ip: string | null,
  ) {}

  /**
   * Право нужно в каждой области, которой касается запрос (ADR-018): у сотрудника с разными ролями
   * на двух объектах права одного объекта не действуют на другом, у пользователя арендатора —
   * права одной компании на другую. Хук маршрута проверил объединение прав, здесь — область.
   */
  demand(anyOf: readonly string[]): void {
    if (anyOf.length === 0) return;
    this.demanded.push(anyOf);
    for (const scope of this.entered) this.verify(anyOf, scope);
  }

  /** Запрос коснулся записи этой области: все потребованные права должны действовать в ней. */
  enter(scope: AccessScope): void {
    this.entered.push(scope);
    for (const anyOf of this.demanded) this.verify(anyOf, scope);
  }

  /** Есть ли право во всех областях, которых коснулся запрос. */
  holds(permission: string): boolean {
    if (!this.actor.permissions.has(permission)) return false;
    return this.entered.every((scope) => permissionsIn(this.actor, scope).has(permission));
  }

  private verify(anyOf: readonly string[], scope: AccessScope): void {
    const held = permissionsIn(this.actor, scope);
    if (!anyOf.some((p) => held.has(p))) throw forbiddenFor(anyOf);
  }

  get organizationId(): string {
    return this.actor.organizationId;
  }

  now(): number {
    return this.deps.clock.now();
  }

  /**
   * Транзакция в контексте организации актора. Внутри — только `scope.db`: второе соединение из
   * пула, пока держится первое, при маленьком пуле ведёт к взаимной блокировке.
   */
  async tx<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
    const emitted: { type: DomainEventType; siteId: string | null }[] = [];
    const result = await withOrganization(this.deps.db, this.organizationId, (db) =>
      fn(new Scope(db, this, emitted)),
    );
    for (const event of emitted) {
      if (RULESET_EVENTS.has(event.type)) {
        this.deps.ruleSets.invalidate(this.organizationId, event.siteId);
      }
    }
    return result;
  }
}

export interface AuditInput {
  readonly siteId: string | null;
  readonly entity: string;
  readonly entityId: string;
  /** 'create', 'update', 'delete', 'cancel', 'check_in', 'undo', … */
  readonly action: string;
  readonly diff?: AuditDiff | null;
  readonly reason?: string | null;
  /** Названия на момент события (CLAUDE.md п. 6). */
  readonly snapshot?: Record<string, unknown> | null;
}

export interface EmitInput<T extends DomainEventType> {
  readonly siteId: string | null;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly payload: DomainEventPayload<T>;
}

/** Транзакция запроса: база, аудит, события. */
export class Scope {
  constructor(
    readonly db: DbTx,
    readonly ctx: Ctx,
    private readonly emitted: { type: DomainEventType; siteId: string | null }[],
  ) {}

  get organizationId(): string {
    return this.ctx.organizationId;
  }

  /** Вложенная транзакция (SAVEPOINT): ошибка внутри откатывает только её — строка пакета. */
  nested<T>(fn: (scope: Scope) => Promise<T>): Promise<T> {
    return this.db.transaction((sp) => fn(new Scope(sp, this.ctx, this.emitted)));
  }

  /** Запись аудита «было → стало, кто, с какого устройства, причина» (CLAUDE.md п. 6). */
  async audit(input: AuditInput): Promise<void> {
    const { actor } = this.ctx;
    await this.db.insert(schema.auditLog).values({
      organizationId: this.organizationId,
      siteId: input.siteId,
      at: new Date(this.ctx.now()),
      actorType: actor.kind,
      actorUserId: actor.kind === 'user' ? actor.id : null,
      actorGateAccountId: actor.kind === 'gate_account' ? actor.id : null,
      deviceId: actor.deviceId,
      requestId: this.ctx.requestId,
      ip: this.ctx.ip,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      diff: input.diff ?? null,
      reason: input.reason ?? null,
      snapshot: input.snapshot ?? null,
    });
  }

  /**
   * Событие в outbox `domain_events` (ADR-004) в этой же транзакции. Payload проверяется строгой
   * схемой из contracts и на отсутствие ПДн — ошибка здесь означает ошибку программы.
   */
  async emit<T extends DomainEventType>(type: T, input: EmitInput<T>): Promise<number> {
    const payload = DOMAIN_EVENT_PAYLOADS[type].parse(input.payload) as Record<string, unknown>;
    assertNoPii(type, payload);
    const [row] = await this.db
      .insert(schema.domainEvents)
      .values({
        organizationId: this.organizationId,
        siteId: input.siteId,
        at: new Date(this.ctx.now()),
        type,
        aggregate: input.aggregate,
        aggregateId: input.aggregateId,
        payload,
      })
      .returning({ id: schema.domainEvents.id });
    this.emitted.push({ type, siteId: input.siteId });
    return row?.id ?? 0;
  }
}

function assertNoPii(type: string, value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (PII_PAYLOAD_KEYS.has(key)) {
      throw new Error(`Событие ${type}: поле «${key}» с ПДн в payload запрещено (ADR-004).`);
    }
    assertNoPii(type, inner);
  }
}

/** Контекст сервиса из запроса закрытого маршрута (актор уже проверен хуком прав). */
export function ctxOf(request: FastifyRequest): Ctx {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  const ctx = new Ctx(actor, request.server.deps, request.id, request.ip ?? null);
  ctx.demand(permissionList(request.routeOptions.config.permission));
  return ctx;
}

/** Уточнение права по данным запроса (тип пропуска, вид действия поста): 403 с именем права. */
export function requirePermission(ctx: Ctx, ...anyOf: string[]): void {
  if (!anyOf.some((p) => ctx.actor.permissions.has(p))) throw forbiddenFor(anyOf);
  ctx.demand(anyOf);
}

/** Есть ли право — во всех областях, которых коснулся запрос. */
export function can(ctx: Ctx, permission: string): boolean {
  return ctx.holds(permission);
}

/** Объект вне области назначения актора — 403 (объект той же организации виден, но не его). */
export function assertSiteAccess(ctx: Ctx, siteId: string): void {
  if (!coversSite(ctx.actor, siteId)) {
    throw new AppError('forbidden', {
      message: 'Нет доступа к этому объекту: роль назначена на другой объект.',
      settingLink: '/admin/users',
    });
  }
  ctx.enter({ siteId });
}

/** Чужой арендатор у пользователя арендатора — 403, а не 404 (ADR-007). */
export function assertTenantAccess(ctx: Ctx, tenantId: string): void {
  if (!coversTenant(ctx.actor, tenantId)) {
    throw new AppError('forbidden', {
      message: 'Нет доступа к этому арендатору: вы работаете только со своими компаниями.',
    });
  }
  ctx.enter({ tenantId });
}
