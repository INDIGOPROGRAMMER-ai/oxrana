import { type BatchResult, parseTenantRows, type TenantDraft } from '@oxrana/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BatchInput } from '../src';

const columns = [
  { header: 'Краткое название', render: (v: TenantDraft) => v.shortName },
  { header: 'ИНН', render: (v: TenantDraft) => v.inn ?? '—' },
];

const result = (over: Partial<BatchResult> = {}): BatchResult => ({
  dryRun: false,
  total: 2,
  created: 2,
  summary: 'Добавлено 2 из 2',
  errors: [],
  ids: [null, null],
  ...over,
});

const PASTE = 'Альфа\tООО «Альфа»\t7700000001\nБета\nГамма\t\t123';

describe('пакетный ввод', () => {
  it('вставка из Excel: предпросмотр «добавится N, ошибки в M» до сохранения', async () => {
    const user = userEvent.setup();
    render(
      <BatchInput label="Арендаторы" parse={parseTenantRows} columns={columns} commit={vi.fn()} />,
    );
    await user.click(screen.getByLabelText('Арендаторы'));
    await user.paste(PASTE);
    expect(screen.getByText('Добавится 2')).toBeInTheDocument();
    expect(screen.getByText('Ошибки в 1')).toBeInTheDocument();
    expect(screen.getByText(/ИНН «123»/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добавить 2' })).toBeEnabled();
  });

  it('сохраняет только допустимые строки и показывает итог сервера', async () => {
    const user = userEvent.setup();
    const commit = vi.fn().mockResolvedValue(result({ summary: 'Добавлено 2 из 2' }));
    const onDone = vi.fn();
    render(
      <BatchInput
        label="Арендаторы"
        parse={parseTenantRows}
        columns={columns}
        commit={commit}
        onDone={onDone}
      />,
    );
    await user.click(screen.getByLabelText('Арендаторы'));
    await user.paste(PASTE);
    await user.click(screen.getByRole('button', { name: 'Добавить 2' }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0]?.[0]).toEqual([
      { shortName: 'Альфа', legalName: 'ООО «Альфа»', inn: '7700000001' },
      { shortName: 'Бета', legalName: 'Бета' },
    ]);
    expect(await screen.findByText('Добавлено 2 из 2')).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByLabelText('Арендаторы')).toHaveValue('');
  });

  it('ошибки проверки сервера (уже существует) учитываются в предпросмотре до сохранения', async () => {
    const user = userEvent.setup();
    const check = vi.fn().mockResolvedValue(
      result({
        dryRun: true,
        created: 1,
        errors: [
          {
            row: 1,
            field: 'shortName',
            code: 'conflict',
            message: 'Арендатор «Альфа» уже есть на объекте',
          },
        ],
      }),
    );
    render(
      <BatchInput
        label="Арендаторы"
        parse={parseTenantRows}
        columns={columns}
        check={check}
        commit={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Арендаторы'));
    await user.paste('Альфа\nБета');
    expect(await screen.findByText('Ошибки в 1')).toBeInTheDocument();
    expect(screen.getByText('Добавится 1')).toBeInTheDocument();
    expect(screen.getByText('Арендатор «Альфа» уже есть на объекте')).toBeInTheDocument();
    expect(check).toHaveBeenCalledWith([
      { shortName: 'Альфа', legalName: 'Альфа' },
      { shortName: 'Бета', legalName: 'Бета' },
    ]);
  });

  it('когда добавлять нечего — кнопка неактивна и сказано почему', async () => {
    const user = userEvent.setup();
    render(
      <BatchInput label="Арендаторы" parse={parseTenantRows} columns={columns} commit={vi.fn()} />,
    );
    await user.click(screen.getByLabelText('Арендаторы'));
    await user.paste('Гамма\t\t123');
    expect(screen.getByRole('button', { name: 'Добавить 0' })).toBeDisabled();
    expect(screen.getByText('Нечего добавлять — исправьте ошибки')).toBeInTheDocument();
  });
});
