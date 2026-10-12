import { parseArgs } from 'node:util';
import { createDb, createPool } from '@oxrana/db';
import { BootstrapError, bootstrapOrganization, issueOwnerLink } from './bootstrap-core';

/**
 * `pnpm bootstrap --org "…" --slug … --timezone … --owner-name "…" --owner-email …` — чистый
 * старт на новой базе (ADR-016, ADR-018). На рабочем сервере: `node dist/bootstrap.js …` в
 * контейнере API. Подключается под владельцем схемы (`DATABASE_ADMIN_URL`). Печатает одноразовую
 * ссылку установки пароля владельца — в терминал, не в журнал.
 */
const USAGE = `Чистый старт: организация и владелец на пустой базе.

  pnpm bootstrap --org "ООО Пример" --slug primer --timezone Asia/Yekaterinburg \\
                 --owner-name "Фамилия Имя" --owner-email owner@example.ru [--owner-phone +79001234567]

Новая ссылка установки пароля для владельца (прежняя истекла):
  pnpm bootstrap --new-owner-link --owner-email owner@example.ru

Переменные: DATABASE_ADMIN_URL (владелец схемы), PUBLIC_URL (адрес веб-кабинета для ссылки).`;

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    slug: { type: 'string' },
    timezone: { type: 'string' },
    'owner-name': { type: 'string' },
    'owner-email': { type: 'string' },
    'owner-phone': { type: 'string' },
    'new-owner-link': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const adminUrl = process.env.DATABASE_ADMIN_URL;
const publicUrl = process.env.PUBLIC_URL;
if (!adminUrl || !publicUrl) {
  console.error(
    'Не заданы DATABASE_ADMIN_URL и/или PUBLIC_URL (адрес веб-кабинета, например https://pass.example.ru).',
  );
  process.exit(1);
}

const pool = createPool({
  connectionString: adminUrl,
  max: 1,
  applicationName: 'oxrana-bootstrap',
});
try {
  const db = createDb(pool);
  if (values['new-owner-link']) {
    const { link, expiresAt } = await issueOwnerLink(
      db,
      { email: values['owner-email'] ?? null, phone: values['owner-phone'] ?? null },
      { publicUrl, now: Date.now() },
    );
    console.log(
      `Новая ссылка установки пароля (одноразовая, до ${expiresAt.toISOString()}):\n\n  ${link}\n`,
    );
  } else {
    const result = await bootstrapOrganization(
      db,
      {
        organizationName: values.org ?? '',
        slug: values.slug ?? '',
        timezone: values.timezone ?? '',
        ownerName: values['owner-name'] ?? '',
        ownerEmail: values['owner-email'] ?? null,
        ownerPhone: values['owner-phone'] ?? null,
      },
      { publicUrl, now: Date.now() },
    );
    console.log(
      [
        'Организация создана, шаблоны ролей добавлены, владелец заведён.',
        '',
        'Передайте владельцу ссылку установки пароля (одноразовая, действует 3 суток,',
        `до ${result.expiresAt.toISOString()}). Ссылка показывается только здесь и нигде не сохраняется:`,
        '',
        `  ${result.link}`,
        '',
        'Дальше владелец входит в веб-кабинет и настраивает объект сам (ADR-016).',
      ].join('\n'),
    );
  }
} catch (error) {
  if (error instanceof BootstrapError) {
    console.error(
      `Чистый старт не выполнен.\n${error.message}${error.usage ? `\n\n${USAGE}` : ''}`,
    );
  } else {
    console.error('Чистый старт не выполнен:', error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
