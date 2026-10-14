import type { PassBatchResultSchema, PassType } from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  DateInput,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  Select,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
} from '@oxrana/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import { useRefresh } from '../../lib/data';
import {
  type BatchLine,
  type BatchSettings,
  batchDraft,
  parseBatchRows,
} from '../../lib/pass-batch';
import { PASS_TYPE_LABEL } from '../../lib/pass-text';
import { useAutoPreview } from '../../lib/use-auto-preview';
import { useCabinet } from './cabinet-context';
import type { PassHints } from './pass-hints-panel';

type BatchResult = z.infer<typeof PassBatchResultSchema>;

const PLACEHOLDER = `А123ВС174\tфура\tVolvo\tИванов И. И.\t12:00-14:00\tразгрузка\t12
В456НР174\tлегковой\tKia\t\t\t`;

/**
 * Пакетный ввод пропусков (08_ «Пакетный ввод»): вставка строк из Excel или письма, разные типы
 * транспорта в одной пачке, проверка **сама при вводе** (зелёные строки и красные с причиной), итог
 * «создано N из M» со списком ошибок. Ничего не сохраняется, пока человек не нажмёт одну кнопку.
 */
export function PassBatch() {
  const { tenant, ctx, serverNow } = useCabinet();
  const refresh = useRefresh();
  const textId = useId();
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<BatchSettings>({
    passType: 'single',
    date: ctx?.today ?? '',
    from: ctx?.today ?? '',
    to: '',
    comment: '',
  });
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<ErrorView | null>(null);
  const [done, setDone] = useState<{
    summary: string;
    errors: { line: number; plate: string; message: string }[];
  } | null>(null);

  const hints = useQuery({
    queryKey: ['hints', tenant?.id, 'batch'],
    queryFn: () =>
      api<PassHints>(`/tenants/${tenant?.id}/pass-hints`, {
        method: 'POST',
        body: { participant: 'vehicle' },
      }),
    enabled: Boolean(tenant),
  });
  const passTypes = hints.data?.passTypes ?? [];

  const catalog = useMemo(
    () => ({
      categories: (ctx?.categories ?? []).filter((c) => c.available),
      docks: ctx?.docks ?? [],
      defaultCategoryId: ctx?.tenant.defaultCategoryId ?? null,
    }),
    [ctx],
  );
  const parsed = useMemo(
    () => (text.trim() === '' ? [] : parseBatchRows(text, catalog)),
    [text, catalog],
  );

  // Строки для сервера: «сейчас» фиксируется при смене ввода, чтобы проверка не перезапускалась сама.
  const prepared = useMemo(() => {
    if (!ctx)
      return {
        rows: [],
        drafts: [] as Record<string, unknown>[],
        errors: new Map<number, string>(),
      };
    const nowMs = serverNow();
    const drafts: Record<string, unknown>[] = [];
    const rows: { line: number; value: BatchLine }[] = [];
    const errors = new Map<number, string>();
    for (const row of parsed) {
      if (!row.value) continue;
      const built = batchDraft(row.value, settings, {
        timezone: ctx.site.timezone,
        today: ctx.today,
        nowMs,
      });
      if (built.ok) {
        rows.push({ line: row.line, value: row.value });
        drafts.push(built.draft);
      } else {
        errors.set(row.line, built.error);
      }
    }
    return { rows, drafts, errors };
  }, [parsed, settings, ctx]);

  const preview = useAutoPreview<BatchResult>({
    path: '/passes/batch',
    body:
      tenant && prepared.drafts.length > 0 ? { tenantId: tenant.id, rows: prepared.drafts } : null,
    delayMs: 450,
  });

  if (!ctx || !tenant) return null;

  const serverErrors = new Map<number, string>();
  const rowInfo = new Map<number, { warnings: string[]; waits: boolean }>();
  if (preview.result) {
    for (const e of preview.result.errors) {
      const line = prepared.rows[e.row - 1]?.line;
      if (line !== undefined) serverErrors.set(line, e.message);
    }
    for (const p of preview.result.passes) {
      const line = prepared.rows[p.row - 1]?.line;
      if (line !== undefined) {
        rowInfo.set(line, {
          warnings: p.warnings.map((w) => w.message),
          waits: p.status === 'pending_approval',
        });
      }
    }
  }
  const errorOf = (line: number, local?: string) =>
    local ?? prepared.errors.get(line) ?? serverErrors.get(line);
  const checking =
    preview.status === 'checking' || (prepared.drafts.length > 0 && preview.status === 'idle');
  const okLines = parsed.filter((r) => r.value && !errorOf(r.line, r.error)).length;
  const badLines = parsed.length - okLines;
  const ready = okLines > 0 && !checking && preview.status === 'ready' && !committing;

  async function commit() {
    if (!ctx || !tenant) return;
    setCommitting(true);
    setCommitError(null);
    try {
      // время «сейчас» берётся заново: между проверкой и нажатием могло пройти время
      const nowMs = serverNow();
      const rows: { line: number; draft: Record<string, unknown> }[] = [];
      for (const row of prepared.rows) {
        if (serverErrors.has(row.line)) continue;
        const built = batchDraft(row.value, settings, {
          timezone: ctx.site.timezone,
          today: ctx.today,
          nowMs,
        });
        if (built.ok) rows.push({ line: row.line, draft: built.draft });
      }
      const result = await api<BatchResult>('/passes/batch', {
        method: 'POST',
        body: { tenantId: tenant.id, rows: rows.map((r) => r.draft) },
      });
      // Итог по всем вставленным строкам: что не прошло ещё до отправки и что отклонил сервер.
      const plateOf = (line: number) =>
        prepared.rows.find((r) => r.line === line)?.value.plate ?? '';
      const errors: { line: number; plate: string; message: string }[] = [];
      for (const row of parsed) {
        const early = row.error ?? prepared.errors.get(row.line) ?? serverErrors.get(row.line);
        if (early) errors.push({ line: row.line, plate: plateOf(row.line), message: early });
      }
      for (const e of result.errors) {
        const line = rows[e.row - 1]?.line;
        if (line !== undefined) errors.push({ line, plate: plateOf(line), message: e.message });
      }
      errors.sort((x, y) => x.line - y.line);
      // строки с ошибками остаются в поле — их можно исправить и отправить ещё раз
      const failed = new Set(errors.map((e) => e.line));
      const sourceLines = text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter((l) => l.trim() !== '');
      setDone({ summary: `Создано ${result.created} из ${parsed.length}`, errors });
      setText(sourceLines.filter((_, index) => failed.has(index + 1)).join('\n'));
      await refresh();
    } catch (raw) {
      setCommitError(errorView(raw));
    } finally {
      setCommitting(false);
    }
  }

  const typeLabel = (t: PassType) =>
    `${PASS_TYPE_LABEL[t]} — ${passTypes.find((p) => p.passType === t)?.mode === 'on_request' ? 'уйдёт на согласование' : 'без согласования'}`;

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <Field label="Тип пропуска" required>
            <Select
              value={settings.passType}
              onChange={(e) => setSettings({ ...settings, passType: e.target.value as PassType })}
            >
              {passTypes.length === 0 ? <option value={settings.passType}>Загрузка…</option> : null}
              {passTypes.map((t) => (
                <option key={t.passType} value={t.passType}>
                  {typeLabel(t.passType)}
                </option>
              ))}
            </Select>
          </Field>
          {settings.passType === 'single' ? (
            <Field label="Дата приезда" required hint={`Время объекта: ${ctx.site.timezoneLabel}`}>
              <DateInput
                value={settings.date}
                todayIso={ctx.today}
                onChange={(date) => setSettings({ ...settings, date })}
              />
            </Field>
          ) : (
            <>
              <Field label="Действует с" required>
                <DateInput
                  value={settings.from}
                  todayIso={ctx.today}
                  onChange={(from) => setSettings({ ...settings, from })}
                />
              </Field>
              {settings.passType === 'multi' ? (
                <Field label="Действует по" required hint="Последний день включительно.">
                  <DateInput
                    value={settings.to}
                    todayIso={ctx.today}
                    onChange={(to) => setSettings({ ...settings, to })}
                  />
                </Field>
              ) : null}
            </>
          )}
          {settings.passType !== 'single' ? (
            <Field
              label="Общий комментарий"
              hint="Для строк без своего комментария. У многоразовых и постоянных пропусков он обязателен."
              className="sm:col-span-2"
            >
              <Textarea
                rows={2}
                value={settings.comment}
                onChange={(e) => setSettings({ ...settings, comment: e.target.value })}
              />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-1.5">
        <label htmlFor={textId} className="text-sm font-medium">
          Вставьте строки из Excel или письма
        </label>
        <Textarea
          id={textId}
          rows={7}
          value={text}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          className="font-mono"
          onChange={(e) => {
            setText(e.target.value);
            setDone(null);
          }}
        />
        <p className="text-xs text-muted-foreground">
          Колонки: Номер · Тип · Марка · Водитель · Окно · Комментарий · Док. Разделитель — Tab (из
          Excel) или «;». Типы транспорта могут быть разными в одной пачке; пробелы в номерах не
          мешают. Доступные типы: {catalog.categories.map((c) => c.name).join(', ') || '—'}.
        </p>
      </div>

      {parsed.length > 0 ? (
        <div className="space-y-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={okLines > 0 ? 'success' : 'neutral'} data-testid="batch-ok">
              Будет создано {okLines}
            </Badge>
            <Badge tone={badLines > 0 ? 'danger' : 'neutral'} data-testid="batch-bad">
              Ошибки в {badLines}
            </Badge>
            {checking ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 aria-hidden className="size-3 animate-spin" /> проверяем…
              </span>
            ) : null}
          </div>
          <ErrorAlert error={preview.error} />
          <Table>
            <THead>
              <TR>
                <TH className="w-10">№</TH>
                <TH className="w-8" />
                <TH>Номер</TH>
                <TH>Тип</TH>
                <TH>Марка · водитель</TH>
                <TH>Окно</TH>
                <TH>Замечание</TH>
              </TR>
            </THead>
            <TBody>
              {parsed.slice(0, 200).map((row) => {
                const error = errorOf(row.line, row.error);
                const info = rowInfo.get(row.line);
                const remark = error
                  ? error
                  : [
                      ...(info?.waits ? ['уйдёт на согласование'] : []),
                      ...(row.note ? [row.note] : []),
                      ...(info?.warnings ?? []),
                    ].join(' · ');
                const warn = !error && (info?.warnings.length ?? 0) > 0;
                return (
                  <TR key={row.line} data-status={error ? 'error' : 'ok'}>
                    <TD className="text-muted-foreground">{row.line}</TD>
                    <TD>
                      {error ? (
                        <TriangleAlert aria-label="ошибка" className="size-4 text-destructive" />
                      ) : (
                        <CheckCircle2
                          aria-label={warn ? 'есть предупреждение' : 'готово'}
                          className={warn ? 'size-4 text-warning' : 'size-4 text-success'}
                        />
                      )}
                    </TD>
                    <TD className="font-mono">{row.value?.plate ?? '—'}</TD>
                    <TD>{row.value?.categoryName ?? '—'}</TD>
                    <TD>
                      {[row.value?.brand, row.value?.driverName].filter(Boolean).join(' · ') || '—'}
                    </TD>
                    <TD>{row.value?.windowText || '—'}</TD>
                    <TD
                      className={
                        error ? 'text-destructive' : warn ? 'text-warning' : 'text-muted-foreground'
                      }
                    >
                      {remark}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      ) : null}

      <ErrorAlert error={commitError} />
      {done ? (
        <Alert
          tone={done.errors.length > 0 ? 'warning' : 'success'}
          title={`${done.summary}${done.errors.length > 0 ? `, ${done.errors.length} с ошибками` : ''}`}
          data-testid="batch-done"
        >
          {done.errors.length > 0 ? (
            <>
              <ul className="list-disc pl-4">
                {done.errors.map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    строка {e.line}
                    {e.plate ? ` (${e.plate})` : ''}: {e.message}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                Строки с ошибками оставлены в поле выше — исправьте и отправьте ещё раз.
              </p>
            </>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" disabled={!ready} onClick={() => void commit()}>
          {committing ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Создать пропуска: {okLines}
        </Button>
        {parsed.length > 0 && okLines === 0 && !checking ? (
          <span className="text-xs text-muted-foreground">
            Нечего создавать — исправьте ошибки.
          </span>
        ) : null}
      </div>
    </div>
  );
}
