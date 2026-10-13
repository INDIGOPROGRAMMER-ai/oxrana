import { STORED_FILE_KINDS } from '@oxrana/contracts';
import { bigint, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, enumCheck, id, organizationIsolation } from './_helpers';
import { organizationId } from './organization';
import { users } from './people';

// DATA_MODEL §10 — метаданные файлов; сам файл лежит в FileStore по ключу `<organization_id>/<id>`.

export const storedFiles = pgTable(
  'stored_files',
  {
    id: id(),
    organizationId: organizationId(),
    /** Для чего файл: от вида зависит, кто его видит (право `contract.file` для договоров). */
    kind: text('kind', { enum: STORED_FILE_KINDS }).notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    enumCheck('stored_files', t.kind, STORED_FILE_KINDS),
    index('stored_files_organization_id_idx').on(t.organizationId, t.kind),
    organizationIsolation(),
  ],
);
