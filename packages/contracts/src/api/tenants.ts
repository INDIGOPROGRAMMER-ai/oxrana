import { z } from 'zod';
import { ContractStatusSchema, PedestrianEscortSchema, TenantStatusSchema } from '../enums';
import { IdSchema, ReasonSchema, TextSchema } from './common';

// Модуль tenants (ARCHITECTURE §2): арендаторы, договоры и пункты, назначения доков, правила пешеходов.

/** Местная дата `YYYY-MM-DD` (договоры, назначения доков — в датах объекта). */
export const LocalDateSchema = z.iso.date({ error: 'Дата в формате ГГГГ-ММ-ДД' });

const Phone = z
  .string()
  .trim()
  .min(5, 'Телефон — не короче 5 символов')
  .max(30, 'Телефон — не длиннее 30 символов');

export const TenantViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  legalName: z.string(),
  shortName: z.string(),
  inn: z.string().nullable(),
  isOperator: z.boolean(),
  status: TenantStatusSchema,
  /** Почему арендатор заблокирован и когда статус менялся; `null` — не менялся. */
  statusReason: z.string().nullable(),
  statusChangedAt: z.string().nullable(),
  trucksDockRequired: z.boolean(),
  defaultCategoryId: IdSchema.nullable(),
  responsiblePhone: z.string().nullable(),
  emergencyPhone: z.string().nullable(),
  color: z.string().nullable(),
});
export const TenantCreateSchema = z.strictObject({
  legalName: TextSchema(300),
  shortName: TextSchema(100),
  inn: z
    .string()
    .trim()
    .regex(/^\d{10}(\d{2})?$/, 'ИНН — 10 или 12 цифр')
    .nullable()
    .optional(),
  isOperator: z.boolean().optional(),
  trucksDockRequired: z.boolean().optional(),
  defaultCategoryId: IdSchema.nullable().optional(),
  responsiblePhone: Phone.nullable().optional(),
  emergencyPhone: Phone.nullable().optional(),
  color: z.string().trim().max(20).nullable().optional(),
});
export const TenantPatchSchema = TenantCreateSchema.partial();
/** Пакетное добавление арендаторов (вставка из Excel); строки независимы. */
export const TenantBatchSchema = z.strictObject({
  items: z.array(TenantCreateSchema).min(1, 'Добавьте хотя бы одного арендатора').max(500),
  dryRun: z.boolean().optional(),
});

/** Файл договора: показывается только тому, у кого есть право `contract.file`. */
export const StoredFileViewSchema = z.object({
  id: IdSchema,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.int(),
  uploadedAt: z.string(),
});
export type StoredFileView = z.infer<typeof StoredFileViewSchema>;
/** Допустимые типы файла договора: PDF и изображения (Q-63). */
export const contractFileTypes = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export const ContractFileQuerySchema = z.strictObject({
  /** Имя файла, как оно было на компьютере (в теле — только содержимое). */
  name: z.string().trim().min(1, 'Укажите имя файла').max(200),
});

export const ContractViewSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  number: z.string().nullable(),
  signedOn: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  status: ContractStatusSchema,
  notes: z.string().nullable(),
  /** `null` — файла нет или нет права его видеть (`canViewFile`). */
  file: StoredFileViewSchema.nullable(),
  canViewFile: z.boolean(),
});
export const ContractCreateSchema = z.strictObject({
  number: z.string().trim().max(100).nullable().optional(),
  signedOn: LocalDateSchema.nullable().optional(),
  validFrom: LocalDateSchema.nullable().optional(),
  validTo: LocalDateSchema.nullable().optional(),
  status: ContractStatusSchema.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export const ContractPatchSchema = ContractCreateSchema.partial();

export const ClauseViewSchema = z.object({
  id: IdSchema,
  contractId: IdSchema,
  ref: z.string(),
  summary: z.string(),
});
export const ClauseCreateSchema = z.strictObject({
  ref: TextSchema(50),
  summary: TextSchema(1000),
});
export const ClausePatchSchema = ClauseCreateSchema.partial();

export const DockAssignmentViewSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  dockId: IdSchema,
  validFrom: z.string(),
  validTo: z.string().nullable(),
  basisClauseId: IdSchema.nullable(),
});
export const DockAssignmentCreateSchema = z.strictObject({
  dockId: IdSchema,
  validFrom: LocalDateSchema,
  validTo: LocalDateSchema.nullable().optional(),
  basisClauseId: IdSchema.nullable().optional(),
});
/** Назначение нескольких доков арендатору одним действием («доки 1–10»). */
export const DockAssignmentBatchSchema = z.strictObject({
  dockIds: z.array(IdSchema).min(1, 'Выберите хотя бы один док').max(1000),
  validFrom: LocalDateSchema,
  validTo: LocalDateSchema.nullable().optional(),
  basisClauseId: IdSchema.nullable().optional(),
  dryRun: z.boolean().optional(),
});
export const DockAssignmentPatchSchema = z.strictObject({
  validFrom: LocalDateSchema.optional(),
  validTo: LocalDateSchema.nullable().optional(),
  basisClauseId: IdSchema.nullable().optional(),
});

/** Режимы блокировки арендатора (Q-73); выезд разрешён всегда. */
export const TENANT_BLOCK_MODES = ['new_passes', 'entry', 'full'] as const;
export const TenantBlockModeSchema = z.enum(TENANT_BLOCK_MODES);
export type TenantBlockMode = (typeof TENANT_BLOCK_MODES)[number];
export const TENANT_BLOCK_MODE_LABEL: Record<TenantBlockMode, string> = {
  new_passes: 'Запретить новые пропуска',
  entry: 'Запретить въезд',
  full: 'Полная блокировка',
};
export const TENANT_BLOCK_MODE_HELP: Record<TenantBlockMode, string> = {
  new_passes: 'Новые пропуска не оформляются; уже выданные работают.',
  entry: 'Машины и люди арендатора не въезжают; пропуска оформлять можно.',
  full: 'Нельзя ни оформлять пропуска, ни въезжать.',
};

export const TenantBlockImpactQuerySchema = z.strictObject({ mode: TenantBlockModeSchema });
/** Последствия блокировки — показываются перед подтверждением. */
export const TenantBlockImpactSchema = z.object({
  mode: TenantBlockModeSchema,
  /** Сейчас на территории (открытые визиты арендатора): они смогут выехать. */
  insideNow: z.int(),
  vehiclesInside: z.int(),
  pedestriansInside: z.int(),
  /** Действующие пропуска (согласованы, срок не истёк), которые перестанут работать. */
  willStopWorking: z.int(),
  /** Готовая фраза: «Сейчас внутри 3 машины, они смогут выехать; 12 действующих пропусков перестанут работать». */
  summary: z.string(),
});
export const TenantBlockSchema = z.strictObject({
  mode: TenantBlockModeSchema,
  reason: ReasonSchema,
  /** Без подтверждения сервер отвечает `confirmation_required` с последствиями. */
  confirm: z.boolean().optional(),
});
export const TenantUnblockSchema = z.strictObject({ reason: ReasonSchema });

/** Закрепление мест на парковочном участке за арендатором (в карточке арендатора). */
export const ParkingAssignmentViewSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  parkingAreaId: IdSchema,
  spaces: z.int(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  basisClauseId: IdSchema.nullable(),
});
export const ParkingAssignmentCreateSchema = z.strictObject({
  parkingAreaId: IdSchema,
  spaces: z.int().min(1, 'Мест — хотя бы одно').max(100000),
  validFrom: LocalDateSchema,
  validTo: LocalDateSchema.nullable().optional(),
  basisClauseId: IdSchema.nullable().optional(),
});
export const ParkingAssignmentPatchSchema = z.strictObject({
  spaces: z.int().min(1, 'Мест — хотя бы одно').max(100000).optional(),
  validFrom: LocalDateSchema.optional(),
  validTo: LocalDateSchema.nullable().optional(),
  basisClauseId: IdSchema.nullable().optional(),
});

export const PedestrianRuleViewSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  zoneId: IdSchema.nullable(),
  documentRequired: z.boolean(),
  escort: PedestrianEscortSchema,
  escortPhone: z.string().nullable(),
  guardText: z.string().nullable(),
});
export const PedestrianRuleCreateSchema = z.strictObject({
  zoneId: IdSchema.nullable().optional(),
  documentRequired: z.boolean().optional(),
  escort: PedestrianEscortSchema,
  escortPhone: Phone.nullable().optional(),
  guardText: z
    .string()
    .trim()
    .max(300, 'Текст для охраны — не длиннее 300 символов')
    .nullable()
    .optional(),
});
export const PedestrianRulePatchSchema = PedestrianRuleCreateSchema.partial();
