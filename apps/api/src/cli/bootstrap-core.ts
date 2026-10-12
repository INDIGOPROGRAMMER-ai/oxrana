import { isValidTimezone, ROLE_TEMPLATES } from '@oxrana/contracts';
import { type Db, schema } from '@oxrana/db';
import { and, count, eq, isNull } from 'drizzle-orm';
import { randomToken, sha256Hex } from '../auth/crypto';
import { normalizeEmail, normalizePhone } from '../auth/login';

/**
 * «Чистый старт» (ADR-016, ADR-018): на пустой базе создаются организация (название, slug, пояс
 * по умолчанию), шаблоны ролей и учётная запись владельца с ролью «Владелец организации» на всю
 * организацию. Больше ничего: объект, КПП, арендаторов заказчик заводит сам через интерфейс.
 * Пароль владельца не задаётся здесь и не проходит через журналы и командную строку: выдаётся
 * одноразовая ссылка установки пароля.
 */
export interface BootstrapInput {
  readonly organizationName: string;
  readonly slug: string;
  readonly timezone: string;
  readonly ownerName: string;
  readonly ownerEmail: string | null;
  readonly ownerPhone: string | null;
}

export interface BootstrapResult {
  readonly organizationId: string;
  readonly ownerId: string;
  readonly link: string;
  readonly expiresAt: Date;
}

/** Ссылка установки пароля владельца действует 3 суток. */
export const OWNER_LINK_TTL_MS = 3 * 86_400_000;

export class BootstrapError extends Error {
  /** Ошибка в параметрах команды: показать подсказку по запуску. */
  readonly usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.name = 'BootstrapError';
    this.usage = usage;
  }
}

function validate(input: BootstrapInput): string[] {
  const problems: string[] = [];
  if (input.organizationName.trim().length < 2) problems.push('--org: название организации');
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(input.slug)) {
    problems.push(
      '--slug: латиница в нижнем регистре, цифры и дефис, 3–50 символов (для адресов и журналов)',
    );
  }
  if (!isValidTimezone(input.timezone)) {
    problems.push(
      `--timezone: неизвестный часовой пояс «${input.timezone}», например Asia/Yekaterinburg`,
    );
  }
  if (input.ownerName.trim().length < 2) problems.push('--owner-name: фамилия и имя владельца');
  if (!input.ownerEmail && !input.ownerPhone) {
    problems.push('--owner-email или --owner-phone: логин владельца');
  }
  if (input.ownerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.ownerEmail)) {
    problems.push('--owner-email: e-mail в виде name@example.ru');
  }
  if (input.ownerPhone && normalizePhone(input.ownerPhone).length < 12) {
    problems.push('--owner-phone: телефон, например +7 900 123-45-67');
  }
  return problems;
}

function passwordLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/$/, '')}/password#${token}`;
}

/** Под владельцем схемы (RLS не мешает): база должна быть пустой — без организаций и пользователей. */
export async function bootstrapOrganization(
  db: Db,
  input: BootstrapInput,
  options: { publicUrl: string; now: number },
): Promise<BootstrapResult> {
  const problems = validate(input);
  if (problems.length > 0) {
    throw new BootstrapError(
      `Не хватает или неверны параметры:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      true,
    );
  }
  return db.transaction(async (tx) => {
    const [orgs] = await tx.select({ n: count() }).from(schema.organizations);
    const [users] = await tx.select({ n: count() }).from(schema.users);
    if ((orgs?.n ?? 0) > 0 || (users?.n ?? 0) > 0) {
      throw new BootstrapError(
        `База не пустая: организаций — ${orgs?.n ?? 0}, пользователей — ${users?.n ?? 0}. ` +
          'Чистый старт выполняется один раз, на новой базе, и ничего не дописывает в существующую. ' +
          'Новых людей приглашают из интерфейса (Пользователи → Пригласить); если владелец не успел ' +
          'задать пароль — выдайте новую ссылку: bootstrap --new-owner-link --owner-email …',
      );
    }
    const now = new Date(options.now);
    const [org] = await tx
      .insert(schema.organizations)
      .values({
        name: input.organizationName.trim(),
        slug: input.slug,
        defaultTimezone: input.timezone,
      })
      .returning();
    if (!org) throw new Error('organization insert');
    const roles = await tx
      .insert(schema.roles)
      .values(
        ROLE_TEMPLATES.map((r) => ({
          organizationId: org.id,
          name: r.name,
          permissions: [...r.permissions],
          isTemplate: true,
          templateCode: r.code,
        })),
      )
      .returning();
    const ownerRole = roles.find((r) => r.templateCode === 'org_owner');
    if (!ownerRole) throw new Error('owner role');
    const [owner] = await tx
      .insert(schema.users)
      .values({
        fullName: input.ownerName.trim(),
        email: input.ownerEmail ? normalizeEmail(input.ownerEmail) : null,
        phone: input.ownerPhone ? normalizePhone(input.ownerPhone) : null,
        status: 'active',
      })
      .returning();
    if (!owner) throw new Error('owner insert');
    await tx.insert(schema.roleAssignments).values({
      organizationId: org.id,
      userId: owner.id,
      roleId: ownerRole.id,
    });
    const token = randomToken();
    const expiresAt = new Date(options.now + OWNER_LINK_TTL_MS);
    await tx.insert(schema.passwordResets).values({
      userId: owner.id,
      purpose: 'setup',
      tokenHash: sha256Hex(token),
      expiresAt,
    });
    await tx.insert(schema.auditLog).values({
      organizationId: org.id,
      at: now,
      actorType: 'system',
      entity: 'organization',
      entityId: org.id,
      action: 'bootstrap',
      snapshot: {
        organization: org.name,
        slug: org.slug,
        defaultTimezone: org.defaultTimezone,
        roles: roles.map((r) => r.name),
        ownerId: owner.id,
      },
    });
    return {
      organizationId: org.id,
      ownerId: owner.id,
      link: passwordLink(options.publicUrl, token),
      expiresAt,
    };
  });
}

/**
 * Новая ссылка установки пароля для владельца организации — когда прежняя истекла или потеряна.
 * Только для пользователя с назначением роли, управляющей ролями, на всю организацию.
 */
export async function issueOwnerLink(
  db: Db,
  login: { email: string | null; phone: string | null },
  options: { publicUrl: string; now: number },
): Promise<{ link: string; expiresAt: Date }> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(
      login.email
        ? eq(schema.users.email, normalizeEmail(login.email))
        : eq(schema.users.phone, normalizePhone(login.phone ?? '')),
    );
  if (!user) throw new BootstrapError('Пользователь с таким логином не найден.');
  const owners = await db
    .select({ permissions: schema.roles.permissions })
    .from(schema.roleAssignments)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
    .where(
      and(
        eq(schema.roleAssignments.userId, user.id),
        isNull(schema.roleAssignments.siteId),
        isNull(schema.roleAssignments.tenantId),
        isNull(schema.roles.deletedAt),
      ),
    );
  if (!owners.some((o) => o.permissions.includes('role.manage'))) {
    throw new BootstrapError(
      'Это не владелец организации. Остальным пользователям ссылку выдаёт администратор в интерфейсе.',
    );
  }
  const token = randomToken();
  const expiresAt = new Date(options.now + OWNER_LINK_TTL_MS);
  await db.insert(schema.passwordResets).values({
    userId: user.id,
    purpose: user.passwordHash ? 'reset' : 'setup',
    tokenHash: sha256Hex(token),
    expiresAt,
  });
  return { link: passwordLink(options.publicUrl, token), expiresAt };
}
