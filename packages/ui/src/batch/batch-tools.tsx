import { Download, Scissors } from 'lucide-react';
import { Alert } from '../components/alert';
import { Button } from '../components/button';
import { buildXlsx } from './spreadsheet';

/** Сохранить байты как файл через временную ссылку (шаблон для Excel строится прямо в браузере). */
export function saveBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * «Скачать шаблон для Excel»: файл с одной строкой заголовков — ровно теми колонками, которые принимает
 * этот пакетный ввод (из настройки формы). Заполнить и перетащить обратно.
 */
export function BatchTemplateButton({ fileName, titles }: { fileName: string; titles: string[] }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="batch-template"
      onClick={() => saveBytes(fileName, buildXlsx([titles], 'Пакет'), XLSX_MIME)}
    >
      <Download aria-hidden /> Скачать шаблон для Excel
    </Button>
  );
}

/** Предложение поправить вставленное одной кнопкой («Похоже, в строке 55 номеров — разбить?»). */
export function BatchSuggestion({
  message,
  actionLabel = 'Разбить по строкам',
  onApply,
}: {
  message: string;
  actionLabel?: string;
  onApply: () => void;
}) {
  return (
    <Alert tone="warning" data-testid="batch-suggestion">
      <div className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        <Button type="button" size="sm" onClick={onApply} data-testid="batch-suggestion-apply">
          <Scissors aria-hidden /> {actionLabel}
        </Button>
      </div>
    </Alert>
  );
}
