import { execFileSync } from 'node:child_process';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { E2E_DATABASE_ADMIN_URL, WEB_URL } from '../playwright.config';

/**
 * Этап 7a: кабинет арендатора и очередь согласования в браузере. Продолжает базу после
 * `clean-start.spec.ts` (проект `cabinet` идёт после `chromium`): уже есть организация, объект
 * «Склад № 1», КПП «Въезд 1/2», типы «легковой», «фура», «Рефрижератор», арендаторы «Альфа» (лимит
 * фур 3, жёсткий) и «Бета», владелец и администратор объекта. Владелец приглашает логиста Альфы →
 * логист оформляет пропуска (из автопарка, пакетом из 20 строк) → администратор одобряет с
 * изменениями, логист видит решение без перезагрузки. Все данные выдуманные.
 */
test.describe.configure({ mode: 'serial', retries: 0 });

const OWNER = { email: 'owner@example.test', password: 'Пароль-владельца-2026' };
const ADMIN = { email: 'admin@example.test', password: 'Пароль-админа-2026' };
const LOGIST = {
  email: 'logist@example.test',
  password: 'Пароль-логиста-2026',
  name: 'Белова Мария',
};
const READER = {
  email: 'reader@example.test',
  password: 'Пароль-читателя-2026',
  name: 'Орлов Пётр',
};

/** Дата в поясе объекта через `Intl`: пояс машины с тестом не важен. */
function siteDate(shiftDays = 0): { iso: string; typed: string; ru: string } {
  const now = new Date(Date.now() + shiftDays * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yekaterinburg',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const [d, m, y] = [get('day'), get('month'), get('year')];
  return { iso: `${y}-${m}-${d}`, typed: `${d}${m}${y}`, ru: `${d}.${m}.${y}` };
}

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

async function acceptInvitation(
  browser: Browser,
  link: string,
  who: { password: string; name: string },
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await page.getByLabel('Придумайте пароль').fill(who.password);
  await page.getByLabel('Согласен(на) на обработку персональных данных').check();
  await page.getByRole('button', { name: 'Принять приглашение' }).click();
  return { page, context };
}

/** Ответ API в тех местах, которые читает сценарий: списки, id и ссылка приглашения. */
interface ApiResult {
  id: string;
  link: string;
  items: { id: string; shortName: string; templateCode: string }[];
  user?: { assignments: { tenantId: string }[] };
  categories?: { id: string; name: string }[];
}

/** Запрос к API от имени вошедшего (с Origin кабинета — защита от подделки запросов). */
async function api(page: Page, method: 'GET' | 'POST' | 'DELETE', path: string, data?: unknown) {
  const res = await page.request.fetch(`${WEB_URL}/api${path}`, {
    method,
    headers: { origin: WEB_URL },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json().catch(() => ({}))) as ApiResult;
}

function sql(statement: string): void {
  execFileSync('psql', [E2E_DATABASE_ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], {
    stdio: 'pipe',
  });
}

let logistInvite = '';
let readerInvite = '';
let logistSession: { page: Page; context: Awaited<ReturnType<typeof loginAs>>['context'] };

test('владелец приглашает логиста Альфы (роль «Арендатор — ответственный»)', async ({
  browser,
}) => {
  const { page, context } = await loginAs(browser, OWNER);
  await page.goto(`${WEB_URL}/admin/users`);
  await page.locator('input[name=email]').fill(LOGIST.email);
  await page.getByLabel('Фамилия и имя').fill(LOGIST.name);
  await page.locator('select[name=roleId]').selectOption({ label: 'Арендатор — ответственный' });
  await page.locator('select[name=siteId]').selectOption({ label: 'Склад № 1' });
  await page.locator('select[name=tenantId]').selectOption({ label: 'Альфа' });
  await page.getByRole('button', { name: 'Пригласить' }).click();
  logistInvite = await page.getByLabel('Ссылка приглашения').inputValue();
  expect(logistInvite.startsWith(`${WEB_URL}/invite#`)).toBe(true);

  // второй человек — «Арендатор — наблюдатель»: проверим меню по правам
  const roles = await api(page, 'GET', '/roles');
  const viewerRole = roles.items.find(
    (r: { templateCode: string }) => r.templateCode === 'tenant_viewer',
  );
  const sites = await api(page, 'GET', '/sites');
  const siteId = sites.items[0]?.id ?? '';
  const tenants = await api(page, 'GET', `/sites/${siteId}/tenants`);
  const alpha = tenants.items.find((t) => t.shortName === 'Альфа');
  const invited = await api(page, 'POST', '/invitations', {
    email: READER.email,
    fullName: READER.name,
    roleId: viewerRole?.id,
    siteId,
    tenantId: alpha?.id,
  });
  readerInvite = invited.link;
  await context.close();
});

test('логист принимает приглашение и попадает в кабинет: компания, объект с поясом, меню по правам, лимиты', async ({
  browser,
}) => {
  logistSession = await acceptInvitation(browser, logistInvite, LOGIST);
  const page = logistSession.page;
  await expect(page).toHaveURL(/\/cabinet$/);
  await expect(page.getByTestId('company')).toHaveText('Альфа');
  await expect(page.getByTestId('site-line')).toContainText('Склад № 1');
  await expect(page.getByTestId('site-line')).toContainText('UTC+5');
  // меню только по правам: логисту нужны пропуска и автопарк, админки и согласования нет
  const nav = page.getByRole('navigation', { name: 'Разделы кабинета' });
  for (const name of ['Главная', 'Пропуска', 'Новый пропуск', 'Несколько', 'Автопарк']) {
    await expect(nav.getByRole('link', { name })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: /Согласование|Админка/ })).toHaveCount(0);
  // виджет лимита и сводка дня; обновление по событиям включено
  await expect(page.getByTestId('limit-widget')).toContainText('Фура');
  await expect(page.getByTestId('limit-widget')).toContainText('0 / 3');
  await expect(page.getByTestId('today-expected')).toHaveText('0');
  await expect(page.getByText('обновляется сразу')).toBeVisible({ timeout: 15_000 });
  // четыре действия главной
  for (const name of ['Пропуск', 'Несколько', 'Автопарк', 'Пропуска']) {
    await expect(
      page.getByRole('main').getByRole('link', { name: new RegExp(`^\\+?\\s*${name}$`) }),
    ).toBeVisible();
  }
});

test('автопарк: добавить машину, пропуск из автопарка в один клик, подсказки до сохранения', async () => {
  const page = logistSession.page;
  await page.getByRole('main').getByRole('link', { name: 'Автопарк' }).click();
  await expect(page.getByText('В автопарке пока пусто')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить машину' }).click();
  const dialog = page.getByRole('dialog');
  // пробел в конце номера (сценарий 36) не мешает; номер нормализуется при вводе
  await dialog.getByLabel('Номер машины').fill('А123ВС174 ');
  await expect(dialog.getByText('A123BC174')).toBeVisible();
  await dialog.getByLabel('Тип транспорта').selectOption({ label: 'фура' });
  await dialog.getByLabel('Марка').fill('Volvo FH');
  // ФИО и телефон водителя скрыты настройкой формы по умолчанию — полей в форме машины нет (7b.2)
  await expect(dialog.getByLabel('Водитель', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Телефон водителя')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Добавить в автопарк' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByTestId('fleet-row');
  await expect(row).toContainText('A123BC174');
  await expect(row).toContainText('Volvo FH');

  // «Повторить вчера» по умолчанию скрыта настройкой формы (7b.2): кнопки нет; включение — в `batch-admin.spec.ts`
  await expect(page.getByRole('button', { name: 'Повторить вчерашний день' })).toHaveCount(0);

  // из автопарка — в один клик: форма уже заполнена
  await row.getByRole('link', { name: 'Оформить пропуск' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Новый пропуск');
  await expect(page.getByLabel('Номер машины')).toHaveValue('А123ВС174');
  await expect(page.getByLabel('Тип транспорта')).toHaveValue(/.+/);
  const hints = page.getByTestId('hints');
  await expect(hints).toContainText('Фура → Въезд 2');
  await expect(hints).toContainText('Фура 0/3');
  await expect(hints).toContainText('Без согласования');
  await page.getByRole('button', { name: 'Создать пропуск' }).click();
  await expect(page.getByTestId('pass-created')).toContainText('Пропуск оформлен');
  await page.getByRole('link', { name: 'К списку пропусков' }).click();
  await expect(page.getByTestId('pass-row').first()).toContainText('A123BC174');
  await expect(page.getByTestId('pass-row').first()).toContainText('Действует');
});

test('подсказка «машина будет ждать» при заполненном лимите; виджет и сводка меняются', async () => {
  const page = logistSession.page;
  // три фуры Альфы уже на территории (визиты проводит пост; здесь — напрямую в базу)
  sql(`insert into visits (organization_id, site_id, tenant_id, participant, category_id, snapshot, gate_in_id, time_in, method_in)
       select t.organization_id, t.site_id, t.id, 'vehicle', c.id, '{"note":"e2e"}'::jsonb, g.id, now(), 'button'
       from tenants t
       join vehicle_categories c on c.name = 'фура'
       join gates g on g.name = 'Въезд 2' and g.site_id = t.site_id
       cross join generate_series(1, 3)
       where t.short_name = 'Альфа'`);
  await page.goto(`${WEB_URL}/cabinet`);
  const widget = page.getByTestId('limit-widget');
  await expect(widget).toContainText('3 / 3');
  await expect(widget).toContainText('следующая машина будет ждать у ворот');
  await expect(page.getByTestId('today-entered')).toHaveText('3');

  await page
    .getByRole('main')
    .getByRole('link', { name: /Пропуск$/ })
    .first()
    .click();
  await page.getByLabel('Тип транспорта').selectOption({ label: 'фура' });
  await expect(page.getByTestId('hints')).toContainText('Фура 3/3 — машина будет ждать');
  // для типа без лимита подсказки про ожидание нет
  await page.getByLabel('Тип транспорта').selectOption({ label: 'легковой' });
  await expect(page.getByTestId('hints')).not.toContainText('будет ждать');
});

test('форма предупреждает о чёрном списке до сохранения (причина арендатору не видна); песочница — красный без пропуска', async ({
  browser,
}) => {
  const owner = await loginAs(browser, OWNER);
  const sites = await api(owner.page, 'GET', '/sites');
  const siteId = sites.items[0]?.id ?? '';
  const entry = await api(owner.page, 'POST', `/sites/${siteId}/blacklist`, {
    level: 'site',
    plate: 'В777ОР174',
    reason: 'Драка на территории',
  });

  const page = logistSession.page;
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  await page.getByLabel('Номер машины').fill('в 777 ор 174');
  const notice = page.getByTestId('notice-blacklisted');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('чёрном списке');
  await expect(notice).toContainText('пропуск оформить нельзя');
  // оформить нельзя: кнопка неактивна и называет причину (Q-76)
  await page.getByLabel('Тип транспорта').selectOption({ label: 'легковой' });
  await expect(page.getByRole('button', { name: 'Создать пропуск' })).toBeDisabled();
  await expect(page.getByText('Оформить нельзя: Номер в чёрном списке')).toBeVisible();
  await expect(page.getByTestId('hints')).not.toContainText('Драка');
  await page.getByLabel('Номер машины').fill('К999ХМ174');
  await expect(notice).toBeHidden();

  // песочница «как на посту»: пропуска на номер нет, но номер из списка — красный с причиной
  await owner.page.goto(`${WEB_URL}/admin/sandbox`);
  await owner.page
    .getByRole('combobox', { name: 'КПП', exact: true })
    .selectOption({ label: 'Въезд 2' });
  await owner.page.getByLabel('Номер машины').fill('В777ОР174');
  const verdict = owner.page.getByTestId('verdict');
  await expect(verdict).toHaveAttribute('data-color', 'red');
  await expect(verdict).toContainText('В чёрном списке: Драка на территории');
  await expect(owner.page.getByTestId('plate-not-found')).toBeVisible();

  await api(owner.page, 'DELETE', `/blacklist/${entry.id}`);
  await owner.context.close();
});

test('пакет из 20 строк: предпросмотр 18 зелёных и 2 красных, итог «создано 18 из 20»', async () => {
  const page = logistSession.page;
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  const types = ['легковой', 'фура', 'Рефрижератор'];
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const plate = `К${String(i).padStart(3, '0')}ХМ174`;
    if (i === 7) lines.push(`${plate}\tсамокат\tКросс\tПетров`);
    else if (i === 15) lines.push('А123ВС174 \tфура\tVolvo\tИванов');
    else lines.push(`${plate}\t${types[i % 3]}\tMAN\tВодитель ${i}`);
  }
  await page.getByLabel('Вставьте строки из Excel или письма').fill(lines.join('\n'));
  await expect(page.getByTestId('batch-ok')).toHaveText('Будет создано 18', { timeout: 15_000 });
  await expect(page.getByTestId('batch-bad')).toHaveText('Ошибки в 2');
  const bad = page.locator('li[data-status="error"]');
  await expect(bad).toHaveCount(2);
  await expect(bad.nth(0)).toContainText('Тип «самокат» не найден');
  await expect(bad.nth(1)).toContainText('уже есть действующий пропуск');
  await expect(page.locator('li[data-status="ok"]')).toHaveCount(18);

  await page.getByRole('button', { name: 'Создать пропуска: 18' }).click();
  const done = page.getByTestId('batch-done');
  await expect(done).toContainText('Создано 18 из 20, 2 с ошибками');
  await expect(done).toContainText('строка 7');
  await expect(done).toContainText('строка 15');
  // ошибочные строки остались в поле — их можно исправить
  await expect(page.getByLabel('Вставьте строки из Excel или письма')).toHaveValue(
    /К007ХМ174[\s\S]*А123ВС174/,
  );

  // список: поиск по цифрам номера находит пропуск из пачки
  await page.getByRole('link', { name: 'Пропуска', exact: true }).first().click();
  await page.getByLabel('Поиск').fill('012');
  await expect(page.getByTestId('pass-row')).toHaveCount(1);
  await expect(page.getByTestId('pass-row')).toContainText('K012XM174');
});

test('многоразовый пропуск уходит на согласование; администратор одобряет с изменениями — логист видит без перезагрузки', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = logistSession.page;
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  await page.getByLabel('Номер машины').fill('Е555КХ174');
  await page.getByLabel('Тип транспорта').selectOption({ label: 'легковой' });
  await page.getByRole('radio', { name: 'Многоразовый' }).click();
  await expect(page.getByTestId('hints')).toContainText('Уйдёт на согласование');
  await page.getByLabel('Действует по').fill(siteDate(3).typed);
  // комментарий обязателен для многоразовых: ошибка у поля до запроса
  await page.getByRole('button', { name: 'Отправить на согласование' }).click();
  await expect(page.getByText('Укажите, для чего и зачем нужен пропуск.').first()).toBeVisible();
  await page.getByLabel('Комментарий').fill('Ревизия склада');
  await page.getByRole('button', { name: 'Отправить на согласование' }).click();
  await expect(page.getByTestId('pass-created')).toContainText('Пропуск отправлен на согласование');
  await page.getByRole('link', { name: 'К списку пропусков' }).click();
  const mine = page.getByTestId('pass-row').filter({ hasText: 'E555KX174' });
  await expect(mine).toContainText('На согласовании');

  // администратор: очередь с полной карточкой
  const admin = await loginAs(browser, ADMIN);
  await admin.page.goto(`${WEB_URL}/admin/approvals`);
  const card = admin.page.getByTestId('approval-card').filter({ hasText: 'E555KX174' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Заказал: Белова Мария');
  await expect(card).toContainText('Многоразовый');
  await expect(card).toContainText('Ревизия склада');
  await expect(card).toContainText('легковой');
  await card.getByRole('button', { name: 'Одобрить с изменениями…' }).click();
  const dialog = admin.page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Одобрить с изменениями', exact: true }),
  ).toBeDisabled();
  // в форме четыре поля «дата и время»: с, по, окно с, окно по — «Действует по» второе
  await dialog.getByRole('textbox', { name: 'Дата' }).nth(1).fill(siteDate(2).typed);
  await dialog.getByLabel('Комментарий согласующего').fill('Срок сокращён до двух дней');
  await dialog.getByRole('button', { name: 'Одобрить с изменениями', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    admin.page.getByTestId('approval-card').filter({ hasText: 'E555KX174' }),
  ).toHaveCount(0);

  // логист не перезагружал страницу: статус и изменения пришли по событиям объекта
  await expect(mine).toContainText('Одобрено с изменениями', { timeout: 15_000 });
  await expect(mine).toContainText(`изменено: окончание:`);
  await expect(mine).toContainText(siteDate(2).ru);
  await expect(mine).toContainText('Комментарий согласующего: Срок сокращён до двух дней');
  await admin.context.close();
});

test('администратор отклоняет с причиной — логист видит её; свои пропуска можно отменить с причиной', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = logistSession.page;
  await page.goto(`${WEB_URL}/cabinet/passes/new`);
  await page.getByLabel('Номер машины').fill('Е666КХ174');
  await page.getByLabel('Тип транспорта').selectOption({ label: 'легковой' });
  await page.getByRole('radio', { name: 'Постоянный' }).click();
  await page.getByLabel('Комментарий').fill('Директор компании');
  await page.getByRole('button', { name: 'Отправить на согласование' }).click();
  await expect(page.getByTestId('pass-created')).toContainText('отправлен на согласование');
  await page.getByRole('link', { name: 'К списку пропусков' }).click();
  await page.getByLabel('Статус').selectOption({ label: 'На согласовании' });
  const pending = page.getByTestId('pass-row').filter({ hasText: 'E666KX174' });
  await expect(pending).toBeVisible();

  const admin = await loginAs(browser, ADMIN);
  await admin.page.goto(`${WEB_URL}/admin/approvals`);
  const card = admin.page.getByTestId('approval-card').filter({ hasText: 'E666KX174' });
  await card.getByRole('button', { name: 'Отклонить…' }).click();
  const dialog = admin.page.getByRole('dialog');
  await dialog.getByLabel('Причина').fill('Нет места на парковке');
  await dialog.getByRole('button', { name: 'Отклонить пропуск' }).click();
  await expect(card).toHaveCount(0);
  await expect(admin.page.getByText('Заявок на согласование нет')).toBeVisible();
  await admin.context.close();

  await page.getByLabel('Статус').selectOption({ label: 'Отклонён' });
  const rejected = page.getByTestId('pass-row').filter({ hasText: 'E666KX174' });
  await expect(rejected).toContainText('Отклонено', { timeout: 15_000 });
  await expect(rejected).toContainText('Причина: Нет места на парковке');

  // отмена своего: вернуться ко всем статусам, отменить пропуск из автопарка
  await page.getByLabel('Статус').selectOption({ label: 'Любой' });
  await page.getByLabel('Поиск').fill('123');
  const own = page.getByTestId('pass-row').filter({ hasText: 'A123BC174' });
  await own.getByRole('button', { name: /Отменить пропуск/ }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByLabel('Причина отмены').fill('Машина в ремонте');
  await confirm.getByRole('button', { name: 'Отменить пропуск' }).click();
  await expect(own).toContainText('Отменён');
  await expect(own).toContainText('Причина: Машина в ремонте');
});

/** Элементы, торчащие за правый край экрана (кроме тех, что внутри прокручиваемого контейнера). */
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
        if (getComputedStyle(parent).position === 'fixed') clipped = true;
        parent = parent.parentElement;
      }
      if (!clipped && getComputedStyle(el).position !== 'fixed') {
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} «${(el.textContent ?? '').slice(0, 30)}» right=${Math.round(box.right)}`,
        );
      }
    }
    return out.slice(0, 5);
  });
}

async function expectNoHorizontalScroll(page: Page, where: string) {
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(
    extra,
    `горизонтальная прокрутка на ${where}: ${(await overflowing(page)).join(' | ')}`,
  ).toBeLessThanOrEqual(1);
  expect(await overflowing(page), `элементы за краем экрана на ${where}`).toEqual([]);
}

test('на телефоне (360 px): нижнее меню с крупными кнопками, ни одна страница кабинета и очередь согласований не прокручиваются вбок', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  // заявка в очереди и список пропусков с разными статусами: самое широкое содержимое
  const pending = await api(logistSession.page, 'GET', '/auth/me');
  const tenantId = pending.user?.assignments[0]?.tenantId ?? '';
  const cabinet = await api(logistSession.page, 'GET', `/tenants/${tenantId}/cabinet`);
  await api(logistSession.page, 'POST', '/passes', {
    tenantId,
    passType: 'permanent',
    participant: 'vehicle',
    plate: 'М321АА174',
    categoryId: cabinet.categories?.find((c) => c.name === 'легковой')?.id,
    comment: 'Длинный комментарий для проверки переносов строк на узком экране телефона',
    validFrom: new Date().toISOString(),
  });

  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${WEB_URL}/login`);
  await page.getByLabel('E-mail или телефон').fill(LOGIST.email);
  await page.getByLabel('Пароль').fill(LOGIST.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByTestId('company')).toHaveText('Альфа');
  const bottom = page.getByRole('navigation', { name: 'Разделы кабинета' });
  await expect(bottom.getByRole('link', { name: 'Новый пропуск' })).toBeVisible();
  const box = await bottom.getByRole('link', { name: 'Новый пропуск' }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
  for (const path of [
    '/cabinet',
    '/cabinet/passes',
    '/cabinet/passes/new',
    '/cabinet/passes/batch',
    '/cabinet/fleet',
  ]) {
    await page.goto(`${WEB_URL}${path}`);
    await expect(page.getByTestId('company')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoHorizontalScroll(page, path);
  }
  // длинные списки: пакет с ошибками и список с карточками
  await page.goto(`${WEB_URL}/cabinet/passes/batch`);
  await page
    .getByLabel('Вставьте строки из Excel или письма')
    .fill(
      'Х001ХХ174\tсамокат\nХ002ХХ174\tлегковой\tОчень длинная марка автомобиля\tПетров Пётр Петрович',
    );
  await expect(page.getByTestId('batch-ok')).toBeVisible();
  await expectNoHorizontalScroll(page, '/cabinet/passes/batch с таблицей предпросмотра');
  await page.goto(`${WEB_URL}/cabinet/passes`);
  await expect(page.getByTestId('pass-row').first()).toBeVisible();
  await page.getByTestId('pass-row').first().getByRole('button').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoHorizontalScroll(page, 'карточка пропуска');
  await page.keyboard.press('Escape');
  await context.close();

  // очередь согласований в админке — тоже на 360 px
  const adminContext = await browser.newContext({
    viewport: { width: 360, height: 740 },
    hasTouch: true,
  });
  const admin = await adminContext.newPage();
  await admin.goto(`${WEB_URL}/login`);
  await admin.getByLabel('E-mail или телефон').fill(ADMIN.email);
  await admin.getByLabel('Пароль').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(admin.getByRole('button', { name: 'Выйти' }).first()).toBeVisible();
  await admin.goto(`${WEB_URL}/admin/approvals`);
  const card = admin.getByTestId('approval-card').filter({ hasText: 'M321AA174' });
  await expect(card).toBeVisible();
  await expectNoHorizontalScroll(admin, '/admin/approvals');
  await card.getByRole('button', { name: 'Одобрить с изменениями…' }).click();
  await expect(admin.getByRole('dialog')).toBeVisible();
  await expectNoHorizontalScroll(admin, 'диалог «Одобрить с изменениями»');
  await adminContext.close();
});

test('наблюдатель компании видит пропуска и автопарк, но ничего изменить не может — кнопки неактивны с причиной', async ({
  browser,
}) => {
  const { page, context } = await acceptInvitation(browser, readerInvite, READER);
  await expect(page).toHaveURL(/\/cabinet$/);
  const nav = page.getByRole('navigation', { name: 'Разделы кабинета' });
  await expect(nav.getByRole('link', { name: 'Пропуска' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Новый пропуск' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link', { name: /Пропуск$/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Автопарк' }).first().click();
  const add = page.getByRole('button', { name: 'Добавить машину' });
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute('title', /ответственный вашей компании/);
  await expect(page.getByText('Вставить из Excel')).toHaveCount(0);
  await context.close();
});
