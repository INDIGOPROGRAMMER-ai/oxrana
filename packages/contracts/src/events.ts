/**
 * Типы доменных событий (outbox `domain_events`, ADR-004). Список наполняется на этапе 4.
 */
export const DOMAIN_EVENT_TYPES = [] as const satisfies readonly string[];

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
