import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { xlsxToTable } from '../packages/ui/src/batch/spreadsheet';
import { E2E_DATABASE_ADMIN_URL, WEB_URL } from '../playwright.config';

/**
 * Этап 7b.2: «Повторить вчера» по настройке формы, колонки пакета из формы (пропуска и автопарк),
 * несколько номеров в строке, свой срок у каждой строки пакета, страница «Пропуска» в админке по всем
 * арендаторам и меню выгрузки. Продолжает базу после `lists.spec.ts` (проект `batch-admin` идёт
 * последним): организация «Пример», объект «Склад № 1», арендаторы «Альфа» (логист Белова Мария, доки,
 * 120 пропусков, три фуры на территории) и «Бета», администратор объекта. Все данные выдуманные.
 */
test.describe.configure({ mode: 'serial', retries: 0 });

const ADMIN = { email: 'admin@example.test', password: 'Пароль-админа-2026' };
const LOGIST = { email: 'logist@example.test', password: 'Пароль-логиста-2026' };

async function loginAs(browser: Browser, who: { email: string; password: string }) {
  const context = await browser.newContext();
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
  items: { id: string; shortName: string; validFrom: string; validTo: string }[];
  user?: { assignments: { tenantId: string }[] };
  categories?: { id: string; name: string }[];
  created: number;
  errors: unknown[];
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

/** Дата объекта (Челябинск) со сдвигом в днях: `iso`, `ДД.ММ`, набор цифр `ДДММГГГГ`. */
function siteDate(shiftDays = 0): { iso: string; short: string; typed: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yekaterinburg',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(Date.now() + shiftDays * 86_400_000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const [d, m, y] = [get('day'), get('month'), get('year')];
  return { iso: `${y}-${m}-${d}`, short: `${d}.${m}`, typed: `${d}${m}${y}` };
}

let logist: Awaited<ReturnType<typeof loginAs>>;
let adminSession: Awaited<ReturnType<typeof loginAs>>;
let siteId = '';
let alphaId = '';
let betaId = '';

// в базе E2E два места назначения (зоны из прежних проверок) — «Место назначения» в колонках есть
const COLUMNS_DEFAULT =
  'Колонки: Номер · Тип · Марка · Комментарий · Док · Место назначения · Дата · С · По (обязательные: Номер, Тип).';

const setTenantForm = (body: Record<string, unknown>) =>
  api(adminSession.page, 'PATCH', `/tenants/${alphaId}/pass-form`, body);

test('подготовка: логист и администратор вошли; у Беты есть пропуск', async ({ browser }) => {
  test.setTimeout(90_000);
  logist = await loginAs(browser, LOGIST);
  adminSession = await loginAs(browser, ADMIN);
  const me = await api(logist.page, 'GET', '/auth/me');
  alphaId = String(me.user?.assignments[0]?.tenantId ?? '');
  const sites = await api(adminSession.page, 'GET', '/sites');
  siteId = String(sites.items[0]?.id ?? '');
  const tenants = await api(adminSession.page, 'GET', `/sites/${siteId}/tenants`);
  betaId = tenants.items.find((t) => t.shortName === 'Бета')?.id ?? '';
  expect(betaId).not.toBe('');
  // пропуск Беты кладём в базу напрямую: у «Беты» в E2E нет лимитов, форма отказала бы
  sql(`insert into passes (organization_id, site_id, tenant_id, pass_type, participant, plate_raw,
        plate_norm, plate_country, category_id, status, created_via, valid_from, valid_to)
       select t.organization_id, t.site_id, t.id, 'single', 'vehicle', 'К777ВТ174', 'K777BT174', 'RU',
        (select id from vehicle_categories where name = 'легковой' limit 1), 'approved', 'web',
        now(), now() + interval '20 hours'
       from tenants t where t.id = '${betaId}'`);
  // чистая форма: поля как по умолчанию
  await setTenantForm({ fields: { driverName: null, driverPhone: null, comment: null } });
});

test('«Повторить вчера» по умолчанию не видна; после включения настройкой — видна и в списке, и в автопарке', async () => {
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes`);
  await expect(page.getByRole('heading', { level: 1, name: 'Пропуска' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить вчерашний день' })).toHaveCount(0);
  await page.goto(`${WEB_URL}/cabinet/fleet`);
  await expect(page.getByRole('button', { name: 'Добавить машину' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить вчерашний день' })).toHaveCount(0);

  // включил администратор на уровне арендатора
  await setTenantForm({ repeatYesterday: true });
  await page.goto(`${WEB_URL}/cabinet/passes`);
  const button = page.getByRole('button', { name: 'Повторить вчерашний день' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`${WEB_URL}/cabinet/fleet`);
  await expect(page.getByRole('button', { name: 'Повторить вчерашний день' })).toBeVisible();

  // и выключил обратно: сброс к значению по умолчанию
  await setTenantForm({ repeatYesterday: null });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Добавить машину' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить вчерашний день' })).toHaveCount(0);
});

test('колонки пакета — из формы: ФИО и телефон выключены, док и комментарий включены; шаблон Excel — те же колонки', async () => {
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  await expect(page.getByTestId('batch-columns')).toContainText(COLUMNS_DEFAULT);
  const [template] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('batch-template').click(),
  ]);
  expect(xlsxToTable(readFileSync(await template.path()))).toEqual([
    ['Номер', 'Тип', 'Марка', 'Комментарий', 'Док', 'Место назначения', 'Дата', 'С', 'По'],
  ]);

  // пакет автопарка — те же поля без времени
  await page.goto(`${WEB_URL}/cabinet/fleet`);
  await expect(
    page.getByText('Колонки: Номер · Тип · Марка · Комментарий · Док (обязательные: Номер, Тип).'),
  ).toBeVisible();
  const [fleetTemplate] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('batch-template').click(),
  ]);
  expect(xlsxToTable(readFileSync(await fleetTemplate.path()))).toEqual([
    ['Номер', 'Тип', 'Марка', 'Комментарий', 'Док'],
  ]);

  // администратор включает водителя (обязательно) и телефон — колонки появляются, обязательная отмечена
  await setTenantForm({ fields: { driverName: 'required', driverPhone: 'optional' } });
  try {
    await page.goto(`${WEB_URL}/cabinet/passes/batch`);
    await expect(page.getByTestId('batch-columns')).toContainText(
      'Колонки: Номер · Тип · Марка · Водитель · Телефон · Комментарий · Док · Место назначения · Дата · С · По (обязательные: Номер, Тип, Водитель).',
    );
    await page.goto(`${WEB_URL}/cabinet/fleet`);
    await expect(
      page.getByText(
        'Колонки: Номер · Тип · Марка · Водитель · Телефон · Комментарий · Док (обязательные: Номер, Тип, Водитель).',
      ),
    ).toBeVisible();
    // пустая обязательная колонка — ошибка строки, а не молчаливая подмена
    await page.getByLabel('Вставьте машины из Excel').fill('Т701ТТ174\tлегковой\tKia\t\t');
    await expect(page.getByText(/Не заполнена колонка «Водитель»/)).toBeVisible();
  } finally {
    await setTenantForm({ fields: { driverName: null, driverPhone: null } });
  }
});

test('автопарк пакетом: комментарий и док по умолчанию хранятся у машины и подставляются в пропуск', async () => {
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/fleet`);
  await page
    .getByLabel('Вставьте машины из Excel')
    .fill('Т702ТТ174\tлегковой\tKia\tвозит стекло\t1');
  await expect(page.getByText('Добавится 1')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Добавить машин: 1' }).click();
  const row = page.getByTestId('fleet-row').filter({ hasText: 'T702TT174' });
  await expect(row).toContainText('док 1');
  await expect(row).toContainText('возит стекло');

  await row.getByRole('link', { name: 'Оформить пропуск' }).click();
  await expect(page.getByLabel('Номер машины')).toHaveValue('Т702ТТ174');
  await expect(page.getByLabel('Док')).toHaveValue(/.+/);
  await expect(page.getByLabel('Комментарий')).toHaveValue('возит стекло');
});

test('несколько номеров в одной строке: «разбить по строкам» — 55 номеров → 55 строк; в автопарке тоже', async () => {
  const page = logist.page;
  const plates = Array.from({ length: 55 }, (_, i) => `М${String(i + 1).padStart(3, '0')}ММ174`);
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  await page.getByLabel(/вставьте строки из Excel/).fill(plates.join(' '));
  const suggestion = page.getByTestId('batch-suggestion');
  await expect(suggestion).toContainText('Похоже, в строке 55 номеров — разбить по строкам?');
  await expect(page.getByTestId('batch-rows').locator('li')).toHaveCount(1);
  await suggestion.getByRole('button', { name: 'Разбить по строкам' }).click();
  await expect(page.getByTestId('batch-rows').locator('li')).toHaveCount(55);
  await expect(page.getByTestId('batch-suggestion')).toHaveCount(0);
  // пробелы внутри одного номера — по-прежнему один номер
  await page.getByLabel(/вставьте строки из Excel/).fill('А 123 ВС 174');
  await expect(page.getByTestId('batch-rows').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('batch-suggestion')).toHaveCount(0);

  await page.goto(`${WEB_URL}/cabinet/fleet`);
  await page.getByLabel('Вставьте машины из Excel').fill(plates.slice(0, 5).join(', '));
  await expect(page.getByTestId('batch-suggestion')).toContainText('в строке 5 номеров');
  await page.getByTestId('batch-suggestion-apply').click();
  await expect(page.getByLabel('Вставьте машины из Excel')).toHaveValue(
    plates.slice(0, 5).join('\n'),
  );
  // пять строк в предпросмотре (типа нет — у каждой ошибка «не указан тип», это другая проверка)
  await expect(page.locator('tr[data-status]')).toHaveCount(5);
});

test('у каждой строки пакета свой срок: три строки с разным временем и одна пустая — у пустой общее', async () => {
  test.setTimeout(90_000);
  const page = logist.page;
  const tomorrow = siteDate(1);
  const after = siteDate(2);
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  // общие значения сверху: завтра с 09:00 до 18:00
  await page.getByLabel('Общая дата приезда').fill(tomorrow.typed);
  await page.getByLabel('Общее время «с»').fill('0900');
  await page.getByLabel('Общее время «до»').fill('1800');
  await page
    .getByLabel(/вставьте строки из Excel/)
    .fill(
      [
        'Номер\tТип\tДата\tС\tПо',
        `О701ОО174\tлегковой\t${tomorrow.short}\t10:00\t12:00`,
        `О702ОО174\tлегковой\t${tomorrow.short}\t1300\t15:30`,
        `О703ОО174\tлегковой\t${after.short}\t08:00\t20:00`,
        'О704ОО174\tлегковой\t\t\t',
      ].join('\n'),
    );
  const span = (line: number) =>
    page.getByTestId('batch-rows').locator('li').nth(line).getByTestId('batch-span');
  await expect(page.getByTestId('batch-ok')).toHaveText('Будет создано 4', { timeout: 15_000 });
  await expect(span(0)).toContainText(`${tomorrow.short} 10:00 → ${tomorrow.short} 12:00`);
  await expect(span(1)).toContainText(`${tomorrow.short} 13:00 → ${tomorrow.short} 15:30`);
  await expect(span(2)).toContainText(`${after.short} 08:00 → ${after.short} 20:00`);
  // пустая строка — общее время сверху
  await expect(span(3)).toContainText(`${tomorrow.short} 09:00 → ${tomorrow.short} 18:00`);
  await expect(span(3)).toContainText('общее время');

  // правка прямо в строке — тем же компонентом, цифрами: «1200» → 12:00
  const fourth = page.getByTestId('batch-rows').locator('li').nth(3);
  await fourth.getByLabel('С, строка 5').fill('1200');
  await expect(fourth.getByLabel('С, строка 5')).toHaveValue('12:00');
  await expect(span(3)).toContainText(`${tomorrow.short} 12:00 → ${tomorrow.short} 18:00`);
  await expect(span(3)).not.toContainText('общее время');

  // «Применить ко всем» переписывает время в строках — с подтверждением, раз своё время уже есть
  await page.getByRole('button', { name: 'Применить ко всем' }).click();
  await expect(page.getByTestId('apply-time-confirm')).toContainText(
    'В 4 строках уже есть своё время',
  );
  await page.getByRole('button', { name: 'Заменить во всех строках' }).click();
  for (const line of [0, 1, 2, 3]) {
    await expect(span(line)).toContainText(`${tomorrow.short} 09:00 → ${tomorrow.short} 18:00`);
  }
});

test('ошибка времени строки называет время и даёт кнопку-исправление («Начать с …»); срок в пределах максимума проходит', async () => {
  const page = logist.page;
  const tomorrow = siteDate(1);
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  await page.getByLabel('Общая дата приезда').fill(tomorrow.typed);
  // начало вчера-сегодня уже прошло: сегодня в 00:01 — вне допуска «в прошлом»
  await page
    .getByLabel(/вставьте строки из Excel/)
    .fill(
      [
        'Номер\tТип\tДата\tС\tПо',
        `О711ОО174\tлегковой\t${siteDate(0).short}\t00:01\t23:00`,
        `О712ОО174\tлегковой\t${tomorrow.short}\t00:00\t23:59`,
      ].join('\n'),
    );
  const first = page.getByTestId('batch-rows').locator('li').nth(0);
  await expect(first).toContainText('уже прошло');
  await first.getByRole('button', { name: /Начать с \d\d:\d\d/ }).click();
  await expect(first.getByTestId('batch-span')).toBeVisible();
  // у второй строки срок 23 ч 59 мин — в пределах максимума (24 ч), ошибки нет
  await expect(page.getByTestId('batch-rows').locator('li').nth(1)).toHaveAttribute(
    'data-status',
    'ok',
    { timeout: 15_000 },
  );
});

test('админка: страница «Пропуска» по всем арендаторам — поиск, фильтр, колонка, выгрузка, «на территории»', async () => {
  test.setTimeout(90_000);
  const page = adminSession.page;
  await page.goto(`${WEB_URL}/admin`);
  await page.getByRole('link', { name: 'Пропуска', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/passes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Пропуска' })).toBeVisible();
  // пропуска двух арендаторов видны вместе: название арендатора — в каждой строке
  await page.getByLabel('Поиск').fill('777');
  await expect(page.getByTestId('pass-row').first()).toBeVisible();
  await expect(page.getByTestId('pass-tenant').first()).toContainText('Арендатор: Бета');
  await page.getByLabel('Поиск').fill('');
  await expect(page.getByTestId('found-total')).toContainText('Найдено');
  const total = Number(
    (await page.getByTestId('found-total').textContent())?.replace(/\D/g, '') ?? 0,
  );
  expect(total).toBeGreaterThan(121);
  await expect(page.getByTestId('pass-tenant').filter({ hasText: 'Альфа' }).first()).toBeVisible();

  // выгрузка рядом с поиском: меню с двумя форматами; файл содержит пропуска обоих арендаторов
  const search = page.getByLabel('Поиск');
  const exportButton = page.getByTestId('export-button');
  await expect(exportButton).toContainText('Выгрузить в Excel');
  const [a, b] = [await search.boundingBox(), await exportButton.boundingBox()];
  expect(Math.abs((a?.y ?? 0) - (b?.y ?? 100))).toBeLessThan(60);
  await exportButton.click();
  await expect(page.getByRole('menuitem', { name: 'Excel (.xlsx)' })).toBeVisible();
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'CSV' }).click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  const text = readFileSync(await csv.path(), 'utf8');
  expect(text).toContain('Альфа');
  expect(text).toContain('Бета');
  expect(text).toContain('К777ВТ174');
  expect(text.split('\n').filter((l) => l.trim() !== '').length - 1).toBe(total);

  // фильтр «Арендатор»: только Бета
  await page.getByLabel('Арендатор', { exact: true }).selectOption({ label: 'Бета' });
  await expect(page.getByTestId('found-total')).toHaveText('Найдено 1');
  await expect(page.getByTestId('pass-row')).toHaveCount(1);
  const [xlsx] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByTestId('export-button').click();
      await page.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click();
    })(),
  ]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  const table = xlsxToTable(readFileSync(await xlsx.path()));
  expect(table).toHaveLength(2);
  expect(table.flat().join(' ')).toContain('К777ВТ174');

  // «Сейчас на территории» по всему объекту
  await page.getByRole('radio', { name: 'Сейчас на территории' }).click();
  await expect(page).toHaveURL(/view=inside/);
  await expect(page.getByTestId('inside-total')).toBeVisible();
  await expect(page.getByTestId('inside-tenant').first()).toContainText('Арендатор: Альфа');
  await page.getByRole('radio', { name: 'Все пропуска' }).click();
  await expect(page).toHaveURL(/\/admin\/passes$/);
});

test('без права «Просмотр пропусков всех арендаторов» пункт «Пропуска» виден неактивным с причиной', async () => {
  const page = logist.page;
  await page.goto(`${WEB_URL}/admin`);
  const item = page.locator('[aria-disabled="true"]', { hasText: 'Пропуска' });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('title', /Нет права «Просмотр пропусков всех арендаторов»/);
  await page.goto(`${WEB_URL}/admin/passes`);
  await expect(page.getByText('Нет права смотреть пропуска всех арендаторов')).toBeVisible();
});
