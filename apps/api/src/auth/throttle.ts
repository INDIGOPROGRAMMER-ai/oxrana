import { type Db, type DbTx, schema } from '@oxrana/db';
import { and, count, desc, eq, gte, inArray } from 'drizzle-orm';
import { AppError } from '../errors';

/**
 * Журнал входа и ограничение попыток (ADR-018): по логину и по IP за 15 минут. Считает строки
 * `auth_events` — работает в нескольких процессах API и без Redis (CLAUDE.md, стек).
 */
export const THROTTLE_WINDOW_MS = 15 * 60_000;
/** Неудачных входов на один логин — после последнего удачного входа. */
export const MAX_FAILURES_PER_LOGIN = 5;
/** Неудач любого вида с одного IP: подбор пароля, кода, ссылки, кода привязки. */
export const MAX_FAILURES_PER_IP = 30;
/** Запросов ссылки или кода на один логин: больше — молча не отправляем. */
export const MAX_REQUESTS_PER_LOGIN = 3;
export const MAX_REQUESTS_PER_IP = 20;

/** Виды записей журнала входа. */
export type AuthEventKind =
  | 'login'
  | 'login_failed'
  | 'login_code_requested'
  | 'login_code_failed'
  | 'logout'
  | 'logout_all'
  | 'session_revoked'
  | 'password_set'
  | 'password_changed'
  | 'password_reset_requested'
  | 'link_failed'
  | 'invitation_accepted'
  | 'device_enrolled'
  | 'enrollment_failed';

const FAILURES: AuthEventKind[] = [
  'login_failed',
  'login_code_failed',
  'link_failed',
  'enrollment_failed',
];
const REQUESTS: AuthEventKind[] = ['login_code_requested', 'password_reset_requested'];

export interface AuthEventInput {
  readonly kind: AuthEventKind;
  readonly userId?: string | null;
  readonly loginHash?: string | null;
  readonly ip: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  readonly at: Date;
}

export async function recordAuthEvent(db: Db | DbTx, input: AuthEventInput): Promise<void> {
  await db.insert(schema.authEvents).values({
    kind: input.kind,
    userId: input.userId ?? null,
    loginHash: input.loginHash ?? null,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    requestId: input.requestId ?? null,
    at: input.at,
  });
}

function tooMany(): AppError {
  return new AppError('too_many_attempts');
}

/** IP подбирает пароли, коды или ссылки — 429 до любой проверки. */
export async function assertIpNotThrottled(db: Db, ip: string | null, now: number): Promise<void> {
  if (!ip) return;
  const [row] = await db
    .select({ n: count() })
    .from(schema.authEvents)
    .where(
      and(
        eq(schema.authEvents.ip, ip),
        inArray(schema.authEvents.kind, FAILURES),
        gte(schema.authEvents.at, new Date(now - THROTTLE_WINDOW_MS)),
      ),
    );
  if ((row?.n ?? 0) >= MAX_FAILURES_PER_IP) throw tooMany();
}

/**
 * Логин заблокирован после пяти неудач подряд (с последнего удачного входа) на 15 минут. Ответ
 * одинаков для существующего и несуществующего логина.
 */
export async function assertLoginNotThrottled(
  db: Db,
  hash: string,
  now: number,
  failureKinds: AuthEventKind[] = ['login_failed', 'login_code_failed'],
): Promise<void> {
  const since = new Date(now - THROTTLE_WINDOW_MS);
  const [lastSuccess] = await db
    .select({ at: schema.authEvents.at })
    .from(schema.authEvents)
    .where(and(eq(schema.authEvents.loginHash, hash), eq(schema.authEvents.kind, 'login')))
    .orderBy(desc(schema.authEvents.at))
    .limit(1);
  const from = lastSuccess && lastSuccess.at > since ? lastSuccess.at : since;
  const [row] = await db
    .select({ n: count() })
    .from(schema.authEvents)
    .where(
      and(
        eq(schema.authEvents.loginHash, hash),
        inArray(schema.authEvents.kind, failureKinds),
        gte(schema.authEvents.at, from),
      ),
    );
  if ((row?.n ?? 0) >= MAX_FAILURES_PER_LOGIN) throw tooMany();
}

/**
 * Запрос ссылки или кода: с одного IP больше 20 — 429; на один логин больше 3 — `false` (не
 * отправлять), но ответ тот же, что при отправке: по нему нельзя понять, есть ли логин.
 */
export async function mayRequestMessage(
  db: Db,
  hash: string,
  ip: string | null,
  now: number,
): Promise<boolean> {
  const since = new Date(now - THROTTLE_WINDOW_MS);
  if (ip) {
    const [byIp] = await db
      .select({ n: count() })
      .from(schema.authEvents)
      .where(
        and(
          eq(schema.authEvents.ip, ip),
          inArray(schema.authEvents.kind, REQUESTS),
          gte(schema.authEvents.at, since),
        ),
      );
    if ((byIp?.n ?? 0) >= MAX_REQUESTS_PER_IP) throw tooMany();
  }
  const [byLogin] = await db
    .select({ n: count() })
    .from(schema.authEvents)
    .where(
      and(
        eq(schema.authEvents.loginHash, hash),
        inArray(schema.authEvents.kind, REQUESTS),
        gte(schema.authEvents.at, since),
      ),
    );
  return (byLogin?.n ?? 0) < MAX_REQUESTS_PER_LOGIN;
}
