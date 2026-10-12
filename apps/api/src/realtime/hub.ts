/**
 * Рассылка событий подписчикам SSE внутри процесса (ADR-004 п. 3). Источник событий — слушатель
 * `LISTEN site_events` (`listener.ts`), который читает строку `domain_events` по id и публикует
 * её сюда. Фильтр по правам — в маршруте SSE (`visibleTo`), здесь — только по организации и объекту.
 */
export interface HubEvent {
  readonly id: number;
  readonly organizationId: string;
  readonly siteId: string | null;
  readonly type: string;
  readonly at: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

type Listener = (event: HubEvent) => void;

interface Subscription {
  readonly organizationId: string;
  /** `null` — все объекты организации (сброс кэша, служебные потребители). */
  readonly siteId: string | null;
  readonly listener: Listener;
}

export class EventHub {
  private readonly subscriptions = new Set<Subscription>();
  /** Последний опубликованный id по организации — для дочитывания после переподключения слушателя. */
  private readonly lastIds = new Map<string, number>();

  subscribe(organizationId: string, siteId: string | null, listener: Listener): () => void {
    const subscription: Subscription = { organizationId, siteId, listener };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  publish(event: HubEvent): void {
    const last = this.lastIds.get(event.organizationId) ?? 0;
    if (event.id > last) this.lastIds.set(event.organizationId, event.id);
    for (const s of this.subscriptions) {
      if (s.organizationId !== event.organizationId) continue;
      if (s.siteId !== null && s.siteId !== event.siteId) continue;
      try {
        s.listener(event);
      } catch {
        // один сломанный подписчик не мешает остальным; его соединение закроется само
      }
    }
  }

  /** Организации, у которых есть подписчики, и последний доставленный им id. */
  watched(): Map<string, number> {
    const result = new Map<string, number>();
    for (const s of this.subscriptions) {
      result.set(s.organizationId, this.lastIds.get(s.organizationId) ?? 0);
    }
    return result;
  }

  get size(): number {
    return this.subscriptions.size;
  }
}
