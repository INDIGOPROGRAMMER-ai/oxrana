import type { BatchResult } from '@oxrana/contracts';
import { AppError } from '../errors';
import type { Scope } from './context';

/** Откат строки предпросмотра: запись проверена полным путём создания и не сохранена. */
class DryRunRollback extends Error {
  constructor() {
    super('dry-run');
  }
}

/**
 * Пакетный ввод справочников (доки, арендаторы, назначения): каждая строка — в своей вложенной
 * транзакции (SAVEPOINT) тем же кодом, что и одиночное создание, с аудитом и событием; ошибка
 * строки не мешает остальным (как пакет пропусков, B3). Предпросмотр (`dryRun`) проходит тот же
 * путь и откатывает каждую строку, поэтому повтор внутри пакета ловит `precheck`, а не база.
 */
export async function runBatch<T>(
  s: Scope,
  rows: readonly T[],
  options: {
    dryRun: boolean;
    /** Заранее известная ошибка строки (повтор внутри пакета, уже существует). */
    precheck?: (row: T, index: number) => AppError | null;
    create: (scope: Scope, row: T, index: number) => Promise<{ id: string }>;
  },
): Promise<BatchResult> {
  const result: BatchResult = {
    dryRun: options.dryRun,
    total: rows.length,
    created: 0,
    summary: '',
    errors: [],
    ids: [],
  };
  for (const [index, row] of rows.entries()) {
    const line = index + 1;
    const early = options.precheck?.(row, index) ?? null;
    if (early) {
      result.errors.push({
        row: line,
        field: early.field,
        code: early.code,
        message: early.message,
      });
      result.ids.push(null);
      continue;
    }
    try {
      const created = await s.nested(async (sp) => {
        const made = await options.create(sp, row, index);
        if (options.dryRun) throw new DryRunRollback();
        return made;
      });
      result.created++;
      result.ids.push(created.id);
    } catch (error) {
      if (error instanceof DryRunRollback) {
        result.created++;
        result.ids.push(null);
      } else if (error instanceof AppError) {
        result.errors.push({
          row: line,
          field: error.field,
          code: error.code,
          message: error.message,
        });
        result.ids.push(null);
      } else {
        throw error;
      }
    }
  }
  const verb = options.dryRun ? 'Будет добавлено' : 'Добавлено';
  result.summary = `${verb} ${result.created} из ${result.total}`;
  return result;
}
