import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { E2E_DATABASE_ADMIN_URL, GATE_URL, WEB_URL } from '../playwright.config';

/**
 * Этап 5 в браузере (ADR-016, ADR-018): чистый старт из командной строки → владелец задаёт пароль
 * по ссылке и входит → приглашает администратора объекта → тот входит по приглашению →
 * привязывает устройство КПП кодом/QR → пост открывается в своей учётке, после перезагрузки тоже
 * (сценарий 44) → отзыв устройства действует сразу. Объект и КПП в этом сценарии создаются через
 * API: их экраны — этап «Админка». Все данные выдуманные.
 */
test.describe.configure({ mode: 'serial', retries: 0 });

const OWNER = { email: 'owner@example.test', password: 'Пароль-владельца-2026' };
const ADMIN = { email: 'admin@example.test', password: 'Пароль-админа-2026', name: 'Козлов Олег' };

function bootstrap(): string {
  const out = execFileSync(
    'pnpm',
    [
      '--silent',
      '--filter',
      '@oxrana/api',
      'exec',
      'tsx',
      'src/cli/bootstrap.ts',
      '--org',
      'ООО «Пример»',
      '--slug',
      'primer',
      '--timezone',
      'Asia/Yekaterinburg',
      '--owner-name',
      'Сидорова Анна',
      '--owner-email',
      OWNER.email,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_ADMIN_URL: E2E_DATABASE_ADMIN_URL, PUBLIC_URL: WEB_URL },
    },
  );
  const link = /https?:\/\/\S+\/password#\S+/.exec(out)?.[0];
  if (!link) throw new Error(`ссылки нет в выводе:\n${out}`);
  return link;
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${WEB_URL}/login`);
  await page.getByLabel('E-mail или телефон').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Вы вошли как')).toBeVisible();
}

let inviteLink = '';
let enrollLink = '';

test('чистый старт → владелец задаёт пароль по ссылке и входит', async ({ page }) => {
  const link = bootstrap();
  expect(link.startsWith(`${WEB_URL}/password#`)).toBe(true);
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Добро пожаловать');
  await page.getByLabel('Новый пароль').fill(OWNER.password);
  await page.getByLabel('Повторите пароль').fill(OWNER.password);
  await page.getByRole('button', { name: 'Сохранить пароль и войти' }).click();
  await expect(page.getByText('Вы вошли как')).toBeVisible();
  await expect(page.getByText('Владелец организации — вся организация')).toBeVisible();

  // ссылка одноразовая
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вход');
  await page.goto(link);
  await expect(page.getByRole('alert')).toContainText('Ссылка недействительна');

  // неверный пароль — без подсказки, верный — вход
  await page.goto(`${WEB_URL}/login`);
  await page.getByLabel('E-mail или телефон').fill(OWNER.email);
  await page.getByLabel('Пароль').fill('неверный-пароль');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Неверный логин или пароль.');
  await login(page, OWNER.email, OWNER.password);
});

test('владелец заводит объект и КПП и приглашает администратора объекта', async ({ page }) => {
  await login(page, OWNER.email, OWNER.password);
  // объект и КПП — через API от имени владельца (экраны — этап «Админка»)
  const headers = { origin: WEB_URL };
  const site = await page.request.post(`${WEB_URL}/api/sites`, {
    headers,
    data: { name: 'Склад № 1' },
  });
  expect(site.status()).toBe(201);
  const siteId = (await site.json()).id as string;
  const gate = await page.request.post(`${WEB_URL}/api/sites/${siteId}/gates`, {
    headers,
    data: { name: 'Въезд 1', kind: 'perimeter', admits: 'vehicles_and_pedestrians' },
  });
  expect(gate.status()).toBe(201);
  // подделанный запрос с чужого сайта отклоняется
  const forged = await page.request.post(`${WEB_URL}/api/sites`, {
    headers: { origin: 'https://evil.example' },
    data: { name: 'Чужой' },
  });
  expect(forged.status()).toBe(403);

  await page.goto(WEB_URL);
  await page.getByRole('link', { name: 'Пользователи и приглашения' }).click();
  await page.locator('input[name=email]').fill(ADMIN.email);
  await page.getByLabel('Фамилия и имя').fill(ADMIN.name);
  await page.locator('select[name=roleId]').selectOption({ label: 'Администратор объекта' });
  await page.locator('select[name=siteId]').selectOption({ label: 'Склад № 1' });
  await page.getByRole('button', { name: 'Пригласить' }).click();
  const linkInput = page.getByLabel('Ссылка приглашения');
  await expect(linkInput).toBeVisible();
  inviteLink = await linkInput.inputValue();
  expect(inviteLink.startsWith(`${WEB_URL}/invite#`)).toBe(true);
  await expect(page.getByRole('cell', { name: 'ждёт ответа' })).toBeVisible();
});

test('вход по приглашению: пароль, согласие — и администратор сразу работает', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(inviteLink);
  await expect(page.getByText('Администратор объекта')).toBeVisible();
  await expect(page.getByLabel('Фамилия и имя')).toHaveValue(ADMIN.name);
  await page.getByLabel('Придумайте пароль').fill(ADMIN.password);
  const accept = page.getByRole('button', { name: 'Принять приглашение' });
  await expect(accept).toBeDisabled();
  await page.getByLabel('Согласен(на) на обработку персональных данных').check();
  await accept.click();
  await expect(page.getByText(`Вы вошли как ${ADMIN.name}`)).toBeVisible();
  await expect(page.getByText('Администратор объекта — Склад № 1')).toBeVisible();
  await context.close();
});

test('привязка устройства КПП кодом/QR; пост открывается без пароля и после перезагрузки; отзыв — сразу', async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin, ADMIN.email, ADMIN.password);
  await admin.getByRole('link', { name: 'Устройства КПП' }).click();
  await expect(admin.getByRole('heading', { name: 'Въезд 1' })).toBeVisible();
  await admin.getByRole('button', { name: 'Привязать устройство' }).click();
  const code = await admin.getByTestId('enrollment-code').textContent();
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  await expect(admin.locator('.qr svg')).toBeVisible();
  enrollLink = (await admin.getByTestId('enrollment-link').getAttribute('href')) ?? '';
  expect(enrollLink).toBe(`${GATE_URL}/enroll#${code}`);

  // устройство поста: открывает адрес из QR — код уже введён
  const postContext = await browser.newContext();
  const post = await postContext.newPage();
  await post.goto(enrollLink);
  await expect(post.getByLabel('Код привязки')).toHaveValue(code ?? '');
  await post.getByLabel('Название устройства').fill('ПК поста въезда');
  await post.getByRole('button', { name: 'Привязать' }).click();
  await expect(post.getByTestId('gate-name')).toHaveText('Въезд 1');
  await expect(post.getByText('Склад № 1 · устройство «ПК поста въезда»')).toBeVisible();

  // сценарий 44: перезагрузка — пост сразу в своей учётке, пароль не нужен
  await post.reload();
  await expect(post.getByTestId('gate-name')).toHaveText('Въезд 1');

  // код одноразовый
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(enrollLink);
  await second.getByRole('button', { name: 'Привязать' }).click();
  await expect(second.getByRole('alert')).toContainText('Код привязки неверный или устарел');
  await other.close();

  // админ видит устройство и отзывает его — пост сразу на экране привязки
  await admin.getByRole('button', { name: 'Готово' }).click();
  await admin.reload();
  await expect(admin.getByRole('cell', { name: 'ПК поста въезда' })).toBeVisible();
  admin.once('dialog', (dialog) => void dialog.accept('Планшет потерян'));
  await admin.getByRole('button', { name: 'Отозвать' }).click();
  await expect(admin.getByRole('cell', { name: 'отозвано: Планшет потерян' })).toBeVisible();
  await post.reload();
  await expect(post.getByRole('heading', { level: 1 })).toHaveText('Привязка устройства поста');
  await expect(post.getByText('Устройство отвязано администратором')).toBeVisible();

  await adminContext.close();
  await postContext.close();
});
