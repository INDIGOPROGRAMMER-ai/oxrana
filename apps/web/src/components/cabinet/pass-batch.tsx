import type { ParsedRow, PassBatchResultSchema, PassType } from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import {
  Alert,
  Badge,
  BatchSuggestion,
  BatchTemplateButton,
  Button,
  Card,
  CardContent,
  DateInput,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  FileDrop,
  formatLocalDate,
  Input,
  isoToRuDate,
  maskTimeRange,
  SegmentedChoice,
  Select,
  Textarea,
  TimeInput,
} from '@oxrana/ui';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import {
  columnsLabel,
  passBatchLayout,
  placeholderOf,
  templateTitles,
} from '../../lib/batch-columns';
import { ownTime } from '../../lib/batch-time';
import { useRefresh } from '../../lib/data';
import {
  type BatchRow,
  type BatchSettings,
  batchDraft,
  parseBatchRows,
  parseWindow,
  type RowFix,
} from '../../lib/pass-batch';
import { buildFormView } from '../../lib/pass-form-view';
import { PASS_TYPE_LABEL } from '../../lib/pass-text';
import {
  findMultiPlateLines,
  multiPlateQuestion,
  splitMultiPlateLines,
} from '../../lib/plate-split';
import { useAutoPreview } from '../../lib/use-auto-preview';
import { useCabinet } from './cabinet-context';
import type { PassHints } from './pass-hints-panel';

type BatchResult = z.infer<typeof PassBatchResultSchema>;
type Line = ParsedRow<BatchRow>;

const SHOWN_ROWS = 200;

/**
 * Пакетный ввод пропусков (08_ «Пакетный ввод»): файл .xlsx/.csv (перетащить или выбрать — на
 * компьютере и на телефоне) или вставка из Excel и письма. Номера приводятся к общему виду сами;
 * тип транспорта понимается без учёта регистра и с формами слова, неоднозначное не угадывается.
 * Проверка идёт **сама при вводе**, а ошибки правятся прямо в предпросмотре — тип, док, место,
 * время — и «применить ко всем без …». Ничего не сохраняется, пока человек не нажмёт одну кнопку.
 */
export function PassBatch() {
  const { tenant, ctx, passForm, serverNow } = useCabinet();
  const refresh = useRefresh();
  const textId = useId();
  const [text, setText] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [fileError, setFileError] = useState('');
  const [settings, setSettings] = useState<BatchSettings>({
    passType: 'single',
    date: ctx?.today ?? '',
    start: '',
    end: '',
    from: ctx?.today ?? '',
    to: '',
    comment: '',
  });
  // «Применить ко всем» перепишет своё время строк — сначала спрашиваем
  const [confirmApply, setConfirmApply] = useState(false);
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

  const view = useMemo(
    () =>
      ctx && passForm
        ? buildFormView({
            form: passForm.form,
            ctx,
            enforced: passForm.enforced,
            allowedPassTypes: hints.data?.passTypes.map((p) => p.passType),
            commentRequiredByPolicy: Boolean(hints.data?.commentRequired),
            dockRequired: false,
          })
        : null,
    [ctx, passForm, hints.data],
  );
  const passTypes = view?.passTypes ?? [];
  // вид пропуска, которого нет в форме, не выбирается: пачка идёт первым из доступных
  const passType: PassType = passTypes.includes(settings.passType)
    ? settings.passType
    : (view?.defaultPassType ?? settings.passType);
  const effective: BatchSettings = { ...settings, passType };

  const catalog = useMemo(
    () => ({
      categories: (view?.categories ?? []).map((c) => ({
        ...c,
        dockEligible: ctx?.categories.find((x) => x.id === c.id)?.dockEligible ?? false,
      })),
      docks: ctx?.docks ?? [],
      zones: ctx?.zones ?? [],
      defaultCategoryId: view?.defaultCategoryId || null,
    }),
    [ctx, view],
  );
  // колонки пакета — из той же действующей настройки формы, что и сама форма
  const layout = useMemo(
    () =>
      view
        ? passBatchLayout({
            fields: view.fields,
            hasDocks: view.docks.length > 0,
            zoneChoice: view.zones.length > 1,
          })
        : null,
    [view],
  );
  const needsDock = (categoryId: string) =>
    Boolean(
      ctx?.tenant.trucksDockRequired &&
        categoryId &&
        catalog.categories.find((c) => c.id === categoryId)?.dockEligible,
    );

  /** Подстановки «если вариант один»: единственное место, единственный док для грузового. */
  function withDefaults(row: BatchRow): BatchRow {
    let next = row;
    if (!next.zoneId && view?.defaultZoneId) next = { ...next, zoneId: view.defaultZoneId };
    if (!next.dockId && needsDock(next.categoryId) && catalog.docks.length === 1) {
      next = { ...next, dockId: catalog.docks[0]?.id ?? '' };
    }
    return next;
  }

  function load(source: string) {
    setText(source);
    setDone(null);
    if (source.trim() === '' || !view || !layout) {
      setLines([]);
      setIgnored([]);
      return;
    }
    const imported = parseBatchRows(source, catalog, layout);
    setLines(imported.rows.map((r) => (r.value ? { ...r, value: withDefaults(r.value) } : r)));
    setIgnored(imported.ignoredColumns);
  }

  function update(line: number, patch: Partial<BatchRow>) {
    setLines((all) =>
      all.map((l) => {
        if (l.line !== line || !l.value) return l;
        let next: BatchRow = { ...l.value, ...patch };
        // выбор типа/дока/места снимает замечание разбора таблицы по этому полю
        const problems = { ...next.problems };
        if ('categoryId' in patch && patch.categoryId) delete problems.category;
        if ('dockId' in patch && patch.dockId) delete problems.dock;
        if ('zoneId' in patch && patch.zoneId) delete problems.zone;
        next = withDefaults({ ...next, problems });
        return { ...l, value: next };
      }),
    );
    setDone(null);
  }

  /** «Применить ко всем строкам без …»: только пустое, остальное не трогаем. */
  function applyToAll(field: 'categoryId' | 'dockId' | 'zoneId', value: string) {
    setLines((all) =>
      all.map((l) => {
        if (!l.value) return l;
        const empty =
          field === 'dockId' ? !l.value.dockId && needsDock(l.value.categoryId) : !l.value[field];
        if (!empty) return l;
        const problems = { ...l.value.problems };
        delete problems[field === 'categoryId' ? 'category' : field === 'dockId' ? 'dock' : 'zone'];
        return { ...l, value: withDefaults({ ...l.value, [field]: value, problems }) };
      }),
    );
    setDone(null);
  }

  /** Контекст расчёта строки: настройки формы и объекта + «сейчас» по часам сервера. */
  const buildContext = (nowMs: number) =>
    ctx && view
      ? {
          timezone: ctx.site.timezone,
          today: ctx.today,
          nowMs,
          fields: view.fields,
          dockRequiredFor: needsDock,
          defaultZoneId: view.defaultZoneId,
          pastToleranceMin: ctx.site.pastStartToleranceMin,
          singleMaxHours: ctx.site.singlePassMaxHours,
          startNow: view.startNow,
          singleHours: view.singleHours,
        }
      : null;

  // Строки для сервера: «сейчас» фиксируется при смене ввода, чтобы проверка не перезапускалась сама.
  const prepared = useMemo(() => {
    const drafts: Record<string, unknown>[] = [];
    const rows: { line: number; value: BatchRow }[] = [];
    const errors = new Map<number, string>();
    const fixes = new Map<number, RowFix[]>();
    const spans = new Map<number, string>();
    const context = buildContext(serverNow());
    if (!context) return { rows, drafts, errors, fixes, spans };
    for (const row of lines) {
      if (!row.value) continue;
      const built = batchDraft(row.value, effective, context);
      if (built.ok) {
        rows.push({ line: row.line, value: row.value });
        drafts.push(built.draft);
        spans.set(row.line, built.span);
      } else {
        errors.set(row.line, built.error);
        if (built.fixes.length > 0) fixes.set(row.line, built.fixes);
      }
    }
    return { rows, drafts, errors, fixes, spans };
    // eslint-disable-next-line
  }, [
    lines,
    settings.passType,
    settings.date,
    settings.start,
    settings.end,
    settings.from,
    settings.to,
    settings.comment,
    passType,
    ctx,
    view,
  ]);

  const preview = useAutoPreview<BatchResult>({
    path: '/passes/batch',
    body:
      tenant && prepared.drafts.length > 0 ? { tenantId: tenant.id, rows: prepared.drafts } : null,
    delayMs: 450,
  });

  if (!ctx || !tenant || !view) return null;

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
  const errorOf = (row: Line): string | undefined =>
    row.error ?? prepared.errors.get(row.line) ?? serverErrors.get(row.line);
  const checking =
    preview.status === 'checking' || (prepared.drafts.length > 0 && preview.status === 'idle');
  const okLines = lines.filter((r) => r.value && !errorOf(r)).length;
  const badLines = lines.length - okLines;
  const ready = okLines > 0 && !checking && preview.status === 'ready' && !committing;

  const multi = findMultiPlateLines(text);
  const ownTimeCount = lines.filter(
    (l) =>
      l.value &&
      (l.value.dateText.trim() !== '' ||
        l.value.fromText.trim() !== '' ||
        l.value.toText.trim() !== ''),
  ).length;
  /** «Применить ко всем»: своё время строк снимается — они следуют общим значениям сверху. */
  function applyTimeToAll() {
    setLines((all) =>
      all.map((l) =>
        l.value ? { ...l, value: { ...l.value, dateText: '', fromText: '', toText: '' } } : l,
      ),
    );
    setConfirmApply(false);
    setDone(null);
  }

  const noType = lines.filter((l) => l.value && !l.value.categoryId).length;
  const noDock = lines.filter(
    (l) => l.value && !l.value.dockId && needsDock(l.value.categoryId) && catalog.docks.length > 0,
  ).length;
  const noZone =
    view.fields.destination === 'hidden' || view.zones.length < 2
      ? 0
      : lines.filter((l) => l.value && !l.value.zoneId).length;

  async function commit() {
    if (!ctx || !tenant || !view) return;
    setCommitting(true);
    setCommitError(null);
    try {
      // время «сейчас» берётся заново: между проверкой и нажатием могло пройти время
      const nowMs = serverNow();
      const sent: { line: number; draft: Record<string, unknown> }[] = [];
      const context = buildContext(nowMs);
      for (const row of prepared.rows) {
        if (serverErrors.has(row.line) || !context) continue;
        const built = batchDraft(row.value, effective, context);
        if (built.ok) sent.push({ line: row.line, draft: built.draft });
      }
      const result = await api<BatchResult>('/passes/batch', {
        method: 'POST',
        body: { tenantId: tenant.id, rows: sent.map((r) => r.draft) },
      });
      // Итог по всем строкам: что не прошло ещё до отправки и что отклонил сервер.
      const plateOf = (line: number) => lines.find((l) => l.line === line)?.value?.plate ?? '';
      const errors: { line: number; plate: string; message: string }[] = [];
      for (const row of lines) {
        const early = errorOf(row);
        if (early) errors.push({ line: row.line, plate: plateOf(row.line), message: early });
      }
      for (const e of result.errors) {
        const line = sent[e.row - 1]?.line;
        if (line !== undefined) errors.push({ line, plate: plateOf(line), message: e.message });
      }
      errors.sort((x, y) => x.line - y.line);
      // строки с ошибками остаются (с правками) — их можно исправить и отправить ещё раз
      const failed = new Set(errors.map((e) => e.line));
      setDone({ summary: `Создано ${result.created} из ${lines.length}`, errors });
      setLines((all) => all.filter((l) => failed.has(l.line)));
      setText((current) =>
        current
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .filter((_, index) => failed.has(index + 1))
          .join('\n'),
      );
      await refresh();
    } catch (raw) {
      setCommitError(errorView(raw));
    } finally {
      setCommitting(false);
    }
  }

  const typeLabel = (t: PassType) =>
    `${PASS_TYPE_LABEL[t]} — ${hints.data?.passTypes.find((p) => p.passType === t)?.mode === 'on_request' ? 'уйдёт на согласование' : 'без согласования'}`;
  const single = effective.passType === 'single';

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 sm:gap-4 sm:pt-5">
          {passTypes.length === 1 ? (
            <p className="self-end text-sm text-muted-foreground">
              Пропуска:{' '}
              <span className="font-medium text-foreground">
                {typeLabel(passTypes[0] as PassType)}
              </span>
            </p>
          ) : (
            <Field label="Вид пропуска" required className="min-w-0">
              {passTypes.length === 0 ? (
                <p className="text-sm text-muted-foreground">Загрузка…</p>
              ) : (
                <SegmentedChoice
                  aria-label="Вид пропуска"
                  value={effective.passType}
                  onChange={(t) => setSettings({ ...settings, passType: t })}
                  options={passTypes.map((t) => ({ value: t, label: PASS_TYPE_LABEL[t] }))}
                />
              )}
              <p className="text-xs text-muted-foreground">
                {hints.data?.passTypes.find((p) => p.passType === effective.passType)?.mode ===
                'on_request'
                  ? 'Уйдёт на согласование.'
                  : 'Без согласования.'}
              </p>
            </Field>
          )}
          {single ? (
            <>
              <Field
                label="Дата приезда"
                required
                hint={`Общее значение: для строк, у которых дата не указана. Время объекта: ${ctx.site.timezoneLabel}. На будущую дату без времени пропуск действует весь день до 23:59.`}
              >
                <DateInput
                  aria-label="Общая дата приезда"
                  value={settings.date}
                  todayIso={ctx.today}
                  onChange={(date) => setSettings({ ...settings, date })}
                />
              </Field>
              <Field
                label="Время действия"
                hint={`Пустое «с» — «сейчас»${view.startNow ? '' : ' (если не указать)'}, пустое «до» — начало + ${view.singleHours} ч, не больше ${ctx.site.singlePassMaxHours} ч. Для строк без своего времени.`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">с</span>
                  <TimeInput
                    aria-label="Общее время «с»"
                    value={settings.start}
                    onChange={(start) => setSettings({ ...settings, start })}
                  />
                  <span className="text-xs text-muted-foreground">до</span>
                  <TimeInput
                    aria-label="Общее время «до»"
                    value={settings.end}
                    onChange={(end) => setSettings({ ...settings, end })}
                  />
                </div>
              </Field>
            </>
          ) : (
            <>
              <Field label="Действует с" required>
                <DateInput
                  value={settings.from}
                  todayIso={ctx.today}
                  onChange={(from) => setSettings({ ...settings, from })}
                />
              </Field>
              {effective.passType === 'multi' ? (
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
          {lines.length > 0 ? (
            <div className="space-y-1.5 sm:col-span-2" data-testid="apply-time">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => (ownTimeCount > 0 ? setConfirmApply(true) : applyTimeToAll())}
              >
                Применить ко всем
              </Button>
              <p className="text-xs text-muted-foreground">
                Общие {single ? 'дата и время' : 'даты'} станут временем всех строк: своё время
                строк, заданное в таблице или в предпросмотре, будет заменено.
              </p>
              {confirmApply ? (
                <Alert tone="warning" data-testid="apply-time-confirm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span>В {ownTimeCount} строках уже есть своё время. Заменить его общим?</span>
                    <Button type="button" size="sm" onClick={applyTimeToAll}>
                      Заменить во всех строках
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmApply(false)}
                    >
                      Не менять
                    </Button>
                  </div>
                </Alert>
              ) : null}
            </div>
          ) : null}
          {!single && view.fields.comment !== 'hidden' ? (
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

      <div className="space-y-2">
        <FileDrop
          onText={(loaded) => load(loaded)}
          onError={setFileError}
          label="Перетащите сюда файл .xlsx или .csv или нажмите, чтобы выбрать"
        />
        {fileError ? (
          <p role="alert" className="text-xs text-destructive">
            {fileError}
          </p>
        ) : null}
        <label htmlFor={textId} className="block text-sm font-medium">
          …или вставьте строки из Excel или письма
        </label>
        <Textarea
          id={textId}
          rows={5}
          value={text}
          placeholder={placeholderOf(layout?.columns ?? [], formatLocalDate(ctx.today))}
          spellCheck={false}
          className="font-mono"
          onChange={(e) => load(e.target.value)}
        />
        <p className="text-xs text-muted-foreground" data-testid="batch-columns">
          {columnsLabel(layout?.columns ?? [])} Колонки идут по порядку, а если в первой строке
          заголовки («Номер», «Тип», «Дата»…), то по ним. «Дата», «С», «По» — свой срок каждой
          машины, пустая ячейка берёт общее значение сверху. Пробелы в номерах не мешают. Типы можно
          писать как удобно: «легковые», «Фура». Доступные типы:{' '}
          {view.categories.map((c) => c.name).join(', ') || '—'}.
        </p>
        <BatchTemplateButton
          fileName="шаблон-пакет-пропусков.xlsx"
          titles={templateTitles(layout?.columns ?? [])}
        />
        {multi.length > 0 ? (
          <BatchSuggestion
            message={multiPlateQuestion(multi)}
            onApply={() => load(splitMultiPlateLines(text))}
          />
        ) : null}
        {ignored.length > 0 ? (
          <Alert tone="warning" data-testid="batch-ignored">
            Колонки «{ignored.join('», «')}» отключены настройкой формы пропуска — значения из них
            не сохранятся.
          </Alert>
        ) : null}
      </div>

      {lines.length > 0 ? (
        <div className="space-y-3" aria-live="polite">
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

          <BulkApply
            noType={noType}
            noDock={noDock}
            noZone={noZone}
            categories={view.categories}
            docks={view.docks}
            zones={view.zones}
            onApply={applyToAll}
          />

          <ul className="space-y-2" data-testid="batch-rows">
            {lines.slice(0, SHOWN_ROWS).map((row) => (
              <BatchRowCard
                key={row.line}
                row={row}
                error={errorOf(row)}
                info={rowInfo.get(row.line)}
                view={view}
                needsDock={needsDock}
                showWindow={view.fields.window !== 'hidden'}
                passType={effective.passType}
                todayIso={ctx.today}
                span={prepared.spans.get(row.line)}
                fixes={prepared.fixes.get(row.line)}
                onChange={(patch) => update(row.line, patch)}
              />
            ))}
          </ul>
          {lines.length > SHOWN_ROWS ? (
            <p className="text-xs text-muted-foreground">
              …и ещё {lines.length - SHOWN_ROWS} строк (ошибки учтены в итоге выше)
            </p>
          ) : null}
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
                    {e.plate ? ` (${normalizePlate(e.plate).norm || e.plate})` : ''}: {e.message}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                Строки с ошибками оставлены выше — исправьте их там же и отправьте ещё раз.
              </p>
            </>
          ) : null}
        </Alert>
      ) : null}

      <div
        data-testid="submit-bar"
        className="sticky bottom-16 z-20 -mx-4 flex flex-wrap items-center gap-3 border-t bg-background/95 px-4 py-2 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0"
      >
        <Button size="lg" disabled={!ready} onClick={() => void commit()}>
          {committing ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Создать пропуска: {okLines}
        </Button>
        {lines.length > 0 && okLines === 0 && !checking ? (
          <span className="text-xs text-muted-foreground">
            Нечего создавать — исправьте ошибки.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** «Применить ко всем строкам без типа / без дока / без места». */
function BulkApply({
  noType,
  noDock,
  noZone,
  categories,
  docks,
  zones,
  onApply,
}: {
  noType: number;
  noDock: number;
  noZone: number;
  categories: readonly { id: string; name: string }[];
  docks: readonly { id: string; number: string }[];
  zones: readonly { id: string; name: string }[];
  onApply: (field: 'categoryId' | 'dockId' | 'zoneId', value: string) => void;
}) {
  const [type, setType] = useState('');
  const [dock, setDock] = useState('');
  const [zone, setZone] = useState('');
  if (noType + noDock + noZone === 0) return null;
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3" data-testid="batch-bulk">
      <p className="text-sm font-medium">Применить ко всем строкам сразу</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {noType > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Select
              aria-label="Тип для строк без типа"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">Выберите тип</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!type}
              onClick={() => onApply('categoryId', type)}
            >
              Всем без типа ({noType})
            </Button>
          </div>
        ) : null}
        {noDock > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Select
              aria-label="Док для строк без дока"
              value={dock}
              onChange={(e) => setDock(e.target.value)}
            >
              <option value="">Выберите док</option>
              {docks.map((d) => (
                <option key={d.id} value={d.id}>
                  Док {d.number}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!dock}
              onClick={() => onApply('dockId', dock)}
            >
              Всем без дока ({noDock})
            </Button>
          </div>
        ) : null}
        {noZone > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Select
              aria-label="Место для строк без места"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
            >
              <option value="">Выберите место</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!zone}
              onClick={() => onApply('zoneId', zone)}
            >
              Всем без места ({noZone})
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Одна строка предпросмотра: нормализованный номер, правка типа, дока, места и окна на месте. */
function BatchRowCard({
  row,
  error,
  info,
  view,
  needsDock,
  showWindow,
  passType,
  todayIso,
  span,
  fixes,
  onChange,
}: {
  row: Line;
  error: string | undefined;
  info: { warnings: string[]; waits: boolean } | undefined;
  view: NonNullable<ReturnType<typeof buildFormView>>;
  needsDock: (categoryId: string) => boolean;
  showWindow: boolean;
  passType: PassType;
  todayIso: string;
  /** Итоговое действие пропуска в поясе объекта: «15.10 13:44 → 16.10 12:44». */
  span: string | undefined;
  /** Исправления ошибки окна одним нажатием («Начать окно с 13:50»). */
  fixes: RowFix[] | undefined;
  onChange: (patch: Partial<BatchRow>) => void;
}) {
  const value = row.value;
  const norm = value ? normalizePlate(value.plate).norm : '';
  const warn = !error && (info?.warnings.length ?? 0) > 0;
  const remark = error
    ? error
    : [
        ...(info?.waits ? ['уйдёт на согласование'] : []),
        ...(value?.note ? [value.note] : []),
        ...(info?.warnings ?? []),
      ].join(' · ');
  const own = value
    ? ownTime(passType, value, todayIso)
    : { date: '', start: '', end: '', endDate: '', from: '', to: '', error: null };
  const ownAny = Boolean(own.date || own.start || own.end || own.endDate || own.from || own.to);
  const windowParsed = value ? parseWindow(value.windowText) : null;
  const windowBad = windowParsed !== null && 'error' in windowParsed;
  const typeOptions =
    value && value.candidates.length > 0
      ? view.categories.filter((c) => value.candidates.includes(c.id))
      : view.categories;
  const dockShown = Boolean(
    value && view.docks.length > 0 && (needsDock(value.categoryId) || value.dockId),
  );
  const zoneShown = view.fields.destination !== 'hidden' && view.zones.length > 1;
  return (
    <li
      data-status={error ? 'error' : 'ok'}
      className={`rounded-md border p-3 ${error ? 'border-destructive/50' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {error ? (
          <TriangleAlert aria-label="ошибка" className="size-4 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2
            aria-label={warn ? 'есть предупреждение' : 'готово'}
            className={`size-4 shrink-0 ${warn ? 'text-warning' : 'text-success'}`}
          />
        )}
        <span className="text-xs text-muted-foreground">{row.line}</span>
        <span className="font-mono text-base font-semibold" data-testid="batch-plate">
          {norm || '—'}
        </span>
        {value && norm && value.plate.trim() !== norm ? (
          <span className="text-xs text-muted-foreground">в таблице: «{value.plate}»</span>
        ) : null}
      </div>
      {value ? (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Field label="Тип">
            <Select
              aria-label={`Тип, строка ${row.line}`}
              value={value.categoryId}
              onChange={(e) => onChange({ categoryId: e.target.value })}
              className={`h-9 ${value.categoryId ? '' : 'border-destructive'}`}
            >
              <option value="">Выберите тип</option>
              {typeOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          {dockShown ? (
            <Field label="Док">
              <Select
                aria-label={`Док, строка ${row.line}`}
                value={value.dockId}
                onChange={(e) => onChange({ dockId: e.target.value })}
                className="h-9"
              >
                <option value="">Выберите док</option>
                {view.docks.map((d) => (
                  <option key={d.id} value={d.id}>
                    Док {d.number}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {zoneShown ? (
            <Field label="Место">
              <Select
                aria-label={`Место, строка ${row.line}`}
                value={value.zoneId}
                onChange={(e) => onChange({ zoneId: e.target.value })}
                className="h-9"
              >
                <option value="">Не указано</option>
                {view.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {showWindow ? (
            <Field label="Окно прибытия">
              <Input
                aria-label={`Окно, строка ${row.line}`}
                value={value.windowText}
                placeholder="ЧЧ:ММ–ЧЧ:ММ"
                inputMode="numeric"
                // цифры и разделители превращаются в «12:00–14:00»; свободный текст («с 12 до 14») не трогаем
                onChange={(e) =>
                  onChange({
                    windowText: /^[\d\s:.\-–—]*$/.test(e.target.value)
                      ? maskTimeRange(e.target.value)
                      : e.target.value,
                  })
                }
                className={`h-9 ${windowBad ? 'border-destructive' : ''}`}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
      {value ? (
        <div className="mt-2 space-y-1" data-testid="batch-time">
          <div className="flex flex-wrap items-end gap-2">
            {passType === 'single' ? (
              <>
                <Field label="Дата">
                  <DateInput
                    aria-label={`Дата, строка ${row.line}`}
                    value={own.date}
                    todayIso={todayIso}
                    onChange={(v) => onChange({ dateText: v })}
                  />
                </Field>
                <Field label="С">
                  <TimeInput
                    aria-label={`С, строка ${row.line}`}
                    value={own.start}
                    // дата, пришедшая в ячейке «С» вместе со временем, не теряется при правке времени
                    onChange={(v) =>
                      onChange({
                        fromText: v,
                        ...(value.dateText.trim() === '' && own.date ? { dateText: own.date } : {}),
                      })
                    }
                  />
                </Field>
                <Field label="По">
                  <TimeInput
                    aria-label={`По, строка ${row.line}`}
                    value={own.end}
                    onChange={(v) =>
                      onChange({ toText: own.endDate ? `${isoToRuDate(own.endDate)} ${v}` : v })
                    }
                  />
                </Field>
                {own.endDate ? (
                  // конец в другой день, указанный в «По» явно: правится здесь, пустая дата — «день начала»
                  <Field label="День конца">
                    <DateInput
                      aria-label={`День конца, строка ${row.line}`}
                      value={own.endDate}
                      todayIso={todayIso}
                      onChange={(v) =>
                        onChange({ toText: v ? `${isoToRuDate(v)} ${own.end}` : own.end })
                      }
                    />
                  </Field>
                ) : null}
              </>
            ) : (
              <>
                <Field label="С">
                  <DateInput
                    aria-label={`С, строка ${row.line}`}
                    value={own.from}
                    todayIso={todayIso}
                    onChange={(v) => onChange({ fromText: v })}
                  />
                </Field>
                {passType === 'multi' ? (
                  <Field label="По">
                    <DateInput
                      aria-label={`По, строка ${row.line}`}
                      value={own.to}
                      todayIso={todayIso}
                      onChange={(v) => onChange({ toText: v })}
                    />
                  </Field>
                ) : null}
              </>
            )}
          </div>
          {span ? (
            <p className="text-xs" data-testid="batch-span">
              <span className="text-muted-foreground">Действует: </span>
              <span className="font-medium">{span}</span>
              {ownAny ? null : <span className="text-muted-foreground"> · общее время</span>}
            </p>
          ) : null}
        </div>
      ) : null}
      {value && (value.brand || value.driverName) ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {[value.brand, value.driverName].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {remark ? (
        <p
          className={`mt-1 text-xs ${error ? 'text-destructive' : warn ? 'text-warning' : 'text-muted-foreground'}`}
        >
          {remark}
        </p>
      ) : null}
      {error && fixes && fixes.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="row-fixes">
          {fixes.map((fix) => (
            <Button key={fix.label} size="sm" variant="outline" onClick={() => onChange(fix.patch)}>
              {fix.label}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
