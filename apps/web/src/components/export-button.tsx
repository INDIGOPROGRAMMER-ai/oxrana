import {
  Button,
  downloadFile,
  ErrorAlert,
  type ErrorView,
  errorView,
  Select,
  useToast,
} from '@oxrana/ui';
import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../lib/data';

/**
 * «Выгрузить» (7b.1): все строки по текущему фильтру, а не только показанная страница. Формат —
 * XLSX или CSV. Без права «Выгрузка отчётов» кнопка неактивна и говорит почему (CLAUDE.md).
 */
export function ExportButton({
  path,
  params,
  fileLabel,
  disabledReason,
}: {
  /** Адрес выгрузки без параметров: `/sites/{id}/passes/export`. */
  path: string;
  /** Текущий фильтр списка — те же параметры, что у самого списка (без порции). */
  params: URLSearchParams;
  /** Для подписи и сообщения: «пропуска», «на территории». */
  fileLabel: string;
  disabledReason?: string | undefined;
}) {
  const { can } = useMe();
  const toast = useToast();
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const allowed = can('report.export');
  const reason = !allowed
    ? 'У вашей роли нет права выгружать списки (право «Выгрузка отчётов»).'
    : (disabledReason ?? null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams(params);
      query.set('format', format);
      const name = await downloadFile(`${path}?${query.toString()}`, `${fileLabel}.${format}`);
      toast(`Файл «${name}» выгружен: все строки по текущему фильтру`);
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Select
          aria-label="Формат файла"
          value={format}
          disabled={reason !== null || busy}
          onChange={(e) => setFormat(e.target.value as 'xlsx' | 'csv')}
          className="h-9 w-24"
        >
          <option value="xlsx">XLSX</option>
          <option value="csv">CSV</option>
        </Select>
        <Button
          variant="outline"
          disabled={reason !== null || busy}
          title={reason ?? `Выгрузить все строки по текущему фильтру (${fileLabel})`}
          onClick={() => void run()}
          data-testid="export-button"
        >
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
          Выгрузить
        </Button>
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}
