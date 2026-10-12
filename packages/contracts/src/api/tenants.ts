import { z } from 'zod';
import { ContractStatusSchema, PedestrianEscortSchema, TenantStatusSchema } from '../enums';
import { IdSchema, TextSchema } from './common';

// Модуль tenants (ARCHITECTURE §2): арендаторы, договоры и пункты, назначения доков, правила пешеходов.

/** Местная дата `YYYY-MM-DD` (договоры, назначения доков — в датах объекта). */
export const LocalDateSchema = z.iso.date({ error: 'Дата в формате ГГГГ-ММ-ДД' });

const Phone = z.string().trim().min(5).max(30);

export const TenantViewSchema = z.object({
  id: IdSchema,
  siteId: IdSchema,
  legalName: z.string(),
  shortName: z.string(),
  inn: z.string().nullable(),
  isOperator: z.boolean(),
  status: TenantStatusSchema,
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
  status: TenantStatusSchema.optional(),
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

export const ContractViewSchema = z.object({
  id: IdSchema,
  tenantId: IdSchema,
  number: z.string().nullable(),
  signedOn: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  status: ContractStatusSchema,
  notes: z.string().nullable(),
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
  guardText: z.string().trim().max(300).nullable().optional(),
});
export const PedestrianRulePatchSchema = PedestrianRuleCreateSchema.partial();
