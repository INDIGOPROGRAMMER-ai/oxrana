/**
 * Инжектируемые часы (ADR-009 п. 5): сервисы берут «сейчас» только отсюда — тесты подставляют
 * фиксированное время и проверяют сценарии «13:40 до окна 14:00», «отмена через 2 минуты».
 * `Date.now()` вне этого файла в сервисах API не используется.
 */
export interface Clock {
  /** Миллисекунды с эпохи (UTC). */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Часы для тестов: стоят, пока их не передвинут. */
export class FixedClock implements Clock {
  private current: number;

  constructor(start: number | string | Date) {
    this.current = new Date(start).getTime();
  }

  now(): number {
    return this.current;
  }

  set(at: number | string | Date): void {
    this.current = new Date(at).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
