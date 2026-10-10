import { createHash } from 'node:crypto';

/** Пространство имён UUIDv5 сида (произвольная константа; менять нельзя — сменятся все id). */
const NAMESPACE = Buffer.from('7c0e5a6d3b1f4e2a9d8c6b5a4f3e2d1c', 'hex');

/**
 * Детерминированный id строки сида: UUIDv5 от естественного ключа («tenant/dns»). Повторный запуск
 * сида получает те же id, и `on conflict do nothing` пропускает уже созданные строки (ADR-014).
 */
export function seedId(...parts: string[]): string {
  const bytes = createHash('sha1').update(NAMESPACE).update(parts.join('/'), 'utf8').digest();
  const b = bytes.subarray(0, 16);
  b.writeUInt8(((b.readUInt8(6) & 0x0f) | 0x50) >>> 0, 6); // версия 5
  b.writeUInt8(((b.readUInt8(8) & 0x3f) | 0x80) >>> 0, 8); // вариант RFC 9562
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
