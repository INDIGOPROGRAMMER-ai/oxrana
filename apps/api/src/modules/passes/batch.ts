import type { PassDraft, PassStatus } from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { eq } from 'drizzle-orm';
import type { Scope } from '../../core/context';
import type { TenantRow } from '../../core/loaders';
import { AppError } from '../../errors';
import { loadActorForm } from '../pass-form/service';
import { createPass, type PassWarning } from './service';

/** Откат строки предпросмотра: пропуск проверен вставкой (в том числе на дубли) и не сохранён. */
class DryRunRollback extends Error {
  constructor(
    readonly status: PassStatus,
    readonly warnings: PassWarning[],
  ) {
    super('dry-run');
  }
}

export interface BatchResult {
  batchId: string | null;
  dryRun: boolean;
  total: number;
  created: number;
  summary: string;
  errors: { row: number; field: string | null; code: string; message: string }[];
  passes: { row: number; passId: string | null; status: PassStatus; warnings: PassWarning[] }[];
}

/**
 * Пакетное создание (B3, сценарий 18): каждая строка — в своей вложенной транзакции, ошибка
 * строки не мешает остальным; итог «создано N из M» с причинами по строкам. Предпросмотр
 * (`dryRun`) проходит тот же путь, включая проверку дублей в базе и внутри пакета, и откатывается.
 */
export async function createBatch(
  s: Scope,
  tenant: TenantRow,
  rows: readonly PassDraft[],
  dryRun: boolean,
): Promise<BatchResult> {
  let batchId: string | null = null;
  if (!dryRun) {
    const [batch] = await s.db
      .insert(schema.passBatches)
      .values({
        organizationId: s.organizationId,
        siteId: tenant.siteId,
        tenantId: tenant.id,
        createdBy: s.ctx.actor.id,
        total: rows.length,
        created: 0,
        errors: [],
      })
      .returning();
    batchId = batch?.id ?? null;
  }

  const result: BatchResult = {
    batchId,
    dryRun,
    total: rows.length,
    created: 0,
    summary: '',
    errors: [],
    passes: [],
  };
  const via = s.ctx.actor.kind === 'gate_account' ? 'gate' : 'web';
  const form = await loadActorForm(s, tenant);
  for (const [index, draft] of rows.entries()) {
    const row = index + 1;
    try {
      const created = await s.nested(async (sp) => {
        const pass = await createPass(sp, tenant, draft, {
          via,
          form,
          ...(batchId ? { batchId } : {}),
        });
        if (dryRun) throw new DryRunRollback(pass.row.status, pass.warnings);
        return pass;
      });
      result.created++;
      result.passes.push({
        row,
        passId: created.row.id,
        status: created.row.status,
        warnings: created.warnings,
      });
    } catch (error) {
      if (error instanceof DryRunRollback) {
        result.created++;
        result.passes.push({ row, passId: null, status: error.status, warnings: error.warnings });
      } else if (error instanceof AppError) {
        result.errors.push({ row, field: error.field, code: error.code, message: error.message });
      } else {
        throw error;
      }
    }
  }

  result.summary = dryRun
    ? `Будет создано ${result.created} из ${result.total}`
    : `Создано ${result.created} из ${result.total}`;
  if (batchId) {
    await s.db
      .update(schema.passBatches)
      .set({ created: result.created, errors: result.errors })
      .where(eq(schema.passBatches.id, batchId));
    await s.audit({
      siteId: tenant.siteId,
      entity: 'pass_batch',
      entityId: batchId,
      action: 'create',
      snapshot: { total: result.total, created: result.created, errors: result.errors.length },
    });
  }
  return result;
}
