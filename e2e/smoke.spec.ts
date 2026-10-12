import { expect, test } from '@playwright/test';
import { PORTS } from '../playwright.config';

const API = `http://127.0.0.1:${PORTS.api}`;
const WEB = `http://127.0.0.1:${PORTS.web}`;
const GATE = `http://127.0.0.1:${PORTS.gate}`;

test('API: /healthz отвечает', async ({ request }) => {
  const res = await request.get(`${API}/healthz`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok' });
});

test('web: главная без входа ведёт на экран входа', async ({ page }) => {
  await page.goto(WEB);
  await expect(page).toHaveTitle('Платформа пропускного режима');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вход');
});

test('web: неизвестный адрес показывает «Страница не найдена»', async ({ page }) => {
  await page.goto(`${WEB}/net-takoy-stranicy`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
});

test('gate: непривязанное устройство открывает экран привязки', async ({ page }) => {
  await page.goto(GATE);
  await expect(page).toHaveTitle('Пост охраны');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Привязка устройства поста');
});
