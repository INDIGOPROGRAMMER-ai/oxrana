import type { StoredFileView } from '@oxrana/contracts';
import type { schema } from '@oxrana/db';

export type TenantRowFull = typeof schema.tenants.$inferSelect;

/** Представление арендатора для API (список, карточка, блокировка). */
export function tenantView(r: TenantRowFull) {
  return {
    id: r.id,
    siteId: r.siteId,
    legalName: r.legalName,
    shortName: r.shortName,
    inn: r.inn,
    isOperator: r.isOperator,
    status: r.status,
    statusReason: r.statusReason,
    statusChangedAt: r.statusChangedAt?.toISOString() ?? null,
    trucksDockRequired: r.trucksDockRequired,
    defaultCategoryId: r.defaultCategoryId,
    responsiblePhone: r.responsiblePhone,
    emergencyPhone: r.emergencyPhone,
    color: r.color,
  };
}

type ContractRow = typeof schema.contracts.$inferSelect;

/**
 * Представление договора. Файл показывается только тому, у кого есть право `contract.file`
 * (`canViewFile`); остальные видят, что файл есть/нет, не узнавая имени.
 */
export function contractView(r: ContractRow, file: StoredFileView | null, canViewFile: boolean) {
  return {
    id: r.id,
    tenantId: r.tenantId,
    number: r.number,
    signedOn: r.signedOn,
    validFrom: r.validFrom,
    validTo: r.validTo,
    status: r.status,
    notes: r.notes,
    file: canViewFile ? file : null,
    canViewFile,
  };
}
