import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { buildXlsx } from '../packages/ui/src/batch/spreadsheet';
import { E2E_DATABASE_ADMIN_URL, WEB_URL } from '../playwright.config';

/**
 * Этап 7b.3: карточка пропуска и полная история (кабинет и админка), время строки пакета с датой и
 * числом Excel. Продолжает базу после `batch-admin.spec.ts`: организация «Пример», объект
 * «Склад № 1», арендатор «Альфа» (логист Белова Мария, роль «Арендатор — ответственный»),
 * администратор объекта. Все данные выдуманные.
 */
test.describe.configure({ mode: 'serial', retries: 0 });

const ADMIN = { email: 'admin@example.test', password: 'Пароль-админа-2026' };
const LOGIST = { email: 'logist@example.test', password: 'Пароль-логиста-2026' };
const HOUR = 3_600_000;
const SITE_TZ = 'Asia/Yekaterinburg';

async function loginAs(
  browser: Browser,
  who: { email: string; password: string },
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport, hasTouch: true } : {});
  const page = await context.newPage();
  await page.goto(`${WEB_URL}/login`);
  await page.getByLabel('E-mail или телефон').fill(who.email);
  await page.getByLabel('Пароль').fill(who.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Выйти' }).first()).toBeVisible();
  return { page, context };
}

interface Json {
  id: string;
  items: {
    id: string;
    name: string;
    shortName: string;
    templateCode?: string;
    permissions: string[];
  }[];
  user?: { assignments: { tenantId: string }[] };
  site?: { singleMaxHours: number };
}

async function api(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown) {
  const res = await page.request.fetch(`${WEB_URL}/api${path}`, {
    method,
    headers: { origin: WEB_URL },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json().catch(() => ({}))) as Json;
}

function sql(statement: string): void {
  execFileSync('psql', [E2E_DATABASE_ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], {
    stdio: 'pipe',
  });
}

function sqlValue(statement: string): string {
  return execFileSync(
    'psql',
    [E2E_DATABASE_ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', statement],
    { encoding: 'utf8' },
  ).trim();
}

/** Время объекта «ДД.ММ.ГГГГ ЧЧ:ММ» — как его показывает карточка. */
function siteStamp(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SITE_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

/** Сутки объекта со сдвигом: `ДД.ММ.ГГГГ`, `ДД.ММ` и число Excel — номер дня. */
function siteDay(shiftDays: number) {
  const full = siteStamp(Date.now() + shiftDays * 24 * HOUR).slice(0, 10);
  const [d = '', m = '', y = ''] = full.split('.');
  const serial =
    (Date.UTC(Number(y), Number(m) - 1, Number(d)) - Date.UTC(1899, 11, 30)) / (24 * HOUR);
  return {
    ru: full,
    short: `${d}.${m}`,
    serial,
    /** Начало суток объекта (UTC+5, без перехода на летнее время), мс. */
    startMs: Date.UTC(Number(y), Number(m) - 1, Number(d)) - 5 * HOUR,
  };
}

let admin: Awaited<ReturnType<typeof loginAs>>;
let logist: Awaited<ReturnType<typeof loginAs>>;
let siteId = '';
let alphaId = '';
let gate = '';
let passA = '';
let passB = '';
let oldTo = 0;
let newTo = 0;

/** Пропуск Альфы от имени администратора; срок — по часам сервера (без своего начала). */
async function createPass(plate: string, hours: number): Promise<string> {
  const categories = await api(admin.page, 'GET', `/sites/${siteId}/vehicle-categories`);
  const car = categories.items.find((c) => c.name === 'легковой');
  const body = {
    tenantId: alphaId,
    passType: 'single',
    participant: 'vehicle',
    plate,
    categoryId: car?.id,
    validTo: new Date(Date.now() + hours * HOUR).toISOString(),
  };
  const created = await api(admin.page, 'POST', '/passes', body);
  return created.id;
}

test('подготовка: два пропуска Альфы; у одного изменён срок и был въезд с выездом, другой на территории', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  admin = await loginAs(browser, ADMIN);
  logist = await loginAs(browser, LOGIST);
  const me = await api(logist.page, 'GET', '/auth/me');
  alphaId = String(me.user?.assignments[0]?.tenantId ?? '');
  siteId = String((await api(admin.page, 'GET', '/sites')).items[0]?.id ?? '');
  gate = sqlValue(`select name from gates where site_id = '${siteId}' order by name limit 1`);
  expect(gate).not.toBe('');

  passA = await createPass('С701СС174', 3);
  passB = await createPass('С702СС174', 3);
  // срок продлевает администратор с причиной: в ленте будет «было → стало»
  const before = await api(admin.page, 'GET', `/passes/${passA}`);
  oldTo = Date.parse(String((before as unknown as { validTo: string }).validTo));
  newTo = oldTo + 2 * HOUR;
  await api(admin.page, 'PATCH', `/passes/${passA}`, {
    validTo: new Date(newTo).toISOString(),
    reason: 'Задерживается разгрузка',
  });
  // въезд и выезд (данные под владельцем, минуя пост: лента читает визиты)
  const visit = (pass: string, minutesIn: number, minutesOut: number | null) => `
    insert into visits (organization_id, site_id, tenant_id, pass_id, participant, category_id, plate_norm,
                        snapshot, gate_in_id, time_in, method_in, gate_out_id, time_out, method_out)
    select p.organization_id, p.site_id, p.tenant_id, p.id, 'vehicle', p.category_id, p.plate_norm,
           jsonb_build_object('gate', g.name), g.id, now() - interval '${minutesIn} minutes', 'button',
           ${minutesOut === null ? 'null' : 'g.id'},
           ${minutesOut === null ? 'null' : `now() - interval '${minutesOut} minutes'`},
           ${minutesOut === null ? 'null' : "'button'"}
    from passes p join gates g on g.site_id = p.site_id and g.name = '${gate}'
    where p.id = '${pass}'`;
  sql(visit(passA, 30, 10));
  sql(visit(passB, 40, null));
});

test('админка «Пропуска»: клик по строке открывает карточку с данными и полной историей; «Назад» закрывает', async () => {
  test.setTimeout(90_000);
  const page = admin.page;
  await page.goto(`${WEB_URL}/admin/passes`);
  await page.getByLabel('Поиск').fill('701');
  const row = page.getByTestId('pass-row').filter({ hasText: 'C701CC174' });
  await expect(row).toHaveCount(1);
  // клик не по номеру, а по пустому месту строки: открывается вся строка
  await row.getByTestId('pass-tenant').click();
  const card = page.getByTestId('pass-card');
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`pass=${passA}`));
  await expect(card.getByRole('heading', { name: /C701CC174/ })).toBeVisible();
  // данные: арендатор, кто оформил, где сейчас
  await expect(card).toContainText('Альфа');
  await expect(card.getByTestId('pass-created')).toContainText(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
  await expect(card.getByTestId('pass-presence')).toContainText('Последний выезд');
  await expect(card.getByTestId('pass-presence')).toContainText(`(${gate})`);
  await expect(card).toContainText('Челябинск, UTC+5');

  // история: новые сверху — выезд, въезд, изменение срока, оформление
  const entries = card.getByTestId('history-entry');
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0).getByTestId('history-title')).toHaveText(`Выезд · ${gate}`);
  await expect(entries.nth(1).getByTestId('history-title')).toHaveText(`Въезд · ${gate}`);
  await expect(entries.nth(2).getByTestId('history-title')).toHaveText('Изменён');
  await expect(entries.nth(2).getByTestId('history-change')).toHaveText(
    `Действует до: ${siteStamp(oldTo)} → ${siteStamp(newTo)}`,
  );
  await expect(entries.nth(2)).toContainText('Причина: Задерживается разгрузка');
  await expect(entries.nth(2).getByTestId('history-actor')).toContainText('Администратор объекта');
  await expect(entries.nth(3).getByTestId('history-title')).toHaveText('Оформлен');

  // фильтр над лентой
  const filter = card.getByRole('radiogroup', { name: 'Что показать в истории' });
  await filter.getByRole('radio', { name: 'КПП', exact: true }).click();
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toHaveAttribute('data-group', 'gate');
  await filter.getByRole('radio', { name: 'Изменения' }).click();
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toHaveAttribute('data-group', 'changes');
  await filter.getByRole('radio', { name: 'Всё' }).click();
  await expect(entries).toHaveCount(4);

  // «Назад» закрывает карточку, адрес возвращается
  await page.goBack();
  await expect(card).toHaveCount(0);
  await expect(page).not.toHaveURL(/pass=/);
});

test('кнопки в строке работают как раньше и карточку не открывают; с клавиатуры строка открывается', async () => {
  const page = admin.page;
  await page.goto(`${WEB_URL}/admin/passes`);
  await page.getByLabel('Поиск').fill('701');
  const row = page.getByTestId('pass-row').filter({ hasText: 'C701CC174' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /Изменить пропуск/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('pass-card')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // клавиатура: фокус на номер строки, Enter открывает; фокус виден (кольцо вокруг строки)
  const open = row.getByRole('button', { name: 'C701CC174' });
  await open.focus();
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('pass-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pass-card')).toHaveCount(0);
});

test('ссылка ?pass=<id> открывает карточку сразу; закрытие убирает параметр', async () => {
  const page = admin.page;
  await page.goto(`${WEB_URL}/admin/passes?pass=${passA}`);
  const card = page.getByTestId('pass-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: /C701CC174/ })).toBeVisible();
  await expect(card.getByTestId('history-entry')).toHaveCount(4);
  await card.getByRole('button', { name: 'Закрыть' }).click();
  await expect(card).toHaveCount(0);
  await expect(page).not.toHaveURL(/pass=/);
});

test('«Сейчас на территории»: админка (оба режима), вкладка арендатора и кабинет открывают карточку', async () => {
  test.setTimeout(90_000);
  const page = admin.page;
  // админка → «Пропуска» → «Сейчас на территории»
  await page.goto(`${WEB_URL}/admin/passes?view=inside`);
  const row = page.getByTestId('inside-row').filter({ hasText: 'C702CC174' });
  await expect(row).toHaveCount(1);
  await row.getByTestId('inside-tenant').click();
  const card = page.getByTestId('pass-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('pass-presence')).toContainText(`На территории с`);
  await expect(card.getByTestId('pass-presence')).toContainText(`(${gate})`);
  await expect(card.getByTestId('history-entry').first().getByTestId('history-title')).toHaveText(
    `Въезд · ${gate}`,
  );
  await expect(page).toHaveURL(/view=inside.*pass=|pass=.*view=inside/);
  await page.goBack();
  await expect(card).toHaveCount(0);

  // вкладка «На территории» в карточке арендатора
  await page.goto(`${WEB_URL}/admin/tenants/${alphaId}?tab=inside`);
  const tenantRow = page.getByTestId('inside-row').filter({ hasText: 'C702CC174' });
  await expect(tenantRow).toHaveCount(1);
  await tenantRow.getByRole('button', { name: 'C702CC174' }).click();
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(/tab=inside/);
  await expect(page).toHaveURL(/pass=/);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // кабинет арендатора: «Сейчас на территории» и список пропусков
  const mine = logist.page;
  await mine.goto(`${WEB_URL}/cabinet/inside`);
  await mine
    .getByTestId('inside-row')
    .filter({ hasText: 'C702CC174' })
    .getByRole('button', { name: 'C702CC174' })
    .click();
  const myCard = mine.getByTestId('pass-card');
  await expect(myCard).toBeVisible();
  await expect(myCard.getByTestId('history-entry').first()).toContainText(`Въезд · ${gate}`);
  await mine.keyboard.press('Escape');
  await mine.goto(`${WEB_URL}/cabinet/passes`);
  await mine.getByLabel('Поиск').fill('701');
  await mine
    .getByTestId('pass-row')
    .filter({ hasText: 'C701CC174' })
    .getByRole('button', { name: 'C701CC174' })
    .click();
  await expect(myCard.getByTestId('history-entry')).toHaveCount(4);
  // арендатор видит КПП и время, но не служебное
  await expect(myCard).not.toContainText('Служебное');
});

test('без права «История пропуска» карточка открывается, а вместо ленты — неактивная строка с причиной', async () => {
  const roles = await api(admin.page, 'GET', '/roles');
  const manager = roles.items.find((r) => r.templateCode === 'tenant_manager');
  expect(manager).toBeTruthy();
  const all = manager?.permissions ?? [];
  expect(all).toContain('pass.history.view');
  try {
    await api(admin.page, 'PATCH', `/roles/${manager?.id}`, {
      permissions: all.filter((p) => p !== 'pass.history.view'),
    });
    const page = logist.page;
    await page.goto(`${WEB_URL}/cabinet/passes?pass=${passA}`);
    const card = page.getByTestId('pass-card');
    await expect(card.getByRole('heading', { name: /C701CC174/ })).toBeVisible();
    await expect(card.getByTestId('pass-presence')).toBeVisible();
    const stub = card.getByTestId('no-history');
    await expect(stub).toBeDisabled();
    await expect(stub).toContainText('История недоступна: нет права «История пропуска»');
    await expect(card.getByTestId('history-entry')).toHaveCount(0);
  } finally {
    await api(admin.page, 'PATCH', `/roles/${manager?.id}`, { permissions: all });
  }
});

test('редактор ролей: у роли «Пост КПП» право «История пропуска» неактивно с причиной', async () => {
  const page = admin.page;
  await page.goto(`${WEB_URL}/admin/roles`);
  await page
    .getByRole('button', { name: /роль: Пост КПП/ })
    .first()
    .click();
  const box = page.getByRole('checkbox', { name: /История пропуска/ });
  await expect(box).toBeDisabled();
  await expect(box).not.toBeChecked();
  await expect(page.getByText(/Недоступно для ролей КПП/)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('телефон 360 px: карточка на весь экран, без горизонтальной прокрутки', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const phone = { width: 360, height: 740 };
  const mine = await loginAs(browser, ADMIN, phone);
  await mine.page.goto(`${WEB_URL}/admin/passes?pass=${passA}`);
  const card = mine.page.getByTestId('pass-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('history-entry')).toHaveCount(4);
  const box = await card.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(360);
  expect(Math.round(box?.height ?? 0)).toBe(740);
  const scroll = await mine.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scroll, 'горизонтальная прокрутка страницы с карточкой').toBeLessThanOrEqual(1);
  const inner = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(inner, 'горизонтальная прокрутка внутри карточки').toBeLessThanOrEqual(1);
  await mine.context.close();
});

test('пакет из .xlsx: дата-время Excel числом в «С» и «По»; «По» с датой; срок длиннее максимума — кнопка «Закончить в …»', async () => {
  test.setTimeout(90_000);
  const page = logist.page;
  const max =
    (await api(page, 'GET', `/sites/${siteId}/passes/context`)).site?.singleMaxHours ?? 24;
  const tomorrow = siteDay(1);
  const startMs = tomorrow.startMs + 8 * HOUR;
  const lastDay = siteDay(2);
  const dir = mkdtempSync(join(tmpdir(), 'oxrana-e2e-'));
  const file = join(dir, 'times.xlsx');
  // конец «на час длиннее максимума» — по дате и времени, текстом
  const tooLate = siteStamp(startMs + (max + 1) * HOUR);
  const latest = siteStamp(startMs + max * HOUR);
  writeFileSync(
    file,
    buildXlsx([
      ['Номер', 'Тип', 'Дата', 'С', 'По'],
      // дата-время числом Excel: целая часть — день, дробная — время
      ['О801ОО174', 'легковой', '', tomorrow.serial + 8 / 24, tomorrow.serial + 18 / 24],
      // «По» текстом с датой: следующие сутки 07:00
      ['О802ОО174', 'легковой', '', tomorrow.serial + 8 / 24, `${lastDay.ru} 07:00`],
      ['О803ОО174', 'легковой', '', tomorrow.serial + 8 / 24, tooLate],
    ]),
  );
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  await page.getByLabel('Файл со списком').setInputFiles(file);
  const rows = page.getByTestId('batch-rows').locator('li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByTestId('batch-span')).toContainText(
    `${tomorrow.short} 08:00 → ${tomorrow.short} 18:00`,
    { timeout: 15_000 },
  );
  await expect(rows.nth(1).getByTestId('batch-span')).toContainText(
    `${tomorrow.short} 08:00 → ${lastDay.short} 07:00`,
  );
  // третья строка: не молчаливое «до 09:00 того же дня», а ошибка с исправлением
  await expect(rows.nth(2)).toContainText('действует дольше максимума объекта');
  await expect(page.getByTestId('batch-bad')).toHaveText('Ошибки в 1');
  await rows
    .nth(2)
    .getByRole('button', { name: `Закончить в ${latest.slice(11)}` })
    .click();
  await expect(page.getByTestId('batch-ok')).toHaveText('Будет создано 3', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Создать пропуска: 3' }).click();
  await expect(page.getByTestId('batch-done')).toContainText('Создано 3 из 3');
});
