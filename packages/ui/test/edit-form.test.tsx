import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, EditForm, Field, Input, Select, useEditForm } from '../src';

interface Values {
  name: string;
  phone: string;
  kind: string;
}
const LOADED: Values = { name: 'Склад', phone: '+7 900 000-00-00', kind: 'a' };
const Schema = z.strictObject({
  name: z.string().min(1, 'Заполните название').optional(),
  phone: z.string().optional(),
  kind: z.string().optional(),
});

function Harness({
  values,
  onPatch,
}: {
  values: Values | undefined;
  onPatch: (patch: Partial<Values>) => Promise<unknown>;
}) {
  const form = useEditForm<Values>({ values, schema: Schema, onPatch });
  return (
    <EditForm form={form}>
      <Field label="Название" error={form.fieldError('name')}>
        <Input {...form.form.register('name')} />
      </Field>
      <Field label="Телефон" error={form.fieldError('phone')}>
        <Input {...form.form.register('phone')} />
      </Field>
      <Field label="Вид">
        <Select {...form.form.register('kind')}>
          <option value="a">А</option>
          <option value="b">Б</option>
        </Select>
      </Field>
    </EditForm>
  );
}

describe('форма правки (CLAUDE.md п. 5)', () => {
  it('пока данные не загружены — поля скрыты за полосками, форма заблокирована, отправить нельзя', () => {
    render(<Harness values={undefined} onPatch={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Загрузка' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Название')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(screen.getByRole('group')).toBeDisabled();
  });

  it('после загрузки поля заполнены записью, без изменений кнопка неактивна и запрос не уходит', async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<Harness values={undefined} onPatch={onPatch} />);
    rerender(<Harness values={LOADED} onPatch={onPatch} />);
    expect(await screen.findByLabelText('Название')).toHaveValue('Склад');
    expect(screen.getByLabelText('Вид')).toHaveValue('a');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    expect(screen.getByText('Изменений нет')).toBeInTheDocument();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('отправляет PATCH только с изменёнными полями', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<Harness values={LOADED} onPatch={onPatch} />);
    await user.clear(screen.getByLabelText('Название'));
    await user.type(screen.getByLabelText('Название'), 'Склад № 2');
    await user.selectOptions(screen.getByLabelText('Вид'), 'b');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch).toHaveBeenCalledWith({ name: 'Склад № 2', kind: 'b' });
  });

  it('возврат поля к прежнему значению снимает изменение', async () => {
    const user = userEvent.setup();
    render(<Harness values={LOADED} onPatch={vi.fn()} />);
    const phone = screen.getByLabelText('Телефон');
    await user.type(phone, '1');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    await user.type(phone, '{Backspace}');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('«Сохранено» — только после ответа сервера; ошибка сервера у поля со ссылкой на настройку', async () => {
    const user = userEvent.setup();
    const onPatch = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(422, {
          code: 'validation_failed',
          message: 'Телефон указан неверно. Проверьте номер.',
          field: 'phone',
          settingLink: '/admin/tenants/1',
        }),
      )
      .mockResolvedValueOnce(undefined);
    render(<Harness values={LOADED} onPatch={onPatch} />);
    await user.type(screen.getByLabelText('Телефон'), '5');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Телефон указан неверно');
    expect(screen.getByRole('link', { name: 'Перейти к настройке' })).toHaveAttribute(
      'href',
      '/admin/tenants/1',
    );
    expect(screen.queryByText('Сохранено')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Телефон')).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
  });

  it('клиентская проверка схемой PATCH не пускает пустое название до запроса', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn();
    render(<Harness values={LOADED} onPatch={onPatch} />);
    await user.clear(screen.getByLabelText('Название'));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Заполните название')).toBeInTheDocument();
    expect(onPatch).not.toHaveBeenCalled();
  });
});
