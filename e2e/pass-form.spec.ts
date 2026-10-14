import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { buildXlsx } from '../packages/ui/src/batch/spreadsheet';
import { E2E_DATABASE_ADMIN_URL, WEB_URL } from '../playwright.config';

/**
 * Этап 7b: настройка формы пропуска по уровням, быстрый разовый пропуск, умные значения, правка до
 * и после въезда, пакет из файла .xlsx, колокольчик, телефон 360 px. Продолжает базу после
 * `cabinet.spec.ts` (проект `pass-form` идёт после `cabinet`): есть организация «Пример», объект
 * «Склад № 1», арендатор «Альфа» с типами «легковой», «фура», «Рефрижератор», доки 1–5, логист
 * Белова Мария («Арендатор — ответственный»), администратор объекта. Все данные выдуманные.
 */
test.describe.configure({ mode: 'serial', retries: 0 });

const OWNER = { email: 'owner@example.test', password: 'Пароль-владельца-2026' };
const ADMIN = { email: 'admin@example.test', password: 'Пароль-админа-2026' };
const LOGIST = { email: 'logist@example.test', password: 'Пароль-логиста-2026' };
const STAFF_A = {
  email: 'sotrudnik-a@example.test',
  password: 'Пароль-А-2026',
  name: 'Алексеев Антон',
};
const STAFF_B = {
  email: 'sotrudnik-b@example.test',
  password: 'Пароль-Б-2026',
  name: 'Борисова Белла',
};

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

async function acceptInvitation(browser: Browser, link: string, who: { password: string }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await page.getByLabel('Придумайте пароль').fill(who.password);
  await page.getByLabel('Согласен(на) на обработку персональных данных').check();
  await page.getByRole('button', { name: 'Принять приглашение' }).click();
  await expect(page).toHaveURL(/\/cabinet$/);
  return { page, context };
}

interface ApiResult {
  id: string;
  link: string;
  items: Record<string, unknown>[] &
    { id: string; shortName: string; templateCode: string; plateNorm: string; phase: string }[];
  user?: { assignments: { tenantId: string }[] };
  categories?: { id: string; name: string }[];
  validFrom?: string;
  validTo?: string;
  code?: string;
  field?: string;
}

/** Запрос к API от имени вошедшего (с Origin кабинета — защита от подделки запросов). */
async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  return (await res.json().catch(() => ({}))) as ApiResult;
}

function sql(statement: string): void {
  execFileSync('psql', [E2E_DATABASE_ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], {
    stdio: 'pipe',
  });
}

let siteId = '';
let alphaId = '';
let ownerSession: Awaited<ReturnType<typeof loginAs>>;
let adminSession: Awaited<ReturnType<typeof loginAs>>;
let staffA: Awaited<ReturnType<typeof acceptInvitation>>;
let staffB: Awaited<ReturnType<typeof acceptInvitation>>;
let logist: Awaited<ReturnType<typeof loginAs>>;
let categories: Record<string, string> = {};

test('подготовка: владелец приглашает двух сотрудников Альфы, они принимают приглашения', async ({
  browser,
}) => {
  ownerSession = await loginAs(browser, OWNER);
  adminSession = await loginAs(browser, ADMIN);
  logist = await loginAs(browser, LOGIST);
  const page = ownerSession.page;
  const sites = await api(page, 'GET', '/sites');
  siteId = String(sites.items[0]?.id ?? '');
  const tenants = await api(page, 'GET', `/sites/${siteId}/tenants`);
  alphaId = String(tenants.items.find((t) => t.shortName === 'Альфа')?.id ?? '');
  const roles = await api(page, 'GET', '/roles');
  const requester = roles.items.find((r) => r.templateCode === 'tenant_requester');
  const cabinet = await api(page, 'GET', `/tenants/${alphaId}/cabinet`);
  categories = Object.fromEntries((cabinet.categories ?? []).map((c) => [c.name, c.id]));
  const invite = async (who: typeof STAFF_A) =>
    (
      await api(page, 'POST', '/invitations', {
        email: who.email,
        fullName: who.name,
        roleId: requester?.id,
        siteId,
        tenantId: alphaId,
      })
    ).link;
  staffA = await acceptInvitation(browser, await invite(STAFF_A), STAFF_A);
  staffB = await acceptInvitation(browser, await invite(STAFF_B), STAFF_B);
});

test('администратор настраивает форму: у А только «легковой» и разовый, у Б только «фура»; предпросмотр меняется сразу', async () => {
  const page = adminSession.page;
  await page.goto(`${WEB_URL}/admin/pass-form`);
  await expect(page.getByRole('heading', { level: 1, name: 'Форма пропуска' })).toBeVisible();
  const preview = page.getByTestId('form-preview');
  await expect(preview).toContainText('Так увидит форму');

  // сотрудник А: уровень «Сотрудник», типы транспорта и виды пропусков
  await page.getByLabel('Сотрудник', { exact: true }).selectOption({ label: STAFF_A.name });
  await expect(preview).toContainText(`Так увидит форму: ${STAFF_A.name}`);
  await page.getByRole('button', { name: 'Сотрудник', exact: true }).click();
  const types = page.getByRole('group', { name: 'Типы транспорта' });
  await types.getByText('фура', { exact: true }).click();
  await types.getByText('Рефрижератор', { exact: true }).click();
  const kinds = page.getByRole('group', { name: 'Виды пропусков' });
  await kinds.getByText('Многоразовый').click();
  await kinds.getByText('Постоянный').click();
  // живой предпросмотр ещё до сохранения: в нём только «легковой» и один вид пропуска
  const previewType = preview.getByLabel('Тип транспорта');
  await expect(previewType.locator('option')).toHaveText(['легковой']);
  await expect(preview.getByText('Пропуск: Разовый')).toBeVisible();
  await expect(preview.getByLabel('Вид пропуска')).toHaveCount(0);
  await page.getByRole('button', { name: /Сохранить уровень/ }).click();
  await expect(page.getByText('Настройка формы сохранена')).toBeVisible();

  // у каждой настройки видно, откуда она взята
  await expect(page.getByTestId('setting-source').first()).toContainText('задано на этом уровне');

  // сотрудник Б: только «фура»
  await page.getByLabel('Сотрудник', { exact: true }).selectOption({ label: STAFF_B.name });
  await page.getByRole('button', { name: 'Сотрудник', exact: true }).click();
  const typesB = page.getByRole('group', { name: 'Типы транспорта' });
  await typesB.getByText('легковой', { exact: true }).click();
  await typesB.getByText('Рефрижератор', { exact: true }).click();
  await expect(preview.getByLabel('Тип транспорта').locator('option')).toHaveText(['фура']);
  await page.getByRole('button', { name: /Сохранить уровень/ }).click();
  await expect(page.getByText('Настройка формы сохранена').first()).toBeVisible();

  // «сбросить к уровню выше» возвращает значение: у Б сбрасываем и снова задаём
  await page
    .getByRole('button', { name: /Сбросить к уровню выше: Какие типы транспорта можно выбрать/ })
    .click();
  await expect(preview.getByLabel('Тип транспорта').locator('option')).toHaveCount(4); // «Выберите тип» + 3 типа
  await typesB.getByText('легковой', { exact: true }).click();
  await typesB.getByText('Рефрижератор', { exact: true }).click();
  await expect(preview.getByLabel('Тип транспорта').locator('option')).toHaveText(['фура']);
});

test('каждый видит только своё; сервер отклоняет чужой тип и вид пропуска через API', async () => {
  const a = staffA.page;
  await a.goto(`${WEB_URL}/cabinet/passes/new`);
  await expect(a.getByLabel('Тип транспорта').locator('option')).toHaveText(['легковой']);
  await expect(a.getByLabel('Вид пропуска')).toHaveCount(0);
  await expect(a.getByText('Пропуск: Разовый — без согласования')).toBeVisible();

  const b = staffB.page;
  await b.goto(`${WEB_URL}/cabinet/passes/new`);
  await expect(b.getByLabel('Тип транспорта').locator('option')).toHaveText(['фура']);

  // чужой тип — отказ сервера с причиной и полем
  const foreign = await api(
    a,
    'POST',
    '/passes',
    {
      tenantId: alphaId,
      passType: 'single',
      participant: 'vehicle',
      plate: 'Х777ХХ174',
      categoryId: categories['фура'],
    },
    422,
  );
  expect(foreign.code).toBe('category_unavailable');
  expect(foreign.field).toBe('categoryId');
  const foreignKind = await api(
    a,
    'POST',
    '/passes',
    {
      tenantId: alphaId,
      passType: 'multi',
      participant: 'vehicle',
      plate: 'Х778ХХ174',
      categoryId: categories['легковой'],
      validFrom: new Date(Date.now() + 3_600_000).toISOString(),
      validTo: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      comment: 'проверка',
    },
    422,
  );
  expect(foreignKind.code).toBe('pass_type_forbidden');
  const foreignB = await api(
    b,
    'POST',
    '/passes',
    {
      tenantId: alphaId,
      passType: 'single',
      participant: 'vehicle',
      plate: 'Х779ХХ174',
      categoryId: categories['легковой'],
    },
    422,
  );
  expect(foreignB.code).toBe('category_unavailable');
});

test('быстрый разовый: номер → «Создать» → действует с «сейчас» до +23 часов', async () => {
  const page = staffA.page;
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  // тип подставлен (он единственный), остальное не нужно
  await expect(page.getByLabel('Тип транспорта')).toHaveValue(categories['легковой'] ?? '');
  await page.getByLabel('Номер машины').fill('Х100ХХ174');
  const before = Date.now();
  await page.getByRole('button', { name: 'Создать пропуск' }).click();
  await expect(page.getByTestId('pass-created')).toContainText('Пропуск оформлен');
  await expect(page.getByTestId('created-span')).toContainText('Действует с');

  const list = await api(page, 'GET', `/sites/${siteId}/passes?tenantId=${alphaId}&q=100`);
  const pass = list.items.find((p) => p.plateNorm === 'X100XX174') as unknown as {
    validFrom: string;
    validTo: string;
    status: string;
  };
  expect(pass.status).toBe('approved');
  const from = Date.parse(pass.validFrom);
  expect(Math.abs(from - before)).toBeLessThan(60_000);
  expect(Date.parse(pass.validTo) - from).toBe(23 * 3_600_000);
});

test('одно место назначения подставлено и «не указано» нет; два и больше — «не указано» по умолчанию', async () => {
  const page = staffA.page;
  const zone1 = await api(ownerSession.page, 'POST', `/sites/${siteId}/zones`, {
    name: 'Склад А',
    kind: 'building',
  });
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  const destination = page.getByLabel('Место назначения');
  await expect(destination).toHaveValue(zone1.id);
  await expect(destination.locator('option')).toHaveText(['Склад А']);

  // второе место появилось — обновление без F5 (SSE): «не указано» по умолчанию
  await api(ownerSession.page, 'POST', `/sites/${siteId}/zones`, {
    name: 'Офисное здание',
    kind: 'office',
  });
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  await expect(destination.locator('option')).toHaveText([
    'Не указано',
    'Офисное здание',
    'Склад А',
  ]);
  await expect(destination).toHaveValue('');
});

test('правка пропуска: до въезда — номер и комментарий; после въезда — только комментарий и срок; после выезда — просмотр', async () => {
  const page = logist.page;
  const created = await api(page, 'POST', '/passes', {
    tenantId: alphaId,
    passType: 'single',
    participant: 'vehicle',
    plate: 'Е200КХ174',
    categoryId: categories['легковой'],
  });
  await page.goto(`${WEB_URL}/cabinet/passes`);
  await page.getByLabel('Поиск').fill('20');
  const row = page.getByTestId('pass-row').filter({ hasText: 'E200KX174' });
  await row.getByRole('button', { name: /Изменить пропуск/ }).click();
  const dialog = page.getByTestId('pass-edit');
  await expect(dialog).toContainText('Пропуск ещё не использован');
  await dialog.getByLabel('Номер машины').fill('Е201КХ174');
  await expect(dialog.getByTestId('plate-preview')).toContainText('E201KX174');
  await dialog.getByLabel('Комментарий').fill('Поменяли машину');
  // пропуск уже действует — нужна причина, и сервер получает только изменённые поля
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog.getByText('укажите причину')).toBeVisible();
  await dialog.getByLabel('Причина изменения').fill('Водитель сообщил новый номер');
  const request = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes(`/passes/${created.id}`),
  );
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  expect(Object.keys((await request).postDataJSON()).sort()).toEqual([
    'comment',
    'plate',
    'reason',
  ]);
  await expect(dialog).toBeHidden();
  const edited = page.getByTestId('pass-row').filter({ hasText: 'E201KX174' });
  await expect(edited).toBeVisible();

  // машина въехала: правятся только комментарий и «действует до»
  sql(`insert into visits (organization_id, site_id, tenant_id, pass_id, participant, category_id, plate_norm, snapshot, gate_in_id, time_in, method_in)
       select p.organization_id, p.site_id, p.tenant_id, p.id, 'vehicle', p.category_id, p.plate_norm, '{"note":"e2e"}'::jsonb, g.id, now(), 'button'
       from passes p join gates g on g.site_id = p.site_id where p.plate_norm = 'E201KX174' limit 1`);
  await page.reload();
  await page.getByLabel('Поиск').fill('20');
  await page
    .getByTestId('pass-row')
    .filter({ hasText: 'E201KX174' })
    .getByRole('button', { name: /Изменить пропуск/ })
    .click();
  await expect(dialog).toContainText('уже на территории');
  await expect(dialog.getByLabel('Номер машины')).toHaveCount(0);
  await expect(dialog.getByLabel('Тип транспорта')).toHaveCount(0);
  await expect(dialog.getByLabel('Комментарий')).toBeVisible();
  await dialog.getByLabel('Комментарий').fill('Разгрузка затянулась');
  await dialog.getByLabel('Причина изменения').fill('Продлеваем разгрузку');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeHidden();
  // сервер не пустит и в обход экрана
  const locked = await api(
    page,
    'PATCH',
    `/passes/${created.id}`,
    { plate: 'Е202КХ174', reason: 'Через API' },
    409,
  );
  expect(locked.code).toBe('pass_phase_locked');

  // выехал: пропуск использован — кнопка неактивна, причина названа
  sql(`update visits set time_out = now() where plate_norm = 'E201KX174'`);
  sql(`update passes set status = 'used' where plate_norm = 'E201KX174'`);
  await page.reload();
  await page.getByLabel('Статус').selectOption({ label: 'Использован' });
  const used = page
    .getByTestId('pass-row')
    .filter({ hasText: 'E201KX174' })
    .getByRole('button', { name: /Изменить пропуск/ });
  await expect(used).toBeDisabled();
  await expect(used).toHaveAttribute('title', /только посмотреть/);
});

test('пакет из файла .xlsx: пробелы в номерах, «легковые», док исправляется в предпросмотре — создано', async () => {
  const page = logist.page;
  // грузовым нужен док: ошибка в предпросмотре, исправить на месте
  await api(adminSession.page, 'PATCH', `/tenants/${alphaId}`, { trucksDockRequired: true });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'oxrana-e2e-'));
    // имя файла латиницей: Playwright в окружении без UTF-8 не передаёт браузеру файлы с кириллицей в пути
    const file = join(dir, 'passes.xlsx');
    writeFileSync(
      file,
      buildXlsx([
        ['Госномер', 'Тип ТС', 'Марка', 'Водитель', 'Окно'],
        ['А 555 ВС 174 ', 'Легковые', 'Kia', 'Иванов И. И.', ''],
        ['В-556-НР-174', 'фуры', 'Volvo', '', ''],
        ['О557ОО174', 'ФУРА', 'MAN', '', ''],
      ]),
    );
    await page.goto(`${WEB_URL}/cabinet/passes/batch`);
    await page.getByLabel('Файл со списком').setInputFiles(file);
    const rows = page.getByTestId('batch-rows').locator('li');
    await expect(rows).toHaveCount(3);
    // нормализованный номер виден в предпросмотре, в том числе в строках с ошибкой
    await expect(rows.nth(0).getByTestId('batch-plate')).toHaveText('A555BC174');
    await expect(rows.nth(1).getByTestId('batch-plate')).toHaveText('B556HP174');
    await expect(rows.nth(0)).toContainText('в таблице: «А 555 ВС 174»');
    // «Легковые» распознано как «легковой», «фуры» — как «фура»
    await expect(rows.nth(0).getByLabel('Тип, строка 2')).toHaveValue(categories['легковой'] ?? '');
    await expect(rows.nth(1).getByLabel('Тип, строка 3')).toHaveValue(categories['фура'] ?? '');
    // колонка «Водитель» отключена настройкой формы — об этом сказано
    await expect(page.getByTestId('batch-ignored')).toContainText('Водитель');
    await expect(page.getByTestId('batch-ok')).toHaveText('Будет создано 1', { timeout: 15_000 });
    await expect(page.getByTestId('batch-bad')).toHaveText('Ошибки в 2');
    await expect(rows.nth(1)).toContainText('Укажите док');

    // исправление прямо в предпросмотре: «Всем без дока»
    const bulk = page.getByTestId('batch-bulk');
    await bulk.getByLabel('Док для строк без дока').selectOption({ label: 'Док 1' });
    await bulk.getByRole('button', { name: /Всем без дока/ }).click();
    await expect(page.getByTestId('batch-ok')).toHaveText('Будет создано 3', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Создать пропуска: 3' }).click();
    await expect(page.getByTestId('batch-done')).toContainText('Создано 3 из 3');
  } finally {
    await api(adminSession.page, 'PATCH', `/tenants/${alphaId}`, { trucksDockRequired: false });
  }
});

test('пакет: тип «грузовой» неоднозначен — не угадывается, выбирается в строке', async () => {
  const page = logist.page;
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  // два типа с общим словом: «фура» и «Рефрижератор» не пересекаются, поэтому проверяем «не найден → выбрать в строке»
  await page.getByLabel(/вставьте строки из Excel/).fill('Х300ХХ174\tсамокат\nХ301ХХ174\tфура');
  const rows = page.getByTestId('batch-rows').locator('li');
  await expect(rows.nth(0)).toContainText('не найден среди доступных');
  await rows.nth(0).getByLabel('Тип, строка 1').selectOption({ label: 'легковой' });
  await expect(page.getByTestId('batch-ok')).toHaveText('Будет создано 2', { timeout: 15_000 });
});

test('колокольчик: одобрено с изменениями и отклонено — у логиста без перезагрузки', async () => {
  test.setTimeout(90_000);
  const page = logist.page;
  // решения по пропускам из прежних сценариев уже лежат в колокольчике: начинаем с чистого счётчика
  const earlier = await api(page, 'GET', '/notifications?unread=true');
  expect((earlier as unknown as { unreadCount: number }).unreadCount).toBeGreaterThan(0);
  await api(page, 'POST', '/notifications/read', { all: true });
  await page.goto(`${WEB_URL}/cabinet`);
  await expect(page.getByText('обновляется сразу')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('bell-count')).toHaveCount(0);

  const day = (shift: number) => new Date(Date.now() + shift * 86_400_000).toISOString();
  const multi = (plate: string) =>
    api(page, 'POST', '/passes', {
      tenantId: alphaId,
      passType: 'multi',
      participant: 'vehicle',
      plate,
      categoryId: categories['легковой'],
      validFrom: new Date(Date.now() + 60_000).toISOString(),
      validTo: day(4),
      comment: 'Ревизия склада',
    });
  const first = await multi('Т400ХХ174');
  await api(adminSession.page, 'POST', `/passes/${first.id}/approve`, {
    note: 'Хватит двух дней',
    changes: { validTo: day(2) },
  });
  await expect(page.getByTestId('bell-count')).toHaveText('1', { timeout: 15_000 });

  const second = await multi('Т401ХХ174');
  await api(adminSession.page, 'POST', `/passes/${second.id}/reject`, {
    note: 'Нет места на стоянке',
  });
  await expect(page.getByTestId('bell-count')).toHaveText('2', { timeout: 15_000 });

  await page.getByTestId('bell').click();
  const panel = page.getByTestId('bell-panel');
  const changed = panel
    .locator('[data-kind="pass_approved_changed"]')
    .filter({ hasText: 'T400XX174' });
  await expect(changed).toContainText('Пропуск одобрен с изменениями');
  await expect(changed).toContainText('Действует до');
  await expect(changed).toContainText('Хватит двух дней');
  const rejected = panel.locator('[data-kind="pass_rejected"]').filter({ hasText: 'T401XX174' });
  await expect(rejected).toContainText('Нет места на стоянке');
  // нажатие открывает пропуск и отмечает уведомление прочитанным
  await changed.click();
  await expect(page.getByRole('dialog')).toContainText('T400XX174');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bell-count')).toHaveText('1');
  await page.getByTestId('bell').click();
  await panel.getByRole('button', { name: 'Прочитать все' }).click();
  await expect(page.getByTestId('bell-count')).toHaveCount(0);
});

/** Элементы за правым краем экрана вне прокручиваемых контейнеров. */
async function overflow(page: Page): Promise<string> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.right <= width + 1) continue;
      let parent = el.parentElement;
      let clipped = false;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        if (['auto', 'scroll', 'hidden'].includes(style.overflowX) || style.position === 'fixed')
          clipped = true;
        parent = parent.parentElement;
      }
      if (!clipped && getComputedStyle(el).position !== 'fixed') {
        out.push(
          `${el.tagName.toLowerCase()} «${(el.textContent ?? '').slice(0, 30)}» right=${Math.round(box.right)}`,
        );
      }
    }
    const scroll = document.documentElement.scrollWidth - width;
    return `${scroll > 1 ? `scroll+${scroll} ` : ''}${out.slice(0, 4).join(' | ')}`;
  });
}

test('на телефоне (360 px): фильтры свёрнуты в «Фильтры» и чипы; «Создать» видна без прокрутки; страницы без горизонтальной прокрутки', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { page, context } = await loginAs(browser, LOGIST, { width: 360, height: 740 });

  // «Пропуска»: вместо блока фильтров — кнопка и строка чипов
  await page.goto(`${WEB_URL}/cabinet/passes`);
  await expect(page.getByTestId('pass-row').first()).toBeVisible();
  await expect(page.getByTestId('filters-button')).toBeVisible();
  await expect(page.getByLabel('Статус')).toHaveCount(0);
  const header = await page.getByTestId('filters-button').boundingBox();
  const firstRow = await page.getByTestId('pass-row').first().boundingBox();
  expect(
    firstRow?.y ?? 0,
    'список пропусков виден сразу под строкой поиска, а не под полэкрана фильтров',
  ).toBeLessThan(380);
  expect(header?.y ?? 0).toBeLessThan(300);
  await page.getByTestId('filters-button').click();
  const sheet = page.getByRole('dialog', { name: 'Фильтры' });
  await sheet.getByLabel('Статус').selectOption({ label: 'Использован' });
  await sheet.getByRole('button', { name: 'Показать' }).click();
  const chip = page.getByRole('button', { name: 'Убрать фильтр: Использован' });
  await expect(chip).toBeVisible();
  await expect(page.getByTestId('filters-button')).toContainText('1');
  expect(await overflow(page), '/cabinet/passes').toBe('');
  await chip.click();
  await expect(chip).toHaveCount(0);

  // новая форма: главное видно, «Создать» всегда внизу экрана
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  await expect(page.getByLabel('Номер машины')).toBeVisible();
  const submit = page.getByRole('button', { name: 'Создать пропуск' });
  await expect(submit).toBeInViewport();
  await expect(page.getByRole('button', { name: /Ещё/ })).toBeVisible();
  await page.getByRole('button', { name: /Ещё/ }).click();
  await expect(submit).toBeInViewport();
  expect(await overflow(page), '/cabinet/passes/new').toBe('');

  for (const path of [
    '/cabinet',
    '/cabinet/passes/batch',
    '/cabinet/fleet',
    '/cabinet/pass-form',
  ]) {
    await page.goto(`${WEB_URL}${path}`);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByTestId('company')).toBeVisible();
    expect(await overflow(page), path).toBe('');
  }
  // колокольчик на телефоне: панель в пределах экрана
  await page.getByTestId('bell').click();
  await expect(page.getByTestId('bell-panel')).toBeVisible();
  const panel = await page.getByTestId('bell-panel').boundingBox();
  expect((panel?.x ?? -1) >= 0 && (panel?.x ?? 0) + (panel?.width ?? 999) <= 360).toBe(true);
  await context.close();
});
