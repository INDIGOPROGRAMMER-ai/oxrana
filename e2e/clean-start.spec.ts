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

test('мастер настройки на чистой базе: объект, 2 КПП, типы, маршруты, доки, арендатор с лимитом', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`${WEB_URL}/admin`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Добро пожаловать');
  await page.getByRole('link', { name: 'Начать настройку' }).click();
  const next = () => page.getByRole('button', { name: /^(Далее|Пропустить шаг)/ }).click();
  const title = (text: string) => expect(page.getByRole('heading', { level: 1 })).toHaveText(text);

  // 1. Объект: пояс предзаполнен поясом организации, подсказка по адресу — только подсказка
  await title('Шаг 1 из 11. Объект');
  await page.getByLabel('Название объекта').fill('Склад № 1');
  await page.getByLabel('Адрес', { exact: true }).fill('г. Челябинск, ул. Заводская, 1');
  await expect(page.getByLabel('Часовой пояс объекта')).toHaveValue('Asia/Yekaterinburg');
  await page.getByRole('button', { name: 'Создать объект' }).click();
  await expect(page.getByText('Идентификатор пояса: Asia/Yekaterinburg')).toBeVisible();
  await next();

  // 2. КПП: «Въезд 1» — машины и пешеходы, «Въезд 2» — только машины
  await title('Шаг 2 из 11. КПП');
  await expect(page.getByText('КПП ещё нет')).toBeVisible();
  for (const [name, admits] of [
    ['Въезд 1', null],
    ['Въезд 2', 'только машины'],
  ] as const) {
    await page.getByRole('button', { name: 'Добавить КПП' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название КПП').fill(name);
    if (admits) await dialog.getByLabel(admits).check();
    await dialog.getByRole('button', { name: 'Добавить КПП' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  }
  await next();

  // 3. Типы: два из набора и один свой; порядок кнопкой «Выше»
  await title('Шаг 3 из 11. Типы транспорта');
  // переключатель — скрытый флажок внутри подписи: нажимаем на подпись, как человек
  await page.locator('label', { hasText: /^легковой/ }).click();
  await expect(page.getByRole('checkbox', { name: /^легковой/ })).toBeChecked();
  await page.locator('label', { hasText: /^фура/ }).click();
  await expect(page.getByRole('checkbox', { name: /^фура/ })).toBeChecked();
  await page.getByLabel('Название своего типа').fill('Рефрижератор');
  await page.getByRole('button', { name: 'Добавить тип' }).click();
  const typeList = page.getByRole('list', { name: 'Типы транспорта' });
  await expect(typeList.getByRole('listitem')).toHaveCount(3);
  await typeList.getByRole('listitem').nth(2).getByRole('button', { name: 'Выше' }).click();
  await expect(typeList.getByRole('listitem').nth(1)).toContainText('Рефрижератор');
  await next();

  // 4. Маршруты: фура и рефрижератор — только «Въезд 2», легковой — «Въезд 1», пешеходы — «Въезд 1»
  await title('Шаг 4 из 11. Маршруты');
  await page.getByRole('checkbox', { name: 'фура → Въезд 2' }).check();
  await page.getByRole('checkbox', { name: 'Рефрижератор → Въезд 2' }).check();
  await page.getByRole('checkbox', { name: 'легковой → Въезд 1' }).check();
  await page.getByRole('checkbox', { name: 'Пешеход → Въезд 1' }).check();
  await expect(page.getByRole('checkbox', { name: 'Пешеход → Въезд 2' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'фура → Въезд 2' })).toBeChecked();
  await next();

  // 5. Доки 1–10 диапазоном: предпросмотр до сохранения
  await title('Шаг 5 из 11. Доки и зоны');
  // «Вид дока» из формы добавления убран: по умолчанию «с уравнивающей платформой»
  await expect(page.getByLabel('Вид дока')).toHaveCount(0);
  await page.getByLabel('Номера доков').fill('1–10');
  await expect(page.getByText('Добавится 10')).toBeVisible();
  await expect(page.getByText('Ошибки в 0')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить доков: 10' }).click();
  await expect(page.getByText('Добавлено 10 из 10')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Док 10', exact: true })).toBeVisible();
  await next();

  // 6. Арендаторы пакетом из Excel
  await title('Шаг 6 из 11. Арендаторы');
  await page.getByRole('button', { name: 'Вставить из Excel' }).first().click();
  await page
    .getByLabel('Вставить из Excel', { exact: true })
    .fill('Альфа\tООО «Альфа»\t7700000001\nБета\nГамма\t\t123');
  await expect(page.getByText('Добавится 2')).toBeVisible();
  await expect(page.getByText('Ошибки в 1')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить арендаторов: 2' }).click();
  await expect(page.getByText('Добавлено 2 из 2')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Альфа', exact: true })).toBeVisible();
  await next();

  // 7. Лимит арендатору: доки 1–5 и лимит «[фура] — [число] · режим»
  await title('Шаг 7 из 11. Назначения и лимиты');
  await page.getByLabel('Номера доков').fill('1–5');
  // «С даты» предзаполнена сегодняшней датой объекта и показана как ДД.ММ.ГГГГ; отдельной кнопки
  // «Проверить» нет: проверка идёт сама, закрепляет одна кнопка
  await expect(page.getByLabel('С даты').first()).toHaveValue(/^\d{2}\.\d{2}\.\d{4}$/);
  await expect(page.getByRole('button', { name: 'Проверить', exact: true })).toHaveCount(0);
  await page.getByLabel('С даты').first().fill('01012026');
  await expect(page.getByLabel('С даты').first()).toHaveValue('01.01.2026');
  await page.getByRole('button', { name: 'Закрепить 5 доков' }).click();
  await expect(page.getByRole('cell', { name: '№ 5', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Добавить лимит' }).first().click();
  const limit = page.getByRole('dialog');
  await limit.locator('label', { hasText: /^фура$/ }).click();
  await expect(limit.getByRole('checkbox', { name: 'фура', exact: true })).toBeChecked();
  await limit.getByLabel('Число мест').fill('3');
  await limit.getByLabel('Режим').selectOption('hard');
  await limit.getByRole('button', { name: 'Добавить лимит' }).click();
  await expect(page.getByText(/Фура — 3 · жёсткий/).first()).toBeVisible();
  await expect(page.getByText(/Фура 3\/3 — машина будет ждать/).first()).toBeVisible();

  // 8–11: шаги доступны, сводка показывает состояние
  await page.goto(`${WEB_URL}/admin/setup/check`);
  await title('Шаг 11 из 11. Проверка');
  await expect(page.getByRole('row', { name: /1\. Объект/ })).toContainText('Склад № 1');
  await expect(page.getByRole('row', { name: /3\. Типы транспорта/ })).toContainText(
    'Рефрижератор',
  );
  // прогон вердиктов по настроенным данным: 3–5 примеров тем же движком, каждый — ссылка в песочницу
  const examples = page.getByTestId('examples').getByRole('listitem');
  await expect(examples.first()).toBeVisible();
  expect(await examples.count()).toBeGreaterThanOrEqual(3);
  expect(await examples.count()).toBeLessThanOrEqual(5);
  await expect(page.getByTestId('examples').locator('[data-color="green"]')).not.toHaveCount(0);
  await expect(page.getByTestId('examples').locator('[data-color="yellow"]')).not.toHaveCount(0);
});

test('данные мастера видны в карточках; правка шлёт только изменённые поля; удаление показывает использование', async ({
  page,
}) => {
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`${WEB_URL}/admin/categories`);
  await expect(
    page.getByRole('list', { name: 'Типы транспорта' }).getByRole('listitem'),
  ).toHaveCount(3);
  await page.goto(`${WEB_URL}/admin/routing`);
  await expect(page.getByRole('checkbox', { name: 'фура → Въезд 2' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'фура → Въезд 1' })).not.toBeChecked();
  await page.goto(`${WEB_URL}/admin/docks`);
  await expect(page.getByRole('button', { name: 'Док 1', exact: true })).toBeVisible();
  // в карточке дока вид — под «Дополнительно», свёрнуто; у добавленных пакетом — по умолчанию
  await page.getByRole('button', { name: 'Док 1', exact: true }).click();
  const dockCard = page.getByRole('dialog');
  await expect(dockCard.getByText('Дополнительно')).toBeVisible();
  await expect(dockCard.getByLabel('Вид дока')).toBeHidden();
  await dockCard.getByText('Дополнительно').click();
  await expect(dockCard.getByLabel('Вид дока')).toHaveValue('leveller');
  await page.keyboard.press('Escape');
  await expect(dockCard).toBeHidden();

  // правка КПП: в запросе только изменённое поле
  await page.goto(`${WEB_URL}/admin/gates`);
  await page.getByRole('button', { name: 'Изменить: Въезд 1' }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByLabel('Название КПП');
  await expect(name).toHaveValue('Въезд 1');
  await expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  await name.fill('Въезд 1А');
  const patch = page.waitForRequest(
    (r) => r.method() === 'PATCH' && r.url().includes('/api/gates/'),
  );
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  expect((await patch).postDataJSON()).toEqual({ name: 'Въезд 1А' });
  await expect(page.getByRole('cell', { name: 'Въезд 1А', exact: true })).toBeVisible();
  // возвращаем имя для следующих тестов
  await page.getByRole('button', { name: 'Изменить: Въезд 1А' }).click();
  await page.getByRole('dialog').getByLabel('Название КПП').fill('Въезд 1');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('cell', { name: 'Въезд 1', exact: true })).toBeVisible();

  // удаление КПП, на который ссылаются маршруты: диалог показывает, где он используется
  await page.getByRole('button', { name: 'Удалить: КПП «Въезд 2»' }).click();
  const usages = page.getByTestId('usages');
  await expect(usages).toContainText('правила маршрута');
  await page.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByRole('cell', { name: 'Въезд 2', exact: true })).toBeVisible();

  // смена пояса — с причиной и подтверждением последствий
  await page.goto(`${WEB_URL}/admin/setup/site`);
  await page.getByRole('link', { name: 'Сменить пояс…' }).click();
  await page.getByLabel('Новый пояс').selectOption({ index: 1 });
  await page.getByLabel('Причина').fill('Ошибка при создании');
  await page.getByRole('button', { name: 'Далее: показать последствия' }).click();
  await expect(page.getByText('Последствия смены пояса')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сменить пояс' })).toBeDisabled();
});

test('чёрный список → песочница показывает красный с причиной (и снова зелёный после удаления)', async ({
  page,
}) => {
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`${WEB_URL}/admin/blacklist`);
  await expect(page.getByText('Чёрный список пуст')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Номер машины').fill('в 777 ор 174');
  await expect(dialog.getByText('B777OP174')).toBeVisible();
  // причина обязательна
  await dialog.getByRole('button', { name: 'Добавить в чёрный список' }).click();
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await dialog.getByLabel('Причина').fill('Драка на территории');
  await dialog.getByRole('button', { name: 'Добавить в чёрный список' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('cell', { name: 'B777OP174', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Драка на территории', exact: true })).toBeVisible();

  // песочница, режим по умолчанию — «как на посту»: ищет настоящие пропуска, воображаемых нет
  await page.goto(`${WEB_URL}/admin/sandbox`);
  await expect(page.getByRole('tab', { name: 'Проверить номер, как на посту' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('combobox', { name: 'КПП', exact: true }).selectOption({ label: 'Въезд 2' });
  await page.getByLabel('Номер машины').fill('В777ОР174');
  await expect(page.getByTestId('plate-not-found')).toContainText(
    'Настоящих пропусков по этому номеру нет',
  );
  // как на посту: у номера без пропуска охранник видит «Пропуска нет» (чёрный список — у найденного пропуска)
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-code', 'no_pass');
  await expect(page.getByTestId('verdict')).toContainText('Пропуска нет: B777OP174');
  await expect(page.getByTestId('example-notice')).toHaveCount(0);

  // режим «на примере»: тот же вердикт, но над ним крупно — что пропуск воображаемый
  await page.getByRole('tab', { name: 'Проверить правила на примере' }).click();
  await page
    .getByRole('combobox', { name: 'Арендатор', exact: true })
    .selectOption({ label: 'Альфа' });
  await page.getByRole('combobox', { name: 'Тип транспорта' }).selectOption({ label: 'фура' });
  await page.getByRole('combobox', { name: 'КПП', exact: true }).selectOption({ label: 'Въезд 2' });
  await expect(page.getByTestId('verdict')).toHaveAttribute('data-color', 'green');
  await expect(page.getByTestId('example-notice')).toContainText(
    'Это пример: пропуск воображаемый, настоящие пропуска не проверялись.',
  );
  await page.getByLabel('Номер машины').fill('В777ОР174');
  const verdict = page.getByTestId('verdict');
  await expect(verdict).toHaveAttribute('data-color', 'red');
  await expect(verdict).toContainText('В чёрном списке: Драка на территории');
  await page.getByRole('button', { name: /Почему так/ }).click();
  await expect(page.getByRole('row', { name: /Чёрный список/ })).toContainText('не пройдена');

  // убрали из списка — снова зелёный
  await page.goto(`${WEB_URL}/admin/blacklist`);
  await page.getByRole('button', { name: 'Убрать из списка: B777OP174' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Убрать', exact: true }).click();
  await expect(page.getByText('Чёрный список пуст')).toBeVisible();
});

test('блокировка арендатора с последствиями → песочница показывает причину; разблокировка возвращает всё', async ({
  page,
}) => {
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`${WEB_URL}/admin/tenants`);
  await page.getByRole('link', { name: 'Альфа', exact: true }).click();
  await page.getByRole('button', { name: 'Заблокировать…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Полная блокировка').check();
  await dialog.getByLabel('Причина').fill('Задолженность по аренде');
  await expect(dialog.getByText(/Сейчас на территории никого нет/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Подтвердить блокировку' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('заблокирован полностью').first()).toBeVisible();
  await expect(page.getByText('Задолженность по аренде')).toBeVisible();

  await page.goto(`${WEB_URL}/admin/sandbox`);
  await page.getByRole('tab', { name: 'Проверить правила на примере' }).click();
  await page
    .getByRole('combobox', { name: 'Арендатор', exact: true })
    .selectOption({ label: 'Альфа (заблокирован)' });
  await page.getByRole('combobox', { name: 'Тип транспорта' }).selectOption({ label: 'фура' });
  await page.getByRole('combobox', { name: 'КПП', exact: true }).selectOption({ label: 'Въезд 2' });
  const verdict = page.getByTestId('verdict');
  await expect(verdict).toHaveAttribute('data-color', 'red');
  await expect(verdict).toContainText('Въезд арендатору Альфа запрещён');
  // выезд заблокированным разрешён всегда
  await page.getByLabel('Направление').selectOption('out');
  await expect(verdict).not.toHaveAttribute('data-color', 'red');

  await page.goto(`${WEB_URL}/admin/tenants`);
  await page.getByRole('link', { name: 'Альфа', exact: true }).click();
  await page.getByRole('button', { name: 'Снять блокировку…' }).click();
  await page.getByRole('dialog').getByLabel('Причина').fill('Долг погашен');
  await page.getByRole('dialog').getByRole('button', { name: 'Снять блокировку' }).click();
  await expect(page.getByText('активен', { exact: true }).first()).toBeVisible();
});

test('закрепление доков одной кнопкой: проверка идёт сама, «Основание» необязательно', async ({
  page,
}) => {
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`${WEB_URL}/admin/tenants`);
  await page.getByRole('link', { name: 'Бета', exact: true }).click();
  await page.getByRole('tab', { name: 'Доки' }).click();
  await expect(page.getByLabel('Основание (необязательно)')).toBeVisible();
  await expect(page.getByText('У арендатора нет договора')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Проверить', exact: true })).toHaveCount(0);
  const apply = page.getByRole('button', { name: /^Закрепить/ });
  await expect(apply).toBeDisabled();
  await page.getByLabel('Номера доков').fill('6–7');
  // «по дату» пусто и подписано «бессрочно»
  await expect(page.getByText('бессрочно').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Закрепить 2 дока' })).toBeEnabled();
  await page.getByRole('button', { name: 'Закрепить 2 дока' }).click();
  await expect(page.getByRole('cell', { name: '№ 6', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '№ 7', exact: true })).toBeVisible();
  // док 6 уже занят: проверка сама скажет, кем, до всякого нажатия
  await page.getByRole('link', { name: 'Все арендаторы' }).click();
  await page.getByRole('link', { name: 'Альфа', exact: true }).click();
  await page.getByRole('tab', { name: 'Доки' }).click();
  await page.getByLabel('Номера доков').fill('6');
  await expect(page.getByText(/закреплён за арендатором «Бета»/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Закрепить/ })).toBeDisabled();
});

test('«Вести договоры» выключено скрывает вкладку и поля договоров; включено — возвращает', async ({
  page,
}) => {
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`${WEB_URL}/admin/setup/site`);
  // переключатель — скрытый флажок внутри подписи: нажимаем на подпись, как человек
  await page.locator('label', { hasText: 'Вести договоры' }).click();
  await expect(page.getByRole('checkbox', { name: /Вести договоры/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Сохранить' }).last().click();
  await expect(page.getByText('Договоры выключены и скрыты').first()).toBeVisible();

  await page.goto(`${WEB_URL}/admin/tenants`);
  await page.getByRole('link', { name: 'Бета', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Договор' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Доки' }).click();
  await expect(page.getByLabel('Основание (необязательно)')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Лимиты' }).click();
  await expect(page.getByText('Основание', { exact: false })).toHaveCount(0);

  await page.goto(`${WEB_URL}/admin/setup/site`);
  await page.locator('label', { hasText: 'Вести договоры' }).click();
  await expect(page.getByRole('checkbox', { name: /Вести договоры/ })).toBeChecked();
  await page.getByRole('button', { name: 'Сохранить' }).last().click();
  await expect(page.getByText('Договоры включены').first()).toBeVisible();
  await page.goto(`${WEB_URL}/admin/tenants`);
  await page.getByRole('link', { name: 'Бета', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Договор' })).toBeVisible();
});

test('дата вводится как ДД.ММ.ГГГГ при локали браузера en-US; нативного поля даты нет', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Yekaterinburg' });
  const page = await context.newPage();
  await login(page, OWNER.email, OWNER.password);
  await page.goto(`${WEB_URL}/admin/tenants`);
  await page.getByRole('link', { name: 'Бета', exact: true }).click();
  await page.getByRole('tab', { name: 'Доки' }).click();
  const from = page.getByLabel('С даты');
  await expect(from).toHaveValue(/^\d{2}\.\d{2}\.\d{4}$/);
  await from.fill('13102026');
  await expect(from).toHaveValue('13.10.2026');
  await expect(
    page.locator('input[type="date"], input[type="time"], input[type="datetime-local"]'),
  ).toHaveCount(0);
  // календарь тоже по-русски
  await page.getByRole('button', { name: 'Выбрать дату в календаре' }).first().click();
  await expect(page.getByText('октябрь 2026')).toBeVisible();
  await context.close();
});

test('владелец приглашает администратора объекта; подделанный запрос с чужого сайта отклоняется', async ({
  page,
}) => {
  await login(page, OWNER.email, OWNER.password);
  const forged = await page.request.post(`${WEB_URL}/api/sites`, {
    headers: { origin: 'https://evil.example' },
    data: { name: 'Чужой' },
  });
  expect(forged.status()).toBe(403);

  await page.goto(`${WEB_URL}/admin/users`);
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
  await admin.goto(`${WEB_URL}/admin/devices`);
  await expect(admin.getByRole('heading', { name: 'Въезд 1' })).toBeVisible();
  await admin.getByRole('button', { name: 'Привязать устройство' }).first().click();
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
  await expect(admin.getByRole('cell', { name: 'ПК поста въезда', exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Отозвать' }).click();
  await admin.getByRole('dialog').getByLabel('Причина').fill('Планшет потерян');
  await admin.getByRole('dialog').getByRole('button', { name: 'Отозвать' }).click();
  await expect(admin.getByRole('cell', { name: 'отозвано: Планшет потерян' })).toBeVisible();
  await post.reload();
  await expect(post.getByRole('heading', { level: 1 })).toHaveText('Привязка устройства поста');
  await expect(post.getByText('Устройство отвязано администратором')).toBeVisible();

  await adminContext.close();
  await postContext.close();
});
