import {
  GATE_ACCOUNT_STATUSES,
  GATE_DEVICE_KINDS,
  NOTIFICATION_CHANNELS,
  PASSWORD_RESET_PURPOSES,
  USER_STATUSES,
} from '@oxrana/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  deletedAt,
  enumCheck,
  id,
  journalId,
  organizationIsolation,
  timestamps,
  tstz,
} from './_helpers';
import { gates, organizationId, organizations, siteId, sites } from './organization';
import { tenants } from './tenants';

// DATA_MODEL §2.8 — люди, роли, учётки КПП.

/** Регистронезависимый текст (e-mail): вход без учёта регистра. */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/**
 * Пользователь — только тот, кто входит в систему (ADR-007). Платформенный: один человек может
 * состоять в нескольких организациях, поэтому без `organization_id` и без RLS.
 */
export const users = pgTable(
  'users',
  {
    id: id(),
    fullName: text('full_name').notNull(),
    email: citext('email').unique(),
    phone: text('phone').unique(),
    /** argon2id; null, пока приглашение не принято. */
    passwordHash: text('password_hash'),
    status: text('status', { enum: USER_STATUSES }).notNull().default('invited'),
    locale: text('locale').notNull().default('ru'),
    lastLoginAt: tstz('last_login_at'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    /** «Показывать ещё и моё время» мелкой второй строкой (ADR-009, дополнение). */
    showOwnTime: boolean('show_own_time').notNull().default(false),
    /** Свой пояс пользователя (IANA), выбирается из списка; пояс браузера не читается. */
    ownTimezone: text('own_timezone'),
    /** Согласие на обработку ПДн при принятии приглашения (152-ФЗ). */
    consentAt: tstz('consent_at'),
    ...timestamps(),
  },
  (t) => [
    check('users_contact_check', sql`${t.email} is not null or ${t.phone} is not null`),
    check('users_own_time_check', sql`not ${t.showOwnTime} or ${t.ownTimezone} is not null`),
    enumCheck('users', t.status, USER_STATUSES),
  ],
);

/** Роль — набор прав внутри организации; новая роль пуста (ADR-007). */
export const roles = pgTable(
  'roles',
  {
    id: id(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    /** Коды из packages/contracts/src/permissions.ts; проверяются zod на записи. */
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    isTemplate: boolean('is_template').notNull().default(false),
    /** Код шаблона (ROLE_TEMPLATES): по нему находится «Пост КПП» для новой учётки КПП. */
    templateCode: text('template_code'),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    unique('roles_template_code_key').on(t.organizationId, t.templateCode),
    organizationIsolation(),
  ],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: id(),
    organizationId: organizationId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    /** null — вся организация. */
    siteId: uuid('site_id').references(() => sites.id),
    /** Для пользователей арендатора. */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('role_assignments_scope_key')
      .on(t.userId, t.roleId, t.siteId, t.tenantId)
      .nullsNotDistinct(),
    organizationIsolation(),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: organizationId(),
    email: citext('email'),
    phone: text('phone'),
    fullName: text('full_name'),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    siteId: uuid('site_id').references(() => sites.id),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    acceptedAt: tstz('accepted_at'),
    acceptedUserId: uuid('accepted_user_id').references(() => users.id),
    /** Отозвано администратором или заменено повторной отправкой. */
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  () => [organizationIsolation()],
);

/** Cookie-сессии пользователей (opaque id, в БД — хэш). */
export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  lastSeenAt: tstz('last_seen_at'),
  expiresAt: tstz('expires_at').notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  revokedAt: tstz('revoked_at'),
  /** Текущая организация сессии: у пользователя их может быть несколько. */
  organizationId: uuid('organization_id').references(() => organizations.id),
});

/**
 * Одноразовые ссылки установки пароля (ADR-018): владелец при чистом старте (`setup`),
 * восстановление и сброс администратором (`reset`). В БД — SHA-256 токена.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    purpose: text('purpose', { enum: PASSWORD_RESET_PURPOSES }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    /** Администратор, выдавший ссылку; null — сам пользователь или чистый старт. */
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
    createdAt: createdAt(),
  },
  (t) => [enumCheck('password_resets', t.purpose, PASSWORD_RESET_PURPOSES)],
);

/**
 * Журнал входа платформы (ADR-018): вход, неудачные попытки, выход, коды и ссылки. Без RLS — у
 * неизвестного логина нет организации; логин хранится только хэшем. Источник ограничения попыток.
 */
export const authEvents = pgTable(
  'auth_events',
  {
    id: journalId(),
    at: tstz('at').notNull().defaultNow(),
    kind: text('kind').notNull(),
    userId: uuid('user_id').references(() => users.id),
    /** SHA-256 нормализованного логина. */
    loginHash: text('login_hash'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
  },
  (t) => [
    index('auth_events_login_hash_at_idx').on(t.loginHash, t.at),
    index('auth_events_ip_at_idx').on(t.ip, t.at),
  ],
);

/** Вход по коду из SMS/e-mail. */
export const loginCodes = pgTable('login_codes', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  codeHash: text('code_hash').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: tstz('used_at'),
  createdAt: createdAt(),
});

/** A11: одна учётка на КПП, без личных PIN. */
export const gateAccounts = pgTable(
  'gate_accounts',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: siteId(),
    gateId: uuid('gate_id')
      .notNull()
      .unique()
      .references(() => gates.id),
    /** Шаблон «Пост КПП». */
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    status: text('status', { enum: GATE_ACCOUNT_STATUSES }).notNull().default('active'),
    ...timestamps(),
  },
  (t) => [enumCheck('gate_accounts', t.status, GATE_ACCOUNT_STATUSES), organizationIsolation()],
);

export const gateDevices = pgTable(
  'gate_devices',
  {
    id: id(),
    organizationId: organizationId(),
    gateAccountId: uuid('gate_account_id')
      .notNull()
      .references(() => gateAccounts.id),
    /** «ПК поста», «планшет». */
    name: text('name').notNull(),
    /** agent — агент КПП (раздел D). */
    kind: text('kind', { enum: GATE_DEVICE_KINDS }).notNull().default('post'),
    /** Долгоживущий токен показывается один раз; в БД — хэш. */
    tokenHash: text('token_hash').notNull().unique(),
    enrolledBy: uuid('enrolled_by').references(() => users.id),
    enrolledAt: tstz('enrolled_at').notNull(),
    lastSeenAt: tstz('last_seen_at'),
    lastIp: inet('last_ip'),
    appVersion: text('app_version'),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
    ...timestamps(),
  },
  (t) => [enumCheck('gate_devices', t.kind, GATE_DEVICE_KINDS), organizationIsolation()],
);

/** Одноразовый код/QR привязки устройства (10 мин). */
export const deviceEnrollments = pgTable(
  'device_enrollments',
  {
    id: id(),
    organizationId: organizationId(),
    gateAccountId: uuid('gate_account_id')
      .notNull()
      .references(() => gateAccounts.id),
    /** Какое устройство будет привязано: экран поста или агент КПП. */
    kind: text('kind', { enum: GATE_DEVICE_KINDS }).notNull(),
    codeHash: text('code_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    usedDeviceId: uuid('used_device_id').references((): AnyPgColumn => gateDevices.id),
    /** Кто выдал код в админке. */
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [enumCheck('device_enrollments', t.kind, GATE_DEVICE_KINDS), organizationIsolation()],
);

/** Необязательная «отметка смены» (настройка объекта shiftMarkEnabled). */
export const shiftMarks = pgTable(
  'shift_marks',
  {
    id: id(),
    organizationId: organizationId(),
    gateAccountId: uuid('gate_account_id')
      .notNull()
      .references(() => gateAccounts.id),
    deviceId: uuid('device_id').references(() => gateDevices.id),
    guardName: text('guard_name').notNull(),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
  },
  () => [organizationIsolation()],
);

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  endpoint: text('endpoint').notNull().unique(),
  keys: jsonb('keys').notNull(),
  createdAt: createdAt(),
  failedAt: tstz('failed_at'),
});

/** Ключ — (пользователь, арендатор или «все», вид, канал); null арендатора — одно значение. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    kind: text('kind').notNull(),
    channel: text('channel', { enum: NOTIFICATION_CHANNELS }).notNull(),
    enabled: boolean('enabled').notNull(),
  },
  (t) => [
    unique('notification_preferences_key')
      .on(t.userId, t.tenantId, t.kind, t.channel)
      .nullsNotDistinct(),
    enumCheck('notification_preferences', t.channel, NOTIFICATION_CHANNELS),
  ],
);

export const telegramLinks = pgTable('telegram_links', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  chatId: bigint('chat_id', { mode: 'number' }).notNull().unique(),
  linkedAt: tstz('linked_at'),
});
