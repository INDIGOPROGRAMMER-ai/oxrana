import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type PassHints, PassHintsPanel } from '../src/components/cabinet/pass-hints-panel';

const hints = (over: Partial<PassHints> = {}): PassHints => ({
  route: { gates: [{ id: 'g2', name: 'Въезд 2' }], text: 'Фура → Въезд 2' },
  quotas: [
    {
      quotaId: 'q1',
      name: 'Грузовые',
      occupied: 25,
      capacity: 25,
      enforcement: 'hard',
      text: 'Грузовые 25/25 — машина будет ждать',
    },
  ],
  approval: { mode: 'on_request', text: 'Уйдёт на согласование' },
  commentRequired: false,
  dock: { required: true, docks: [{ id: 'd1', number: '1' }], text: 'Ваши доки: 1–18, 66–72' },
  window: { required: true, autoFilled: false, earlyToleranceMin: 0, lateToleranceMin: 60 },
  pedestrianRule: null,
  categories: [],
  passTypes: [],
  notices: [],
  ...over,
});

describe('подсказки формы пропуска до сохранения', () => {
  it('показывает КПП, лимит, согласование, док и окно; полный лимит и согласование — предупреждением', () => {
    render(<PassHintsPanel hints={hints()} loading={false} />);
    const panel = screen.getByTestId('hints');
    expect(within(panel).getByText('Фура → Въезд 2')).toBeInTheDocument();
    expect(within(panel).getByText('Грузовые 25/25 — машина будет ждать')).toHaveAttribute(
      'data-tone',
      'warning',
    );
    expect(within(panel).getByText('Уйдёт на согласование')).toHaveAttribute(
      'data-tone',
      'warning',
    );
    expect(within(panel).getByText('Укажите док. Ваши доки: 1–18, 66–72')).toBeInTheDocument();
    expect(within(panel).getByText(/Окно прибытия обязательно/)).toBeInTheDocument();
  });

  it('свободный лимит и согласование не нужно — спокойным тоном', () => {
    render(
      <PassHintsPanel
        hints={hints({
          quotas: [
            {
              quotaId: 'q1',
              name: 'Грузовые',
              occupied: 24,
              capacity: 25,
              enforcement: 'hard',
              text: 'Грузовые 24/25',
            },
          ],
          approval: { mode: 'allow', text: 'Без согласования — пропуск начнёт действовать сразу' },
        })}
        loading={false}
      />,
    );
    expect(screen.getByText('Грузовые 24/25')).toHaveAttribute('data-tone', 'info');
    expect(screen.getByText(/Без согласования/)).toHaveAttribute('data-tone', 'info');
  });

  it('блокировка, договор и чёрный список — заметными уведомлениями с кодом', () => {
    render(
      <PassHintsPanel
        hints={hints({
          notices: [
            {
              code: 'tenant_blocked',
              severity: 'error',
              text: 'Пропуск не оформлен: арендатор заблокирован полностью.',
            },
            {
              code: 'blacklisted',
              severity: 'warning',
              text: 'Этот номер в чёрном списке объекта.',
            },
          ],
        })}
        loading={false}
      />,
    );
    expect(screen.getByTestId('notice-tenant_blocked')).toHaveTextContent('заблокирован полностью');
    expect(screen.getByTestId('notice-blacklisted')).toHaveTextContent('чёрном списке');
  });

  it('пока подсказки не пришли — полоски загрузки, а не пустая панель', () => {
    render(<PassHintsPanel hints={undefined} loading />);
    expect(screen.getByRole('status', { name: 'Загрузка подсказок' })).toBeInTheDocument();
  });
});
