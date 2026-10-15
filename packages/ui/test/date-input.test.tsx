import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  DateInput,
  DateTimeInput,
  isoToRuDate,
  maskDate,
  maskTime,
  maskTimeRange,
  monthGrid,
  parseRuDate,
  parseTime,
  parseTimeRange,
  TimeInput,
  TimeRangeInput,
} from '../src';

describe('маски даты и времени', () => {
  it('цифры превращаются в ДД.ММ.ГГГГ, точка не навязывается на границе', () => {
    expect(maskDate('1')).toBe('1');
    expect(maskDate('13')).toBe('13');
    expect(maskDate('131')).toBe('13.1');
    expect(maskDate('13102026')).toBe('13.10.2026');
    expect(maskDate('13.10.2026999')).toBe('13.10.2026');
    expect(maskDate('abc')).toBe('');
  });
  it('вставка ISO и других разделителей понимается', () => {
    expect(maskDate('2026-10-13')).toBe('13.10.2026');
    expect(maskDate('13/10/2026')).toBe('13.10.2026');
    expect(maskDate('13-10-2026')).toBe('13.10.2026');
  });
  it('разбор: только существующие даты', () => {
    expect(parseRuDate('13.10.2026')).toBe('2026-10-13');
    expect(parseRuDate('29.02.2028')).toBe('2028-02-29');
    expect(parseRuDate('29.02.2026')).toBeNull();
    expect(parseRuDate('31.04.2026')).toBeNull();
    expect(parseRuDate('13.13.2026')).toBeNull();
    expect(parseRuDate('13.10.26')).toBeNull();
    expect(parseRuDate('13.10.1899')).toBeNull();
    expect(isoToRuDate('2026-10-13')).toBe('13.10.2026');
    expect(isoToRuDate('')).toBe('');
  });
  it('время суток', () => {
    expect(maskTime('1430')).toBe('14:30');
    expect(maskTime('14')).toBe('14');
    expect(parseTime('14:30')).toBe('14:30');
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('1:30')).toBeNull();
  });
  it('время вводится только цифрами: двоеточие само, цифра, с которой час не начинается, получает нуль', () => {
    expect(maskTime('1200')).toBe('12:00');
    expect(maskTime('9')).toBe('09');
    expect(maskTime('930')).toBe('09:30');
    expect(maskTime('0930')).toBe('09:30');
    expect(maskTime('127')).toBe('12:07');
    expect(maskTime('12:00')).toBe('12:00');
    expect(maskTime('12-00')).toBe('12:00');
    expect(maskTime('1')).toBe('1');
    expect(maskTime('')).toBe('');
  });
  it('интервал: «12001400» → «12:00–14:00», тире подставляется само', () => {
    expect(maskTimeRange('1200')).toBe('12:00');
    expect(maskTimeRange('12001')).toBe('12:00–1');
    expect(maskTimeRange('12001400')).toBe('12:00–14:00');
    expect(maskTimeRange('9001400')).toBe('09:00–14:00');
    expect(maskTimeRange('900930')).toBe('09:00–09:30');
    expect(maskTimeRange('12:00-14:00')).toBe('12:00–14:00');
    expect(maskTimeRange('1200140099')).toBe('12:00–14:00');
    expect(parseTimeRange('12:00–14:00')).toEqual({ from: '12:00', to: '14:00' });
    expect(parseTimeRange('12:00-14:00')).toEqual({ from: '12:00', to: '14:00' });
    expect(parseTimeRange('12:00–25:00')).toBeNull();
    expect(parseTimeRange('12:00')).toBeNull();
  });
  it('сетка месяца начинается с понедельника', () => {
    const weeks = monthGrid(2026, 9); // октябрь 2026: 1 октября — четверг
    expect(weeks[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
  });
});

function DateHarness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <DateInput value={value} onChange={setValue} aria-label="Дата" todayIso="2026-10-13" />
      <output data-testid="value">{value}</output>
    </div>
  );
}

describe('DateInput', () => {
  it('показывает ДД.ММ.ГГГГ независимо от локали браузера и отдаёт ISO', async () => {
    const user = userEvent.setup();
    render(<DateHarness initial="2026-10-13" />);
    const input = screen.getByLabelText('Дата');
    expect(input).toHaveValue('13.10.2026');
    await user.clear(input);
    await user.type(input, '01032027');
    expect(input).toHaveValue('01.03.2027');
    expect(screen.getByTestId('value')).toHaveTextContent('2027-03-01');
  });

  it('неполная или несуществующая дата: наружу пусто, под полем подсказка о формате', async () => {
    const user = userEvent.setup();
    render(<DateHarness initial="2026-10-13" />);
    const input = screen.getByLabelText('Дата');
    await user.clear(input);
    await user.type(input, '3102026');
    expect(screen.getByTestId('value')).toHaveTextContent('');
    expect(screen.getByText(/Дата в формате ДД.ММ.ГГГГ/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '31042026');
    expect(screen.getByTestId('value')).toHaveTextContent('');
    expect(screen.getByText(/Дата в формате ДД.ММ.ГГГГ/)).toBeInTheDocument();
  });

  it('внешний сброс значения обновляет поле', async () => {
    const { rerender } = render(
      <DateInput value="2026-10-13" onChange={() => {}} aria-label="Дата" />,
    );
    expect(screen.getByLabelText('Дата')).toHaveValue('13.10.2026');
    rerender(<DateInput value="" onChange={() => {}} aria-label="Дата" />);
    expect(screen.getByLabelText('Дата')).toHaveValue('');
  });

  it('календарь: выбор дня и «Сегодня»', async () => {
    const user = userEvent.setup();
    render(<DateHarness initial="2026-10-13" />);
    await user.click(screen.getByRole('button', { name: 'Выбрать дату в календаре' }));
    expect(screen.getByRole('dialog', { name: 'Календарь' })).toBeInTheDocument();
    expect(screen.getByText('октябрь 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '20 октябрь 2026' }));
    expect(screen.getByLabelText('Дата')).toHaveValue('20.10.2026');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-20');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Выбрать дату в календаре' }));
    await user.click(screen.getByRole('button', { name: 'Следующий месяц' }));
    expect(screen.getByText('ноябрь 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Сегодня/ }));
    expect(screen.getByLabelText('Дата')).toHaveValue('13.10.2026');
  });
});

describe('TimeInput и DateTimeInput', () => {
  it('время вводится как ЧЧ:ММ', async () => {
    const user = userEvent.setup();
    let last = '';
    render(<TimeInput value="" onChange={(v) => (last = v)} aria-label="Время" />);
    await user.type(screen.getByLabelText('Время'), '0830');
    expect(screen.getByLabelText('Время')).toHaveValue('08:30');
    expect(last).toBe('08:30');
  });

  it('дата со временем: время подставляется видимо, значение — ГГГГ-ММ-ДДTЧЧ:ММ', async () => {
    const user = userEvent.setup();
    function Both() {
      const [value, setValue] = useState('');
      return (
        <div>
          <DateTimeInput value={value} onChange={setValue} defaultTime="23:59" />
          <output data-testid="value">{value}</output>
        </div>
      );
    }
    render(<Both />);
    await user.type(screen.getByLabelText('Дата'), '13102026');
    expect(screen.getByLabelText('Время')).toHaveValue('23:59');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-13T23:59');
    await user.clear(screen.getByLabelText('Время'));
    await user.type(screen.getByLabelText('Время'), '0900');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-13T09:00');
  });
});

function RangeHarness() {
  const [range, setRange] = useState({ from: '', to: '' });
  return (
    <div>
      <TimeRangeInput
        aria-label="Окно"
        from={range.from}
        to={range.to}
        onChange={(from, to) => setRange({ from, to })}
      />
      <output data-testid="range">{`${range.from}|${range.to}`}</output>
    </div>
  );
}

describe('TimeRangeInput', () => {
  it('набор «12001400» даёт «12:00–14:00» и значения обеих границ', async () => {
    const user = userEvent.setup();
    render(<RangeHarness />);
    const input = screen.getByLabelText('Окно');
    await user.type(input, '12001400');
    expect(input).toHaveValue('12:00–14:00');
    expect(screen.getByTestId('range')).toHaveTextContent('12:00|14:00');
  });

  it('пока интервал неполный, наружу уходит только готовая первая граница', async () => {
    const user = userEvent.setup();
    render(<RangeHarness />);
    const input = screen.getByLabelText('Окно');
    await user.type(input, '1200');
    expect(screen.getByTestId('range')).toHaveTextContent('12:00|');
    await user.clear(input);
    expect(screen.getByTestId('range')).toHaveTextContent('|');
  });
});

describe('TimeInput: набор цифр', () => {
  it('«1200» даёт «12:00», «930» — «09:30»', async () => {
    const user = userEvent.setup();
    function One() {
      const [v, setV] = useState('');
      return (
        <div>
          <TimeInput aria-label="Время" value={v} onChange={setV} />
          <output data-testid="v">{v}</output>
        </div>
      );
    }
    render(<One />);
    const input = screen.getByLabelText('Время');
    await user.type(input, '1200');
    expect(input).toHaveValue('12:00');
    expect(screen.getByTestId('v')).toHaveTextContent('12:00');
    await user.clear(input);
    await user.type(input, '930');
    expect(input).toHaveValue('09:30');
  });
});
