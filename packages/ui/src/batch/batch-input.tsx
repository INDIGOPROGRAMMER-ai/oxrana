import type { BatchResult, ParsedRow } from '@oxrana/contracts';
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type ErrorView, errorView } from '../api';
import { Alert, ErrorAlert } from '../components/alert';
import { Badge } from '../components/badge';
import { Button } from '../components/button';
import { Textarea } from '../components/inputs';
import { Table, TBody, TD, TH, THead, TR } from '../components/table';
import { FileDrop } from './file-drop';

export interface BatchColumn<T> {
  readonly header: string;
  readonly render: (value: T) => ReactNode;
}

const SHOWN_ROWS = 200;

/**
 * Пакетный ввод (CLAUDE.md, «Правила интерфейса»): вставка списка из Excel (или файл .xlsx/.csv/.tsv/.txt),
 * предпросмотр «добавится N, ошибки в M» ещё до сохранения. Разбор текста локальный и мгновенный;
 * если задан `check`, допустимые строки сверх того проверяет сервер (повторы, существующие записи) —
 * тем же путём, что и сохранение. «Добавить» доступно, когда есть что добавлять и проверка закончилась.
 */
export function BatchInput<T>({
  label,
  placeholder,
  help,
  parse,
  columns,
  check,
  checkKey = '',
  commit,
  commitLabel = (n: number) => `Добавить ${n}`,
  onDone,
  rows = 6,
}: {
  label: string;
  placeholder?: string;
  /** Формат ввода: «Краткое название · Полное название · ИНН». */
  help?: ReactNode;
  parse: (text: string) => ParsedRow<T>[];
  columns: readonly BatchColumn<T>[];
  /** Проверка сервером без сохранения (`dryRun`). Номера строк в ответе — по допустимым строкам. */
  check?: (values: T[]) => Promise<BatchResult>;
  /** Меняется, когда меняются внешние параметры проверки (зона, вид): проверка повторяется. */
  checkKey?: string;
  commit: (values: T[]) => Promise<BatchResult>;
  commitLabel?: (count: number) => string;
  onDone?: (result: BatchResult) => void;
  rows?: number;
}) {
  const inputId = useId();
  const [fileError, setFileError] = useState('');
  const [text, setText] = useState('');
  const checkRef = useRef(check);
  checkRef.current = check;
  const stamp = `${checkKey}\u0000${text}`;
  const [serverCheck, setServerCheck] = useState<{
    text: string;
    result: BatchResult | null;
    error: ErrorView | null;
  } | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<ErrorView | null>(null);
  const [done, setDone] = useState<BatchResult | null>(null);

  const parsed = useMemo(() => (text.trim() === '' ? [] : parse(text)), [parse, text]);
  const valid = parsed.filter((r): r is ParsedRow<T> & { value: T } => r.value !== undefined);
  const localErrors = parsed.length - valid.length;

  // Проверка сервером: после паузы в наборе, только если локально есть что проверять.
  const checking = Boolean(check) && valid.length > 0 && serverCheck?.text !== stamp;
  useEffect(() => {
    const run = checkRef.current;
    if (!run || valid.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      run(valid.map((r) => r.value))
        .then((result) => !cancelled && setServerCheck({ text: stamp, result, error: null }))
        .catch(
          (e: unknown) =>
            !cancelled && setServerCheck({ text: stamp, result: null, error: errorView(e) }),
        );
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // проверка повторяется только при смене текста или внешних параметров (`checkKey`)
  }, [stamp]);

  const current = serverCheck?.text === stamp ? serverCheck : null;
  const serverErrors = new Map<number, string>();
  for (const e of current?.result?.errors ?? []) {
    const row = valid[e.row - 1];
    if (row) serverErrors.set(row.line, e.message);
  }
  const addable = valid.length - serverErrors.size;
  const errorCount = localErrors + serverErrors.size;
  const ready = addable > 0 && !checking && !current?.error && !committing;

  async function onCommit() {
    setCommitting(true);
    setCommitError(null);
    try {
      const sendable = valid.filter((r) => !serverErrors.has(r.line)).map((r) => r.value);
      const result = await commit(sendable);
      setDone(result);
      setText('');
      setServerCheck(null);
      onDone?.(result);
    } catch (e) {
      setCommitError(errorView(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        <Textarea
          id={inputId}
          rows={rows}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          className="font-mono"
          onChange={(e) => {
            setText(e.target.value);
            setDone(null);
          }}
        />
        {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
        <FileDrop
          onText={(loaded) => {
            setText(loaded);
            setDone(null);
          }}
          onError={setFileError}
        />
        {fileError ? (
          <p role="alert" className="text-xs text-destructive">
            {fileError}
          </p>
        ) : null}
      </div>

      {parsed.length > 0 ? (
        <div className="space-y-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={addable > 0 ? 'success' : 'neutral'}>Добавится {addable}</Badge>
            <Badge tone={errorCount > 0 ? 'danger' : 'neutral'}>Ошибки в {errorCount}</Badge>
            {checking ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 aria-hidden className="size-3 animate-spin" /> проверяем на сервере…
              </span>
            ) : null}
          </div>
          {current?.error ? <ErrorAlert error={current.error} /> : null}
          <Table>
            <THead>
              <TR>
                <TH className="w-10">№</TH>
                <TH className="w-8" />
                {columns.map((c) => (
                  <TH key={c.header}>{c.header}</TH>
                ))}
                <TH>Замечание</TH>
              </TR>
            </THead>
            <TBody>
              {parsed.slice(0, SHOWN_ROWS).map((row) => {
                const error = row.error ?? serverErrors.get(row.line);
                return (
                  <TR key={row.line} data-status={error ? 'error' : 'ok'}>
                    <TD className="text-muted-foreground">{row.line}</TD>
                    <TD>
                      {error ? (
                        <TriangleAlert aria-label="ошибка" className="size-4 text-destructive" />
                      ) : (
                        <CheckCircle2 aria-label="готово" className="size-4 text-success" />
                      )}
                    </TD>
                    {columns.map((c) => (
                      <TD key={c.header}>{row.value !== undefined ? c.render(row.value) : '—'}</TD>
                    ))}
                    <TD className={error ? 'text-destructive' : 'text-muted-foreground'}>
                      {error ?? row.note ?? ''}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          {parsed.length > SHOWN_ROWS ? (
            <p className="text-xs text-muted-foreground">
              …и ещё {parsed.length - SHOWN_ROWS} строк (ошибки учтены в итоге выше)
            </p>
          ) : null}
        </div>
      ) : null}

      <ErrorAlert error={commitError} />
      {done ? (
        <Alert tone={done.errors.length > 0 ? 'warning' : 'success'} title={done.summary}>
          {done.errors.length > 0 ? (
            <ul className="list-disc pl-4">
              {done.errors.slice(0, 20).map((e) => (
                <li key={`${e.row}-${e.message}`}>
                  строка {e.row}: {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex items-center gap-3">
        <Button disabled={!ready} onClick={() => void onCommit()}>
          {committing ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {commitLabel(Math.max(addable, 0))}
        </Button>
        {parsed.length > 0 && addable === 0 && !checking ? (
          <span className="text-xs text-muted-foreground">Нечего добавлять — исправьте ошибки</span>
        ) : null}
      </div>
    </div>
  );
}
