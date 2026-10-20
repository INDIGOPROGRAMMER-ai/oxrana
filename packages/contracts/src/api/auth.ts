import { z } from 'zod';
import { GateDeviceKindSchema, PasswordResetPurposeSchema, UserStatusSchema } from '../enums';
import { PERMISSIONS } from '../permissions';
import { IdSchema, InstantSchema, ReasonSchema, TextSchema } from './common';

// Модули auth, users, devices (ADR-007, ADR-018): вход, сессии, приглашения, коды входа,
// восстановление пароля, роли и назначения, учётки КПП и привязка устройств.

/** Логин — e-mail или телефон; сравнение без учёта регистра, телефон — только цифры. */
export const LoginSchema = z.string().trim().min(3, 'Укажите e-mail или телефон').max(200);

/**
 * Пароль: не короче 10 символов и не только цифры (ADR-018). Длинный — до 200 символов:
 * argon2id считает хэш от всего пароля.
 */
export const PasswordSchema = z.string().min(1, 'Укажите пароль').max(200);

/** Одноразовый токен ссылки (приглашение, установка пароля): 32 байта base64url. */
export const LinkTokenSchema = z.string().trim().min(20).max(100);

export const LoginRequestSchema = z.strictObject({ login: LoginSchema, password: PasswordSchema });
export const LoginCodeRequestSchema = z.strictObject({ login: LoginSchema });
export const LoginCodeVerifySchema = z.strictObject({
  login: LoginSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Код — 6 цифр'),
});
export const PasswordForgotSchema = z.strictObject({ login: LoginSchema });
export const LinkInspectSchema = z.strictObject({ token: LinkTokenSchema });
export const PasswordResetSchema = z.strictObject({
  token: LinkTokenSchema,
  password: PasswordSchema,
});
export const PasswordChangeSchema = z.strictObject({
  currentPassword: PasswordSchema,
  newPassword: PasswordSchema,
});
export const InvitationAcceptSchema = z.strictObject({
  token: LinkTokenSchema,
  fullName: TextSchema(200).optional(),
  password: PasswordSchema,
  /** Согласие на обработку персональных данных (152-ФЗ): без него приглашение не принимается. */
  consent: z.literal(true, { error: 'Подтвердите согласие на обработку персональных данных' }),
});
export const SwitchOrganizationSchema = z.strictObject({ organizationId: IdSchema });

/** «Если такой пользователь есть, мы отправили…» — ответ не подсказывает, существует ли логин. */
export const AcceptedSchema = z.object({ message: z.string() });

export const AssignmentViewSchema = z.object({
  id: IdSchema,
  roleId: IdSchema,
  roleName: z.string(),
  siteId: IdSchema.nullable(),
  siteName: z.string().nullable(),
  tenantId: IdSchema.nullable(),
  tenantName: z.string().nullable(),
});
export type AssignmentView = z.infer<typeof AssignmentViewSchema>;

/** Кто вошёл: пользователь или устройство поста (учётка КПП). */
export const MeSchema = z.object({
  kind: z.enum(['user', 'gate_account']),
  id: IdSchema,
  organization: z.object({ id: IdSchema, name: z.string() }),
  /** Другие организации пользователя — для переключателя. */
  organizations: z.array(z.object({ id: IdSchema, name: z.string() })),
  permissions: z.array(z.string()),
  user: z
    .object({
      fullName: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      mustChangePassword: z.boolean(),
      assignments: z.array(AssignmentViewSchema),
    })
    .nullable(),
  gate: z
    .object({
      id: IdSchema,
      name: z.string(),
      siteId: IdSchema,
      siteName: z.string(),
      deviceId: IdSchema,
      deviceName: z.string(),
    })
    .nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const SessionViewSchema = z.object({
  id: IdSchema,
  createdAt: InstantSchema,
  lastSeenAt: InstantSchema.nullable(),
  expiresAt: InstantSchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});

export const LinkInfoSchema = z.object({
  purpose: PasswordResetPurposeSchema,
  fullName: z.string(),
  expiresAt: InstantSchema,
});

export const InvitationInfoSchema = z.object({
  organizationName: z.string(),
  roleName: z.string(),
  siteName: z.string().nullable(),
  tenantName: z.string().nullable(),
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  expiresAt: InstantSchema,
  /** У человека уже есть учётная запись: принять приглашение — своим паролем. */
  existingAccount: z.boolean(),
});

// --- пользователи, приглашения, роли (админка) ---

export const UserViewSchema = z.object({
  id: IdSchema,
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: UserStatusSchema,
  lastLoginAt: InstantSchema.nullable(),
  assignments: z.array(AssignmentViewSchema),
});

export const UserListQuerySchema = z.strictObject({ tenantId: IdSchema.optional() });

export const AssignmentInputSchema = z.strictObject({
  roleId: IdSchema,
  siteId: IdSchema.nullable().optional(),
  tenantId: IdSchema.nullable().optional(),
});

const EmailSchema = z.email('Укажите e-mail в виде name@example.ru').max(200);
const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[\d\s()-]{10,20}$/, 'Укажите телефон, например +7 900 123-45-67');

export const InvitationCreateSchema = z
  .strictObject({
    email: EmailSchema.optional(),
    phone: PhoneSchema.optional(),
    fullName: TextSchema(200).optional(),
    roleId: IdSchema,
    siteId: IdSchema.nullable().optional(),
    tenantId: IdSchema.nullable().optional(),
  })
  .refine((v) => v.email !== undefined || v.phone !== undefined, {
    message: 'Укажите e-mail или телефон приглашённого',
    path: ['email'],
  });

export const InvitationViewSchema = z.object({
  id: IdSchema,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  fullName: z.string().nullable(),
  roleId: IdSchema,
  roleName: z.string(),
  siteId: IdSchema.nullable(),
  tenantId: IdSchema.nullable(),
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']),
  expiresAt: InstantSchema,
  createdAt: InstantSchema,
});

/**
 * Приглашение с ссылкой. Ссылка показывается один раз тому, кто пригласил (в БД — хэш): пока нет
 * доставки по e-mail и SMS (этап уведомлений), её передают человеку сами.
 */
export const InvitationCreatedSchema = z.object({
  invitation: InvitationViewSchema,
  link: z.string(),
});

export const InvitationListQuerySchema = z.strictObject({
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']).optional(),
});

export const OneTimeLinkSchema = z.object({ link: z.string(), expiresAt: InstantSchema });

export const RoleViewSchema = z.object({
  id: IdSchema,
  name: z.string(),
  permissions: z.array(z.string()),
  isTemplate: z.boolean(),
  templateCode: z.string().nullable(),
  /** Роль области «КПП»: права вроде «История пропуска» ей не выдаются (ADR-007). */
  forGate: z.boolean(),
});

const PermissionCodeSchema = z.enum(PERMISSIONS);
export const RoleCreateSchema = z.strictObject({
  name: TextSchema(100),
  /** Новая роль по умолчанию пуста (ADR-007). */
  permissions: z.array(PermissionCodeSchema).default([]),
});
export const RolePatchSchema = z.strictObject({
  name: TextSchema(100).optional(),
  permissions: z.array(PermissionCodeSchema).optional(),
});

export const PermissionViewSchema = z.object({ code: z.string(), label: z.string() });

export const DisableUserSchema = z.strictObject({ reason: ReasonSchema });

// --- учётки КПП и устройства ---

export const GateDeviceViewSchema = z.object({
  id: IdSchema,
  name: z.string(),
  kind: GateDeviceKindSchema,
  enrolledAt: InstantSchema,
  lastSeenAt: InstantSchema.nullable(),
  appVersion: z.string().nullable(),
  revokedAt: InstantSchema.nullable(),
  revokeReason: z.string().nullable(),
});

export const GateAccountViewSchema = z.object({
  id: IdSchema,
  gateId: IdSchema,
  gateName: z.string(),
  status: z.enum(['active', 'disabled']),
  roleName: z.string(),
  devices: z.array(GateDeviceViewSchema),
});

export const EnrollmentCreateSchema = z.strictObject({
  kind: GateDeviceKindSchema.default('post'),
});

/** Код привязки: показывается один раз (в БД — хэш), действует 10 минут, одноразовый. */
export const EnrollmentCreatedSchema = z.object({
  id: IdSchema,
  code: z.string(),
  /** Адрес для QR: открывает экран привязки поста с уже введённым кодом. */
  enrollUrl: z.string(),
  expiresAt: InstantSchema,
});

export const DeviceEnrollSchema = z.strictObject({
  code: z.string().trim().min(4).max(20),
  name: TextSchema(100),
  appVersion: z.string().trim().max(50).optional(),
});

/** Токен устройства показывается один раз; устройство хранит его у себя (IndexedDB). */
export const DeviceEnrolledSchema = z.object({
  token: z.string(),
  device: z.object({ id: IdSchema, name: z.string(), kind: GateDeviceKindSchema }),
  gate: z.object({ id: IdSchema, name: z.string() }),
  site: z.object({ id: IdSchema, name: z.string(), timezone: z.string() }),
});

export const RevokeDeviceSchema = z.strictObject({ reason: ReasonSchema });
