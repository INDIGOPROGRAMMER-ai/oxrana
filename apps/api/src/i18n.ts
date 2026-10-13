import { z } from 'zod';

/**
 * Русские сообщения zod для разбора окружения: `config.ts` не импортирует `@oxrana/contracts`,
 * где локаль подключается для схем API и экранов (Q-67).
 */
export function useRussianZodMessages(): void {
  z.config(z.locales.ru());
}
