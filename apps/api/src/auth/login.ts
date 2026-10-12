import { sha256Hex } from './crypto';

/**
 * Логин — e-mail или телефон (ADR-007). E-mail сравнивается без учёта регистра, телефон — по
 * цифрам: «8 (900) 123-45-67», «+7 900 1234567» и «79001234567» — один и тот же логин.
 */
export type Login =
  | { readonly kind: 'email'; readonly value: string }
  | {
      readonly kind: 'phone';
      readonly value: string;
    };

/** Телефон в виде «+79001234567»; российский номер с 8 или без кода страны приводится к +7. */
export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return `+${digits}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseLogin(login: string): Login {
  const trimmed = login.trim();
  return trimmed.includes('@')
    ? { kind: 'email', value: normalizeEmail(trimmed) }
    : { kind: 'phone', value: normalizePhone(trimmed) };
}

/** Логин в журнале входа — только хэшем: сам e-mail или телефон в журнал не попадает. */
export function loginHash(login: Login): string {
  return sha256Hex(`${login.kind}:${login.value}`);
}
