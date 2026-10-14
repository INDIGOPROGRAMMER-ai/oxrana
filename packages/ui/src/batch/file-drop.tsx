import { FileUp } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../lib/cn';
import { BATCH_FILE_ACCEPT, fileToText } from './spreadsheet';

/**
 * Загрузка файла со списком (.xlsx, .csv): перетащить или выбрать — и на компьютере, и на телефоне.
 * Файл превращается в текст, как будто его вставили из Excel (`onText`); понятная ошибка — `onError`.
 */
export function FileDrop({
  onText,
  onError,
  label = 'Перетащите файл .xlsx или .csv сюда или выберите',
  className,
}: {
  onText: (text: string, fileName: string) => void;
  onError?: (message: string) => void;
  label?: string;
  className?: string;
}) {
  const id = useId();
  const [over, setOver] = useState(false);
  const [name, setName] = useState<string | null>(null);

  async function take(file: File | undefined) {
    if (!file) return;
    try {
      onText(await fileToText(file), file.name);
      setName(file.name);
      onError?.('');
    } catch (e) {
      setName(null);
      onError?.(e instanceof Error ? e.message : 'Не удалось прочитать файл.');
    }
  }

  return (
    <label
      htmlFor={id}
      data-testid="file-drop"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void take(e.dataTransfer.files[0]);
      }}
      className={cn(
        'flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed px-3 py-3 text-center text-sm text-muted-foreground transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring',
        over && 'border-primary bg-accent text-foreground',
        className,
      )}
    >
      <FileUp aria-hidden className="size-5 shrink-0" />
      <span>{name ? `Загружен файл «${name}». Загрузить другой` : label}</span>
      <input
        id={id}
        type="file"
        accept={BATCH_FILE_ACCEPT}
        className="sr-only"
        aria-label="Файл со списком"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </label>
  );
}
