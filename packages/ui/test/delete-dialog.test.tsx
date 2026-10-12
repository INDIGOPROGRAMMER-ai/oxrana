import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DeleteDialog } from '../src';

describe('диалог мягкого удаления', () => {
  it('показывает, где используется, и требует подтверждения', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteDialog
        open
        onOpenChange={vi.fn()}
        title="Удалить КПП?"
        name="КПП «Въезд 1»"
        loadUsages={async () => [
          { table: 'routing_rules', label: 'правила маршрута', count: 4 },
          { table: 'gate_accounts', label: 'учётки КПП', count: 1 },
        ]}
        onDelete={onDelete}
      />,
    );
    const usages = await screen.findByTestId('usages');
    expect(usages).toHaveTextContent('правила маршрута — 4');
    expect(usages).toHaveTextContent('учётки КПП — 1');
    await user.click(screen.getByRole('button', { name: 'Всё равно удалить' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(true));
  });

  it('пока список не загружен, удалить нельзя; без ссылок — обычное удаление', async () => {
    let resolve: (u: []) => void = () => undefined;
    const pending = new Promise<[]>((r) => {
      resolve = r;
    });
    render(
      <DeleteDialog
        open
        onOpenChange={vi.fn()}
        title="Удалить зону?"
        name="Зона «Двор»"
        loadUsages={() => pending}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeDisabled();
    resolve([]);
    expect(await screen.findByText(/Нигде не используется/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeEnabled();
  });
});
