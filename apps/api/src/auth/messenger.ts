/**
 * Доставка приглашений, ссылок восстановления и кодов входа (ADR-018). Каналы (e-mail, SMS) —
 * этап уведомлений (ARCHITECTURE §6, Q-33, Q-35); до него — заглушка: сообщение не уходит, в лог
 * пишется только факт и вид сообщения, без ссылки и кода.
 */
export type AuthMessageKind = 'invitation' | 'password_reset' | 'login_code';

export interface AuthMessage {
  readonly kind: AuthMessageKind;
  readonly to: { readonly email: string | null; readonly phone: string | null };
  /** Одноразовая ссылка (приглашение, установка пароля). */
  readonly link?: string;
  /** Код входа. */
  readonly code?: string;
}

export interface AuthMessenger {
  send(message: AuthMessage): Promise<void>;
}

export interface MessengerLog {
  warn(obj: object, msg: string): void;
}

/** Заглушка-отправитель: ничего не отправляет, токены и коды в лог не попадают. */
export class StubMessenger implements AuthMessenger {
  constructor(private readonly log: MessengerLog | null = null) {}

  async send(message: AuthMessage): Promise<void> {
    this.log?.warn(
      { kind: message.kind },
      'Сообщение не отправлено: доставка по e-mail и SMS появится на этапе уведомлений',
    );
  }
}

/** Отправитель для тестов: складывает сообщения в память. */
export class MemoryMessenger implements AuthMessenger {
  readonly sent: AuthMessage[] = [];

  async send(message: AuthMessage): Promise<void> {
    this.sent.push(message);
  }

  last(kind: AuthMessageKind): AuthMessage | undefined {
    return this.sent.filter((m) => m.kind === kind).at(-1);
  }
}
