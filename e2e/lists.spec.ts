import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { xlsxToTable } from '../packages/ui/src/batch/spreadsheet';
import { E2E_DATABASE_ADMIN_URL, WEB_URL } from '../playwright.config';

/**
 * Этап 7b.1: списки без потолка и выгрузка, «Сейчас на территории», время цифрами, окно прибытия,
 * вид пропуска кнопками, док только разовому, продление после въезда. Продолжает базу после
 * `pass-form.spec.ts` (проект `lists` идёт последним): организация «Пример», объект «Склад № 1»,
 * арендатор «Альфа» с типами «легковой», «фура», лимитом на фуры 3 (три фуры уже на территории),
 * логист Белова Мария, администратор объекта. Все данные выдуманные.
 */
test.describe.configure({ mode: 'serial', retries: 0 });

const ADMIN = { email: 'admin@example.test', password: 'Пароль-админа-2026' };
const LOGIST = { email: 'logist@example.test', password: 'Пароль-логиста-2026' };

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
  items: Record<string, unknown>[] &
    { id: string; shortName: string; validFrom: string; validTo: string; dockId: string | null }[];
  total: number;
  user?: { assignments: { tenantId: string }[] };
  categories?: { id: string; name: string }[];
  changeRequest: { id: string; status: string } | null;
  applied: string[];
  validTo: string;
  validFrom: string;
  passType: string;
  dockId: string | null;
  created: number;
  errors: unknown[];
}

async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  data?: unknown,
  expectStatus?: number,
) {
  const res = await page.request.fetch(`${WEB_URL}/api${path}`, {
    method,
    headers: { origin: WEB_URL },
    ...(data === undefined ? {} : { data }),
  });
  if (expectStatus === undefined) {
    expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  } else {
    expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(expectStatus);
  }
  return (await res.json().catch(() => ({}))) as Json;
}

function sql(statement: string): void {
  execFileSync('psql', [E2E_DATABASE_ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], {
    stdio: 'pipe',
  });
}

/** Дата объекта (Челябинск) со сдвигом в днях: `iso`, набор цифр `ДДММГГГГ`. */
function siteDate(shiftDays = 0): { iso: string; typed: string; ru: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yekaterinburg',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(Date.now() + shiftDays * 86_400_000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const [d, m, y] = [get('day'), get('month'), get('year')];
  return { iso: `${y}-${m}-${d}`, typed: `${d}${m}${y}`, ru: `${d}.${m}.${y}` };
}

/** Момент → `{date: ДДММГГГГ, time: ЧЧММ}` по времени объекта. */
function siteParts(ms: number): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yekaterinburg',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('day')}${get('month')}${get('year')}`,
    time: `${get('hour')}${get('minute')}`,
  };
}

async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= width + 1) continue;
      let parent = el.parentElement;
      let clipped = false;
      while (parent && parent !== document.body) {
        const x = getComputedStyle(parent).overflowX;
        if (x === 'auto' || x === 'scroll' || x === 'hidden') clipped = true;
        parent = parent.parentElement;
      }
      if (!clipped)
        out.push(`${el.tagName.toLowerCase()} «${(el.textContent ?? '').slice(0, 40)}»`);
    }
    return out;
  });
}

async function expectNoHorizontalScroll(page: Page, where: string) {
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scroll, `горизонтальная прокрутка на ${where}`).toBeLessThanOrEqual(1);
  expect(await overflowing(page), `элементы за краем экрана на ${where}`).toEqual([]);
}

const PLATE_TAG = 'НН77';
let logist: Awaited<ReturnType<typeof loginAs>>;
let adminSession: Awaited<ReturnType<typeof loginAs>>;
let siteId = '';
let alphaId = '';
let logistId = '';
let carId = '';
let truckId = '';

const resetWindow = async (value: 'optional' | null) => {
  const body = { fields: { window: value } };
  await api(adminSession.page, 'PATCH', `/sites/${siteId}/pass-form`, body);
  await api(adminSession.page, 'PATCH', `/tenants/${alphaId}/pass-form`, body);
  await api(adminSession.page, 'PATCH', `/tenants/${alphaId}/users/${logistId}/pass-form`, body);
};

test('подготовка: логист и администратор вошли; 120 пропусков Альфы созданы пакетом', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  logist = await loginAs(browser, LOGIST);
  adminSession = await loginAs(browser, ADMIN);
  const me = await api(logist.page, 'GET', '/auth/me');
  logistId = me.id;
  alphaId = String(me.user?.assignments[0]?.tenantId ?? '');
  const cabinet = await api(logist.page, 'GET', `/tenants/${alphaId}/cabinet`);
  carId = cabinet.categories?.find((c) => c.name === 'легковой')?.id ?? '';
  truckId = cabinet.categories?.find((c) => c.name === 'фура')?.id ?? '';
  const sites = await api(adminSession.page, 'GET', '/sites');
  siteId = String(sites.items[0]?.id ?? '');
  // чистая форма: окно — как по умолчанию (скрыто)
  await resetWindow(null);

  const rows = Array.from({ length: 120 }, (_, i) => ({
    passType: 'single',
    participant: 'vehicle',
    plate: `Н${String(i + 1).padStart(3, '0')}${PLATE_TAG}`,
    categoryId: carId,
    comment: i % 2 === 0 ? 'Утренняя развозка' : null,
  }));
  const result = await api(logist.page, 'POST', '/passes/batch', { tenantId: alphaId, rows });
  expect(result.errors).toEqual([]);
  expect(result.created).toBe(120);
});

test('список: фильтр находит все 120 — порциями по 50 с «Показать ещё» и итогом «Найдено 120»', async () => {
  test.setTimeout(90_000);
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes`);
  await page.getByLabel('Поиск').fill(PLATE_TAG);
  await expect(page.getByTestId('found-total')).toHaveText('Найдено 120');
  await expect(page.getByTestId('pass-row')).toHaveCount(50);
  await expect(page.getByTestId('show-more')).toContainText('(70)');
  await page.getByTestId('show-more').click();
  await expect(page.getByTestId('pass-row')).toHaveCount(100);
  await expect(page.getByTestId('show-more')).toContainText('(20)');
  await page.getByTestId('show-more').click();
  await expect(page.getByTestId('pass-row')).toHaveCount(120);
  await expect(page.getByTestId('show-more')).toHaveCount(0);
  // все номера разные: ни один не потерян и не повторён
  const plates = await page.getByTestId('pass-row').locator('button.font-mono').allTextContents();
  expect(new Set(plates).size).toBe(120);
});

test('выгрузка: CSV и XLSX содержат все 120 строк по фильтру, не только показанную страницу', async () => {
  test.setTimeout(90_000);
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes`);
  await page.getByLabel('Поиск').fill(PLATE_TAG);
  await expect(page.getByTestId('found-total')).toHaveText('Найдено 120');
  // на экране только первая порция
  await expect(page.getByTestId('pass-row')).toHaveCount(50);

  await page.getByTestId('export-button').click();
  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'CSV' }).click(),
  ]);
  expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/);
  const csv = readFileSync(await csvDownload.path(), 'utf8').replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  expect(lines).toHaveLength(121);
  const header = (lines[0] ?? '').split(';');
  expect(header.slice(0, 4)).toEqual(['Номер', 'Тип транспорта', 'Вид пропуска', 'Статус']);
  expect(header[4]).toBe('Действует с (Челябинск, UTC+5)');
  expect(header).toEqual(
    expect.arrayContaining([
      'Место назначения',
      'Автор',
      'Создан (Челябинск, UTC+5)',
      'На территории сейчас',
    ]),
  );
  expect(lines.filter((l) => l.startsWith('Н') && l.includes(PLATE_TAG))).toHaveLength(120);
  expect(lines[1]).toContain('Белова');

  await page.getByTestId('export-button').click();
  const [xlsxDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click(),
  ]);
  expect(xlsxDownload.suggestedFilename()).toMatch(/\.xlsx$/);
  const table = xlsxToTable(new Uint8Array(readFileSync(await xlsxDownload.path())));
  expect(table).toHaveLength(121);
  expect(table[0]?.[4]).toBe('Действует с (Челябинск, UTC+5)');
  expect(
    table.slice(1).filter((r) => (r[0] ?? '').includes('HH77') || (r[0] ?? '').includes('НН77')),
  ).toHaveLength(120);
});

test('«Сейчас на территории» совпадает с виджетом лимитов; клик по виджету открывает список', async () => {
  test.setTimeout(90_000);
  const page = logist.page;
  // две легковые Альфы тоже на территории (у легковых лимита нет): всего 5, по лимиту «Фура» — 3
  sql(`insert into visits (organization_id, site_id, tenant_id, pass_id, participant, category_id, plate_norm, snapshot, gate_in_id, time_in, method_in)
       select p.organization_id, p.site_id, p.tenant_id, p.id, 'vehicle', p.category_id, p.plate_norm,
              '{"gate":"Въезд 1","category":"легковой"}'::jsonb, g.id, now() - interval '135 minutes', 'button'
       from passes p join gates g on g.name = 'Въезд 1' and g.site_id = p.site_id
       where p.plate_norm in ('H001HH77', 'H002HH77')`);
  await page.goto(`${WEB_URL}/cabinet`);
  const widget = page.getByTestId('limit-widget');
  await expect(widget).toContainText('3 / 3');
  const summary = page.getByTestId('inside-link');
  await expect(summary).toHaveText('Сейчас на территории: 5');

  // клик по виджету «Фура 3 / 3» → ровно те визиты, что считает виджет
  await widget.click();
  await expect(page).toHaveURL(/\/cabinet\/inside\?quota=/);
  await expect(page.getByTestId('inside-total')).toContainText('3');
  await expect(page.getByTestId('inside-row')).toHaveCount(3);
  await expect(page.getByTestId('quota-chip')).toContainText('Фура');

  // без фильтра по лимиту — все пять, как в сводке главной
  await page.getByTestId('quota-chip').click();
  await expect(page).toHaveURL(/\/cabinet\/inside$/);
  await expect(page.getByTestId('inside-total')).toContainText('5');
  await expect(page.getByTestId('inside-row')).toHaveCount(5);
  // время на территории и КПП въезда
  const first = page.getByTestId('inside-row').filter({ hasText: 'Н001НН77' });
  await expect(first).toContainText('Въезд: Въезд 1');
  await expect(first.getByTestId('inside-stay')).toHaveText(/2 ч (1[5-9]|[2-5]\d) мин/);

  // поиск по цифрам номера
  await page.getByLabel('Поиск').fill('002');
  await expect(page.getByTestId('inside-row')).toHaveCount(1);
  await page.getByLabel('Поиск').fill('');
  await expect(page.getByTestId('inside-row')).toHaveCount(5);

  // выгрузка: все строки по фильтру
  await page.getByTestId('export-button').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'CSV' }).click(),
  ]);
  const csv = readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  expect(lines).toHaveLength(6);
  expect((lines[0] ?? '').split(';')).toEqual(
    expect.arrayContaining(['Номер или ФИО', 'КПП въезда', 'Док', 'Место назначения']),
  );
});

test('администратор видит тот же список по арендатору: вкладка «На территории» в карточке Альфы', async () => {
  const page = adminSession.page;
  await page.goto(`${WEB_URL}/admin/tenants/${alphaId}?tab=inside`);
  await expect(page.getByTestId('inside-total')).toContainText('5');
  await expect(page.getByTestId('inside-row')).toHaveCount(5);
  await expect(page.getByTestId('export-button')).toBeEnabled();
});

test('время цифрами: «1200» → «12:00», окончание подставляется само; окно скрыто; «Разовый» выбран кнопкой', async () => {
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  // вид пропуска — кнопки, «Разовый» выбран сразу
  await expect(page.getByRole('radiogroup', { name: 'Вид пропуска' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Разовый', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByRole('radio', { name: 'Многоразовый', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(page.locator('select[aria-label="Вид пропуска"]')).toHaveCount(0);
  // окно по умолчанию скрыто
  await expect(page.getByText('Окно прибытия')).toHaveCount(0);

  // начало «сейчас» подставлено само — не пустая подсказка
  const start = page.getByLabel('Действует с');
  const end = page.getByLabel('Действует до');
  await expect(start).toHaveValue(/^\d{2}:\d{2}$/);
  await expect(end).toHaveValue(/^\d{2}:\d{2}$/);

  await start.fill('');
  await start.pressSequentially('1200');
  await expect(start).toHaveValue('12:00');
  // окончание = начало + 23 ч по умолчанию: 11:00 следующих суток, видно «завтра» и правится
  await expect(end).toHaveValue('11:00');
  await expect(page.getByTestId('end-next-day')).toBeVisible();
  await end.fill('');
  await end.pressSequentially('1830');
  await expect(end).toHaveValue('18:30');
  await expect(page.getByTestId('end-next-day')).toHaveCount(0);
  // начало поменяли — окончание, которое правили руками, остаётся
  await start.fill('');
  await start.pressSequentially('930');
  await expect(start).toHaveValue('09:30');
  await expect(end).toHaveValue('18:30');
});

test('окно включается в настройке формы: подсказка, «12001400» → «12:00–14:00», понятная ошибка и кнопка-исправление', async () => {
  test.setTimeout(90_000);
  await resetWindow('optional');
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  await page.getByLabel('Номер машины').fill('Е811КХ174');
  await page.getByLabel('Тип транспорта').selectOption({ label: 'легковой' });
  // завтра: сегодняшнее «сейчас» не мешает проверке
  await page.getByLabel('Дата приезда').fill(siteDate(1).typed);
  const window = page.getByLabel('Окно прибытия');
  await expect(window).toBeVisible();
  await expect(
    page.getByText(
      'Узкий интервал, когда машину ждут (например, на док). Пропуск может действовать дольше.',
    ),
  ).toBeVisible();
  await window.pressSequentially('12001400');
  await expect(window).toHaveValue('12:00–14:00');

  // начало 13:50 позже начала окна 12:00
  const start = page.getByLabel('Действует с');
  await start.fill('');
  await start.pressSequentially('1350');
  await expect(start).toHaveValue('13:50');
  await page.getByRole('button', { name: 'Создать пропуск' }).click();
  await expect(
    page.getByText('Окно 12:00–14:00 начинается раньше начала пропуска (13:50).'),
  ).toBeVisible();
  // «Начать пропуск с 12:00» на будущий день допустимо только если это не в прошлом — здесь оно в будущем
  await expect(page.getByTestId('fix-window_start')).toHaveText('Начать окно с 13:50');
  await page.getByTestId('fix-window_start').click();
  await expect(window).toHaveValue('13:50–14:00');
  await page.getByRole('button', { name: 'Создать пропуск' }).click();
  await expect(page.getByTestId('pass-created')).toBeVisible();
  await resetWindow(null);
});

test('будущая дата без времени — пропуск на весь день до 23:59', async () => {
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  await page.getByLabel('Номер машины').fill('Е812КХ174');
  await page.getByLabel('Тип транспорта').selectOption({ label: 'легковой' });
  await page.getByLabel('Дата приезда').fill(siteDate(2).typed);
  await expect(page.getByText('пропуск действует весь день, до 23:59')).toBeVisible();
  await page.getByRole('button', { name: 'Создать пропуск' }).click();
  await expect(page.getByTestId('pass-created')).toBeVisible();
  const span = page.getByTestId('created-span');
  await expect(span).toContainText(`${siteDate(2).ru} 00:00`);
  await expect(span).toContainText(`${siteDate(2).ru} 23:59`);
});

test('«грузовые только к докам»: постоянный пропуск на фуру сохраняется без дока, разовый — требует док', async () => {
  test.setTimeout(90_000);
  await api(adminSession.page, 'PATCH', `/tenants/${alphaId}`, { trucksDockRequired: true });
  try {
    const page = logist.page;
    await page.goto(`${WEB_URL}/cabinet/passes/new`);
    await page.getByLabel('Номер машины').fill('Х931ХХ174');
    await page.getByLabel('Тип транспорта').selectOption({ label: 'фура' });
    // разовый: док обязателен
    await page.getByRole('button', { name: 'Создать пропуск' }).click();
    await expect(page.getByText('Укажите док.').first()).toBeVisible();
    // постоянный: док необязателен — на много поездок он каждый раз свой
    await page.getByRole('radio', { name: 'Постоянный' }).click();
    await expect(page.getByLabel('Док')).toBeVisible();
    await expect(page.getByText('Необязательно: на много поездок')).toBeVisible();
    await page.getByLabel('Комментарий').fill('Служебная фура');
    await page.getByRole('button', { name: /Создать пропуск|Отправить на согласование/ }).click();
    await expect(page.getByTestId('pass-created')).toBeVisible();
    const list = await api(logist.page, 'GET', `/sites/${siteId}/passes?tenantId=${alphaId}&q=931`);
    const created = list.items.find((p) => p.plateNorm === 'X931XX174');
    expect(created).toMatchObject({ passType: 'permanent', dockId: null });
    // и сервер не требует док у постоянного, даже в обход экрана
    const viaApi = await api(logist.page, 'POST', '/passes', {
      tenantId: alphaId,
      passType: 'multi',
      participant: 'vehicle',
      plate: 'Х932ХХ174',
      categoryId: truckId,
      validFrom: new Date().toISOString(),
      validTo: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      comment: 'Рейсы на неделе',
    });
    expect(viaApi.passType).toBe('multi');
  } finally {
    await api(adminSession.page, 'PATCH', `/tenants/${alphaId}`, { trucksDockRequired: false });
  }
});

test('продление после въезда: до максимума — сразу, сверх максимума — заявкой согласующему', async () => {
  test.setTimeout(90_000);
  const page = logist.page;
  const created = await api(page, 'POST', '/passes', {
    tenantId: alphaId,
    passType: 'single',
    participant: 'vehicle',
    plate: 'Е821КХ174',
    categoryId: carId,
  });
  sql(`insert into visits (organization_id, site_id, tenant_id, pass_id, participant, category_id, plate_norm, snapshot, gate_in_id, time_in, method_in)
       select p.organization_id, p.site_id, p.tenant_id, p.id, 'vehicle', p.category_id, p.plate_norm, '{"note":"e2e"}'::jsonb, g.id, now(), 'button'
       from passes p join gates g on g.site_id = p.site_id where p.plate_norm = 'E821KX174' limit 1`);
  const startMs = Date.parse(created.validFrom);

  const open = async () => {
    await page.goto(`${WEB_URL}/cabinet/passes`);
    await page.getByLabel('Поиск').fill('821');
    await page
      .getByTestId('pass-row')
      .filter({ hasText: 'E821KX174' })
      .getByRole('button', { name: /Изменить пропуск/ })
      .click();
    const dialog = page.getByTestId('pass-edit');
    await expect(dialog).toContainText('уже на территории');
    return dialog;
  };
  const setEnd = async (dialog: ReturnType<Page['getByTestId']>, ms: number) => {
    const { date, time } = siteParts(ms);
    await dialog.getByLabel('Дата').fill(date);
    await dialog.getByLabel('Время').fill(time);
  };

  // до 24 ч от начала — применяется сразу
  let dialog = await open();
  await setEnd(dialog, startMs + 24 * 3_600_000 - 60_000);
  await expect(dialog.getByTestId('edit-within-max')).toBeVisible();
  await dialog.getByLabel('Причина изменения').fill('Разгрузка затянулась до утра');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeHidden();
  const now = await api(page, 'GET', `/passes/${created.id}`);
  expect(Date.parse(now.validTo)).toBeGreaterThan(startMs + 23.9 * 3_600_000);

  // сверх максимума — заявка; до решения действует прежний срок
  dialog = await open();
  await setEnd(dialog, startMs + 30 * 3_600_000);
  // права согласовать у логиста нет: форма не отказывает, а предлагает отправить на согласование
  await expect(dialog.getByTestId('edit-beyond-max')).toContainText('нужно согласование');
  await expect(dialog.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  await dialog.getByLabel('Причина изменения').fill('Фура стоит под разгрузкой двое суток');
  const request = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes(`/passes/${created.id}`),
  );
  await dialog.getByRole('button', { name: 'Отправить на согласование' }).click();
  const sent = (await request).postDataJSON();
  expect(Object.keys(sent).sort()).toEqual(['reason', 'validTo']);
  await expect(dialog).toBeHidden();
  const after = await api(page, 'GET', `/passes/${created.id}`);
  expect(after.validTo).toBe(now.validTo);
  const requests = await api(page, 'GET', `/passes/${created.id}/change-requests`);
  expect(requests.items.at(-1)).toMatchObject({ status: 'pending' });
});

test('на телефоне (360 px): списки, «Сейчас на территории» и форма не прокручиваются вбок; вид пропуска — кнопки или список', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const phone = await loginAs(browser, LOGIST, { width: 360, height: 740 });
  const page = phone.page;
  for (const path of [
    '/cabinet',
    '/cabinet/passes',
    '/cabinet/inside',
    '/cabinet/passes/new',
    '/cabinet/passes/batch',
  ]) {
    await page.goto(`${WEB_URL}${path}`);
    await expect(page.getByTestId('company')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoHorizontalScroll(page, path);
  }
  // длинный список с «Показать ещё»
  await page.goto(`${WEB_URL}/cabinet/passes`);
  await page.getByLabel('Поиск').fill(PLATE_TAG);
  await expect(page.getByTestId('found-total')).toHaveText('Найдено 120');
  await page.getByTestId('show-more').click();
  await expect(page.getByTestId('pass-row')).toHaveCount(100);
  await expectNoHorizontalScroll(page, 'список пропусков после «Показать ещё»');
  // на телефоне «Выгрузить» — в панели «Фильтры», а не над списком: список остаётся на первом экране
  await expect(page.getByTestId('export-button')).toHaveCount(0);
  await page.getByTestId('filters-button').click();
  await expect(
    page.getByRole('dialog', { name: 'Фильтры' }).getByTestId('export-button'),
  ).toBeVisible();
  await expectNoHorizontalScroll(page, 'панель фильтров с выгрузкой');
  await page.keyboard.press('Escape');
  // вид пропуска: на 360 px либо три кнопки в ряд, либо обычный список — но не выход за край
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  const buttons = page.getByRole('radio');
  const select = page.getByRole('combobox', { name: 'Вид пропуска' });
  await expect(buttons.first().or(select)).toBeVisible();
  // что вышло на деле — в аннотации и на снимке (test-results)
  test.info().annotations.push({
    type: 'вид-пропуска-360',
    description: (await buttons.count()) === 3 ? 'кнопки' : 'список',
  });
  await page.screenshot({ path: test.info().outputPath('form-360.png') });
  await expectNoHorizontalScroll(page, 'форма: вид пропуска');
  await phone.context.close();
});

test('без права «Выгрузка отчётов» кнопка неактивна и называет причину; сервер отвечает 403', async ({
  browser,
}) => {
  const roles = await api(adminSession.page, 'GET', '/roles');
  const viewer = roles.items.find(
    (r) => (r as { templateCode?: string }).templateCode === 'tenant_viewer',
  );
  const invite = await api(adminSession.page, 'POST', '/invitations', {
    email: 'nabludatel-lists@example.test',
    fullName: 'Орлов Олег',
    roleId: viewer?.id,
    siteId,
    tenantId: alphaId,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto((invite as unknown as { link: string }).link);
  await page.getByLabel('Придумайте пароль').fill('Пароль-наблюдателя-2026');
  await page.getByLabel('Согласен(на) на обработку персональных данных').check();
  await page.getByRole('button', { name: 'Принять приглашение' }).click();
  await expect(page).toHaveURL(/\/cabinet$/);
  await page.goto(`${WEB_URL}/cabinet/passes`);
  const button = page.getByTestId('export-button');
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /Нет права «Выгрузка отчётов»/);
  await expect(page.getByTestId('export-blocked')).toContainText('Нет права «Выгрузка отчётов»');
  await api(
    page,
    'GET',
    `/sites/${siteId}/passes/export?tenantId=${alphaId}&format=csv`,
    undefined,
    403,
  );
  await context.close();
});
