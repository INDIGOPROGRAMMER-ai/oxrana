import { createHash, randomUUID } from 'node:crypto';
import {
  CONTRACT_FILE_TYPES,
  ContractFileQuerySchema,
  ContractViewSchema,
  IdParamsSchema,
  type StoredFileView,
} from '@oxrana/contracts';
import { schema } from '@oxrana/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ctxOf, type Scope } from '../../core/context';
import { notFound } from '../../core/loaders';
import { AppError } from '../../errors';
import { fileKey } from '../../files/store';
import { contractScope } from './scope';
import { contractView } from './views';

/**
 * Файл договора (Q-63): необязательный, по отдельному праву `contract.file`. Содержимое приходит
 * телом запроса как есть (PDF или изображение), имя — в query. Тип проверяется по началу файла, а
 * не по заголовку, который задаёт клиент.
 */
const SIGNATURES: Record<(typeof CONTRACT_FILE_TYPES)[number], (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const sizeText = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} МБ`;

/** Метаданные файлов по `file_ref` договоров. */
export async function fileViews(
  s: Scope,
  refs: readonly (string | null)[],
): Promise<Map<string, StoredFileView>> {
  const ids = refs.filter((r): r is string => r !== null);
  if (ids.length === 0) return new Map();
  const rows = await s.db
    .select()
    .from(schema.storedFiles)
    .where(
      and(
        eq(schema.storedFiles.organizationId, s.organizationId),
        inArray(schema.storedFiles.id, ids),
        isNull(schema.storedFiles.deletedAt),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        fileName: r.fileName,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
        uploadedAt: r.createdAt.toISOString(),
      },
    ]),
  );
}

async function loadContract(s: Scope, id: string) {
  const [contract] = await s.db
    .select()
    .from(schema.contracts)
    .where(
      and(
        eq(schema.contracts.organizationId, s.organizationId),
        eq(schema.contracts.id, id),
        isNull(schema.contracts.deletedAt),
      ),
    );
  if (!contract) throw notFound('Договор');
  const scope = await contractScope(s, contract.id);
  return { contract, scope };
}

export function registerContractFileRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['contract'];

  typed.put(
    '/contracts/:id/file',
    {
      config: { permission: 'contract.file' },
      schema: {
        tags,
        summary: 'Прикрепить файл договора (PDF или изображение; тело запроса — сам файл)',
        params: IdParamsSchema,
        querystring: ContractFileQuerySchema,
        response: { 200: ContractViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      const body = request.body;
      if (!(CONTRACT_FILE_TYPES as readonly string[]).includes(type) || !Buffer.isBuffer(body)) {
        throw new AppError('validation_failed', {
          field: 'file',
          message: 'Файл договора — PDF, PNG, JPEG или WebP. Другие форматы не принимаются.',
        });
      }
      const contentType = type as (typeof CONTRACT_FILE_TYPES)[number];
      if (body.length === 0 || !SIGNATURES[contentType](body)) {
        throw new AppError('validation_failed', {
          field: 'file',
          message:
            'Содержимое не похоже на выбранный формат: файл пустой или повреждён. Выберите другой файл.',
        });
      }
      if (body.length > ctx.deps.fileMaxBytes) {
        throw new AppError('validation_failed', {
          field: 'file',
          message: `Файл больше ${sizeText(ctx.deps.fileMaxBytes)}. Сожмите его или загрузите меньший.`,
        });
      }
      const { name } = request.query;
      return ctx.tx(async (s) => {
        const { contract, scope } = await loadContract(s, request.params.id);
        const fileId = randomUUID();
        await ctx.deps.files.put(fileKey(s.organizationId, fileId), body);
        await s.db.insert(schema.storedFiles).values({
          id: fileId,
          organizationId: s.organizationId,
          kind: 'contract',
          fileName: name,
          contentType,
          sizeBytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
          createdBy: ctx.actor.kind === 'user' ? ctx.actor.id : null,
        });
        // Прежний файл не удаляется с диска (удаление договора обратимо, Q-72): он только перестаёт быть текущим.
        if (contract.fileRef) {
          await s.db
            .update(schema.storedFiles)
            .set({ deletedAt: new Date(ctx.now()) })
            .where(eq(schema.storedFiles.id, contract.fileRef));
        }
        const [updated = contract] = await s.db
          .update(schema.contracts)
          .set({ fileRef: fileId })
          .where(eq(schema.contracts.id, contract.id))
          .returning();
        await s.audit({
          siteId: scope.siteId,
          entity: 'contract',
          entityId: contract.id,
          action: contract.fileRef ? 'file_replace' : 'file_attach',
          diff: { file: { from: null, to: null, toLabel: `${name} (${body.length} байт)` } },
          snapshot: { fileName: name, sizeBytes: body.length, contentType },
        });
        await s.emit('tenant.changed', {
          siteId: scope.siteId,
          aggregate: 'tenant',
          aggregateId: scope.tenantId ?? contract.tenantId,
          payload: { tenantId: scope.tenantId ?? contract.tenantId, fields: ['contractFile'] },
        });
        return contractView(updated, (await fileViews(s, [fileId])).get(fileId) ?? null, true);
      });
    },
  );

  typed.get(
    '/contracts/:id/file',
    {
      config: { permission: 'contract.file' },
      schema: {
        tags,
        summary: 'Скачать файл договора',
        params: IdParamsSchema,
      },
    },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const found = await ctx.tx(async (s) => {
        const { contract, scope } = await loadContract(s, request.params.id);
        if (!contract.fileRef) return null;
        const [file] = await s.db
          .select()
          .from(schema.storedFiles)
          .where(
            and(
              eq(schema.storedFiles.organizationId, s.organizationId),
              eq(schema.storedFiles.id, contract.fileRef),
              isNull(schema.storedFiles.deletedAt),
            ),
          );
        if (!file) return null;
        // Просмотр конфиденциального файла тоже оставляет след: кто и когда открывал.
        await s.audit({
          siteId: scope.siteId,
          entity: 'contract',
          entityId: contract.id,
          action: 'file_download',
          snapshot: { fileName: file.fileName },
        });
        return file;
      });
      if (!found)
        throw new AppError('not_found', { message: 'У договора нет файла. Обновите страницу.' });
      const stored = await ctx.deps.files.read(fileKey(ctx.organizationId, found.id));
      if (!stored) {
        throw new AppError('not_found', {
          message: 'Файл договора не найден на диске сервера. Загрузите его заново.',
        });
      }
      return reply
        .header('content-type', found.contentType)
        .header('content-length', stored.size)
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(found.fileName)}`,
        )
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(stored.stream);
    },
  );

  typed.delete(
    '/contracts/:id/file',
    {
      config: { permission: 'contract.file' },
      schema: {
        tags,
        summary: 'Открепить файл договора',
        params: IdParamsSchema,
        response: { 200: ContractViewSchema },
      },
    },
    async (request) => {
      const ctx = ctxOf(request);
      return ctx.tx(async (s) => {
        const { contract, scope } = await loadContract(s, request.params.id);
        if (!contract.fileRef) return contractView(contract, null, true);
        await s.db
          .update(schema.storedFiles)
          .set({ deletedAt: new Date(ctx.now()) })
          .where(eq(schema.storedFiles.id, contract.fileRef));
        const [updated = contract] = await s.db
          .update(schema.contracts)
          .set({ fileRef: null })
          .where(eq(schema.contracts.id, contract.id))
          .returning();
        await s.audit({
          siteId: scope.siteId,
          entity: 'contract',
          entityId: contract.id,
          action: 'file_detach',
        });
        return contractView(updated, null, true);
      });
    },
  );
}
