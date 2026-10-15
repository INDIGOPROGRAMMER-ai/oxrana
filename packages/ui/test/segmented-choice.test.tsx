import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SegmentedChoice } from '../src';

const OPTIONS = [
  { value: 'single', label: 'Разовый' },
  { value: 'multi', label: 'Многоразовый' },
  { value: 'permanent', label: 'Постоянный' },
] as const;

function Harness({ initial = 'single' }: { initial?: 'single' | 'multi' | 'permanent' }) {
  const [value, setValue] = useState<'single' | 'multi' | 'permanent'>(initial);
  return (
    <SegmentedChoice
      options={OPTIONS}
      value={value}
      onChange={setValue}
      aria-label="Вид пропуска"
    />
  );
}

describe('SegmentedChoice', () => {
  it('кнопки рядом, выбранная отмечена сразу, один щелчок меняет выбор', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('radio', { name: 'Разовый' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Многоразовый' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await user.click(screen.getByRole('radio', { name: 'Постоянный' }));
    expect(screen.getByRole('radio', { name: 'Постоянный' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Разовый' })).toHaveAttribute('aria-checked', 'false');
  });

  it('стрелки переключают значение', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('radio', { name: 'Разовый' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Многоразовый' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
