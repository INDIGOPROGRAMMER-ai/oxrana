import type { DomainEventType } from '@oxrana/contracts';
import type { Scope } from './context';

/**
 * Обработчики событий outbox, которые работают **в той же транзакции**, что и событие (ADR-023):
 * модуль регистрирует свой обработчик, `Scope.emit` вызывает их после записи события. Так
 * уведомления не теряются и не дублируются при падении процесса между записью и доставкой, а тест
 * видит результат сразу. Тяжёлые каналы (почта, Telegram) этап 10 ведёт из строк `notifications`.
 */
export interface EmittedEvent {
  readonly id: number;
  readonly type: DomainEventType;
  readonly siteId: string | null;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export type EventHook = (s: Scope, event: EmittedEvent) => Promise<void>;

const hooks: EventHook[] = [];

/** Подписаться на все события; обработчик сам выбирает нужные типы. Повторная регистрация одной функции игнорируется. */
export function onEmit(hook: EventHook): void {
  if (!hooks.includes(hook)) hooks.push(hook);
}

export async function runEmitHooks(s: Scope, event: EmittedEvent): Promise<void> {
  for (const hook of hooks) await hook(s, event);
}
