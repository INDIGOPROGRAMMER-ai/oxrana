import {
  Button,
  downloadFile,
  ErrorAlert,
  type ErrorView,
  errorView,
  Select,
  useToast,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { ChevronDown, Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMe } from '../lib/data';
import { exportBlockedReason } from '../lib/export-access';

type Format = 'xlsx' | 'csv';

/**
 * «Выгрузить» (7b.1, 7b.2): все строки по текущему фильтру, а не только показанная страница. Формат —
 * XLSX или CSV. Без права «Выгрузка отчётов» кнопка неактивна и говорит почему (CLAUDE.md).
 *
 * Два вида. `menu` — на компьютере: заметная кнопка «Выгрузить в Excel» рядом с поиском, формат
 * выбирается в меню («Excel (.xlsx)» и «CSV»). `panel` — на телефоне, в панели «Фильтры»: список
 * формата и кнопка в одну строку, как раньше.
 */
export function ExportButton({
  path,
  params,
  fileLabel,
  disabledReason,
  variant = 'menu',
}: {
  /** Адрес выгрузки без параметров: `/sites/{id}/passes/export`. */
  path: string;
  /** Текущий фильтр списка — те же параметры, что у самого списка (без порции). */
  params: URLSearchParams;
  /** Для подписи и сообщения: «пропуска», «на территории». */
  fileLabel: string;
  disabledReason?: string | undefined;
  variant?: 'menu' | 'panel';
}) {
  const { can } = useMe();
  const toast = useToast();
  const [format, setFormat] = useState<Format>('xlsx');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const blocked = exportBlockedReason(can);
  const reason = blocked?.text ?? disabledReason ?? null;

  // меню закрывается по клику вне него и по Escape
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !box.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  async function run(chosen: Format) {
    setBusy(true);
    setOpen(false);
    setError(null);
    try {
      const query = new URLSearchParams(params);
      query.set('format', chosen);
      const name = await downloadFile(`${path}?${query.toString()}`, `${fileLabel}.${chosen}`);
      toast(`Файл «${name}» выгружен: все строки по текущему фильтру`);
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  const tooltip = reason ?? `Выгрузить все строки по текущему фильтру (${fileLabel})`;
  const blockedNote = blocked ? (
    <p className="text-xs text-warning" data-testid="export-blocked">
      {blocked.text}{' '}
      {blocked.rolesLink ? (
        <Link to="/admin/roles" className="font-medium underline">
          Настроить роли
        </Link>
      ) : (
        'Права выдаёт администратор объекта.'
      )}
    </p>
  ) : null;

  if (variant === 'panel') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Select
            aria-label="Формат файла"
            value={format}
            disabled={reason !== null || busy}
            onChange={(e) => setFormat(e.target.value as Format)}
            className="h-9 w-24"
          >
            <option value="xlsx">XLSX</option>
            <option value="csv">CSV</option>
          </Select>
          <Button
            variant="outline"
            disabled={reason !== null || busy}
            title={tooltip}
            onClick={() => void run(format)}
            data-testid="export-button"
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
            Выгрузить
          </Button>
        </div>
        {blockedNote}
        <ErrorAlert error={error} />
      </div>
    );
  }

  return (
    <div ref={box} className="relative space-y-1">
      <Button
        variant="outline"
        disabled={reason !== null || busy}
        title={tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="export-button"
      >
        {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
        Выгрузить в Excel
        <ChevronDown aria-hidden className="size-4" />
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Формат файла"
          className="absolute right-0 z-30 mt-1 w-56 rounded-md border bg-popover p-1 shadow-md"
        >
          {(
            [
              ['xlsx', 'Excel (.xlsx)'],
              ['csv', 'CSV'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitem"
              data-testid={`export-${value}`}
              className="flex w-full items-center rounded-sm px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => void run(value)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {blockedNote}
      <ErrorAlert error={error} />
    </div>
  );
}
