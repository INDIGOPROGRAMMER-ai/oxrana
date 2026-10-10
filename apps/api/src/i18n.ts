import { z } from 'zod';

/** Сообщения валидации zod — по-русски (CLAUDE.md: интерфейс и ошибки по-русски). Глобальная настройка zod. */
export function useRussianZodMessages(): void {
  z.config(z.locales.ru());
}
