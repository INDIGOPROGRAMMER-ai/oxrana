import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { AppError } from '../errors';

/**
 * Секреты входа (ADR-007, ADR-018). Токены сессий, устройств, приглашений и ссылок — 32 случайных
 * байта (base64url); в БД — SHA-256. Пароли — argon2id. Ни токены, ни коды, ни пароли не пишутся
 * в логи (редакция pino) и не уходят в события.
 */

/** Случайный токен: 32 байта base64url. Показывается один раз, в БД — `sha256Hex`. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Шесть цифр для входа по коду: перебор ограничен числом попыток и сроком. */
export function randomDigits(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(10));
  return out;
}

/** Алфавит кода привязки без похожих символов (0/O, 1/I/L): код набирают руками на посту. */
const ENROLL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Код привязки устройства «ABCD-2345»: 31^8 ≈ 8·10^11 вариантов, 10 минут, один раз. */
export function enrollmentCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += ENROLL_ALPHABET[randomInt(ENROLL_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Код привязки, как его ввели: регистр, пробелы и дефис не важны. */
export function normalizeEnrollmentCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Параметры argon2id — рекомендация OWASP (19 МиБ памяти, 2 прохода): проверка ~30–50 мс на
 * сервере объекта, перебор офлайн при утечке базы дорог.
 */
// algorithm: 2 — Argon2id (const enum пакета недоступен при verbatimModuleSyntax).
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/**
 * Проверка пароля для несуществующего логина: та же работа argon2, чтобы по времени ответа
 * нельзя было понять, есть ли такой пользователь.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummy ??= hashPassword(randomToken());
  await verifyPassword(await dummy, password);
}

/** Пароль не короче 10 символов и не только из цифр (не телефон и не дата). */
export function assertPasswordStrong(password: string, field = 'password'): void {
  if (password.length < 10 || /^\d+$/.test(password) || new Set(password).size < 4) {
    throw new AppError('password_weak', { field });
  }
}
