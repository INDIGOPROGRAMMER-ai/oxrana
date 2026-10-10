import { type Db, schema, withOrganization } from '@oxrana/db';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import pg from 'pg';
import type { RuleSetCache } from '../core/ruleset-cache';
import type { EventHub, HubEvent } from './hub';

/** События, после которых срез правил в кэше этого процесса устарел (изменение в другом процессе). */
const RULESET_EVENTS = ['rules.changed', 'site.changed', 'site.timezone_changed', 'tenant.changed'];

interface Notice {
  readonly id: number;
  readonly organizationId: string;
  readonly siteId: string | null;
}

export interface ListenerOptions {
  /** Строка подключения роли приложения: событие читается под RLS его организации. */
  readonly connectionString: string;
  readonly db: Db;
  readonly hub: EventHub;
  readonly ruleSets: RuleSetCache;
  readonly onError?: (error: unknown) => void;
}

type EventRow = typeof schema.domainEvents.$inferSelect;

function toHubEvent(row: EventRow): HubEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    siteId: row.siteId,
    type: row.type,
    at: row.at.toISOString(),
    aggregate: row.aggregate,
    aggregateId: row.aggregateId,
    payload: row.payload as Record<string, unknown>,
  };
}

/**
 * Одно выделенное соединение `LISTEN site_events` (не из пула), ADR-004 п. 3. NOTIFY несёт только
 * идентификаторы (триггер миграции 0002); событие читается из таблицы и публикуется в хаб по
 * порядку. Обрыв — переподключение с паузой и дочитывание пропущенного по последнему id.
 */
export class EventListener {
  private client: pg.Client | null = null;
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;

  constructor(private readonly options: ListenerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
    await this.chain;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      application_name: 'oxrana-listen',
    });
    client.on('notification', (message) => {
      if (message.channel !== 'site_events' || !message.payload) return;
      const notice = JSON.parse(message.payload) as Notice;
      this.enqueue(() => this.deliver([notice.id], notice.organizationId));
    });
    client.on('error', (error) => this.lost(error));
    client.on('end', () => this.lost(null));
    await client.connect();
    await client.query('LISTEN site_events');
    const reconnected = this.attempt > 0;
    this.client = client;
    this.attempt = 0;
    if (reconnected) this.enqueue(() => this.catchUp());
  }

  private lost(error: unknown): void {
    if (this.stopped || this.client === null) return;
    this.client = null;
    if (error) this.options.onError?.(error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempt++;
    const delay = Math.min(10_000, 500 * 2 ** this.attempt);
    this.retryTimer = setTimeout(() => {
      this.connect().catch((error: unknown) => {
        this.options.onError?.(error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error: unknown) => this.options.onError?.(error));
  }

  private async deliver(ids: number[], organizationId: string): Promise<void> {
    const rows = await withOrganization(this.options.db, organizationId, (tx) =>
      tx
        .select()
        .from(schema.domainEvents)
        .where(
          and(
            eq(schema.domainEvents.organizationId, organizationId),
            inArray(schema.domainEvents.id, ids),
          ),
        )
        .orderBy(asc(schema.domainEvents.id)),
    );
    for (const row of rows) this.publish(toHubEvent(row));
  }

  /** После переподключения: всё, что пришло, пока слушателя не было, — по организациям с подписчиками. */
  private async catchUp(): Promise<void> {
    for (const [organizationId, lastId] of this.options.hub.watched()) {
      const rows = await withOrganization(this.options.db, organizationId, (tx) =>
        tx
          .select()
          .from(schema.domainEvents)
          .where(
            and(
              eq(schema.domainEvents.organizationId, organizationId),
              gt(schema.domainEvents.id, lastId),
            ),
          )
          .orderBy(asc(schema.domainEvents.id))
          .limit(1000),
      );
      for (const row of rows) this.publish(toHubEvent(row));
    }
  }

  private publish(event: HubEvent): void {
    if (RULESET_EVENTS.includes(event.type)) {
      this.options.ruleSets.invalidate(event.organizationId, event.siteId);
    }
    this.options.hub.publish(event);
  }
}
