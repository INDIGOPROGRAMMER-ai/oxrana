import {
  type BatchResult,
  DockAssignmentBatchSchema,
  DockAssignmentPatchSchema,
  expandNumberSpec,
} from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  DateInput,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  FormDateInput,
  formatLocalDate,
  Section,
  Select,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
  useEditForm,
  useLinkComponent,
  useToast,
} from '@oxrana/ui';
import { Loader2, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  type DockAssignmentView,
  type DockView,
  useDockAssignments,
  useDocks,
  useMutate,
  useTrackContracts,
} from '../../lib/data';
import { count } from '../../lib/setup';
import { useAutoPreview } from '../../lib/use-auto-preview';
import { DeleteAction, Empty, LoadError, RequireSite } from '../common';
import {
  assertValid,
  siteToday,
  type TenantClauses,
  usePermissions,
  useTenantClauses,
} from './tenant-rule-helpers';

const byNumber = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });

/** Назначение действует сегодня (по датам объекта). */
export function isActiveOn(a: { validFrom: string; validTo: string | null }, today: string) {
  return a.validFrom <= today && (a.validTo === null || a.validTo >= today);
}

/**
 * Доки арендатора: что закреплено (с какой даты, до какой, по какому пункту договора) и добавление
 * диапазоном («1–10», «33–61, 70»). Лимит «по докам» считается от закреплённых доков.
 */
export function TenantDocksCard({ tenantId }: { tenantId: string }) {
  return (
    <RequireSite>
      {(site) => <DocksBody siteId={site.id} timezone={site.timezone} tenantId={tenantId} />}
    </RequireSite>
  );
}

function DocksBody({
  siteId,
  timezone,
  tenantId,
}: {
  siteId: string;
  timezone: string;
  tenantId: string;
}) {
  const perms = usePermissions();
  const track = useTrackContracts();
  const allowed = !perms.loaded || perms.can('tenant.manage');
  const docks = useDocks(siteId);
  const assignments = useDockAssignments(allowed ? tenantId : null);
  const clauses = useTenantClauses(allowed && track ? tenantId : null);
  const [editing, setEditing] = useState<DockAssignmentView | null>(null);
  const today = siteToday(timezone);
  const dockById = useMemo(
    () => new Map((docks.items ?? []).map((d) => [d.id, d] as const)),
    [docks.items],
  );

  if (!allowed) {
    return (
      <Section title="Доки арендатора">
        <Alert tone="warning">
          Закреплять доки может пользователь с правом «управление арендаторами». Обратитесь к
          администратору.
        </Alert>
      </Section>
    );
  }
  if (assignments.error) {
    return <LoadError error={assignments.error} retry={() => void assignments.refetch()} />;
  }
  if (docks.error) return <LoadError error={docks.error} retry={() => void docks.refetch()} />;

  const items = [...(assignments.items ?? [])].sort((a, b) =>
    byNumber(dockById.get(a.dockId)?.number ?? '', dockById.get(b.dockId)?.number ?? ''),
  );
  const loading = assignments.isLoading || docks.isLoading;

  return (
    <>
      <Section
        title="Доки арендатора"
        description="Какие доки закреплены за арендатором и на какой срок. Даты — история смены арендаторов дока: с какого дня док числится за этим арендатором и до какого. Лимит «по докам» считает только действующие назначения. Док не бывает у двух арендаторов сразу."
      >
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Доков у арендатора нет"
            hint="Добавьте номера доков ниже, например «1–10» или «33–61, 70»."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Док</TH>
                <TH>С даты</TH>
                <TH>По дату</TH>
                {track ? <TH>Основание</TH> : null}
                <TH>Сейчас</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((a) => {
                const dock = dockById.get(a.dockId);
                const number = dock?.number ?? '?';
                return (
                  <TR key={a.id}>
                    <TD className="font-medium">№ {number}</TD>
                    <TD>{formatLocalDate(a.validFrom)}</TD>
                    <TD>
                      {a.validTo ? (
                        formatLocalDate(a.validTo)
                      ) : (
                        <span className="text-muted-foreground">без окончания</span>
                      )}
                    </TD>
                    {track ? (
                      <TD>
                        {clauses.refOf(a.basisClauseId) ?? (
                          <span className="text-muted-foreground">не указано</span>
                        )}
                      </TD>
                    ) : null}
                    <TD>
                      <AssignmentStatus assignment={a} today={today} />
                    </TD>
                    <TD>
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Изменить назначение дока ${number}`}
                          onClick={() => setEditing(a)}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <DeleteAction
                          collection="dock-assignments"
                          id={a.id}
                          name={`назначение дока № ${number}`}
                          title="Удалить назначение дока?"
                        />
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Section>

      <AddDocks
        tenantId={tenantId}
        docks={docks.items ?? []}
        clauses={clauses}
        track={track}
        today={today}
        loading={docks.isLoading}
      />

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Док № {editing ? (dockById.get(editing.dockId)?.number ?? '?') : ''}
            </DialogTitle>
            <DialogDescription>
              Чтобы прекратить назначение, укажите дату окончания. Сохраняются только изменённые
              поля.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditAssignmentForm
              assignment={editing}
              clauses={clauses}
              track={track}
              today={today}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AssignmentStatus({
  assignment,
  today,
}: {
  assignment: DockAssignmentView;
  today: string;
}) {
  if (assignment.validFrom > today) return <Badge tone="info">ещё не началось</Badge>;
  if (assignment.validTo !== null && assignment.validTo < today) {
    return <Badge tone="neutral">завершено</Badge>;
  }
  return <Badge tone="success">действует</Badge>;
}

interface AssignmentValues {
  validFrom: string;
  validTo: string;
  basisClauseId: string;
}

/**
 * Основание — пункт договора: необязательно. Если договор не ведётся (настройка организации),
 * поле скрыто; если договора или пунктов нет — поле остаётся, но спокойно говорит, что оно не нужно.
 */
function ClauseSelect({
  clauses,
  track,
  value,
  onChange,
  error,
}: {
  clauses: TenantClauses;
  track: boolean;
  value: string;
  onChange: (v: string) => void;
  error?: { message: string; settingLink?: string | null } | null;
}) {
  if (!track) return null;
  const nothingToPick = clauses.options.length === 0;
  return (
    <Field
      label="Основание (необязательно)"
      hint={
        nothingToPick
          ? 'Не нужно: пунктов договора нет. Захотите ссылаться на пункт — добавьте его на вкладке «Договор».'
          : 'Пункт договора, на который опирается назначение. Показывается в журнале и в подсказках.'
      }
      error={error ?? null}
    >
      <Select value={value} disabled={nothingToPick} onChange={(e) => onChange(e.target.value)}>
        <option value="">{nothingToPick ? '— не нужно —' : '— без основания —'}</option>
        {clauses.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function EditAssignmentForm({
  assignment,
  clauses,
  track,
  today,
  onDone,
}: {
  assignment: DockAssignmentView;
  clauses: TenantClauses;
  track: boolean;
  today: string;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<AssignmentValues>({
    values: {
      validFrom: assignment.validFrom,
      validTo: assignment.validTo ?? '',
      basisClauseId: assignment.basisClauseId ?? '',
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.validFrom !== undefined) body.validFrom = patch.validFrom;
      if (patch.validTo !== undefined) body.validTo = patch.validTo || null;
      if (patch.basisClauseId !== undefined) body.basisClauseId = patch.basisClauseId || null;
      assertValid(DockAssignmentPatchSchema, body);
      await mutate(`/dock-assignments/${assignment.id}`, 'PATCH', body);
      toast('Назначение сохранено');
      onDone();
    },
  });
  const { watch, setValue, control } = f.form;
  return (
    <EditForm form={f}>
      <Field label="С даты" required error={f.fieldError('validFrom')}>
        <FormDateInput control={control} name="validFrom" todayIso={today} />
      </Field>
      <Field
        label="По дату"
        hint="Последний день назначения включительно. Пусто — бессрочно."
        error={f.fieldError('validTo')}
      >
        <FormDateInput control={control} name="validTo" todayIso={today} />
        {watch('validTo') === '' ? (
          <p className="text-xs text-muted-foreground">бессрочно</p>
        ) : null}
      </Field>
      <ClauseSelect
        clauses={clauses}
        track={track}
        value={watch('basisClauseId')}
        onChange={(v) => setValue('basisClauseId', v, { shouldDirty: true })}
        error={f.fieldError('basisClauseId')}
      />
    </EditForm>
  );
}

function AddDocks({
  tenantId,
  docks,
  clauses,
  track,
  today,
  loading,
}: {
  tenantId: string;
  docks: readonly DockView[];
  clauses: TenantClauses;
  track: boolean;
  today: string;
  loading: boolean;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const Link = useLinkComponent();
  const [spec, setSpec] = useState('');
  // «С даты» предзаполнена сегодняшней датой объекта и подписана; «По дату» пусто — бессрочно.
  const [validFrom, setValidFrom] = useState(today);
  const [validTo, setValidTo] = useState('');
  const [basis, setBasis] = useState('');
  const [result, setResult] = useState<BatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);

  const parsed = useMemo(() => expandNumberSpec(spec), [spec]);
  const byDockNumber = useMemo(() => new Map(docks.map((d) => [d.number, d] as const)), [docks]);
  const found = parsed.values.flatMap((n) => {
    const dock = byDockNumber.get(n);
    return dock ? [dock] : [];
  });
  const missing = parsed.values.filter((n) => !byDockNumber.has(n));

  const body = {
    dockIds: found.map((d) => d.id),
    validFrom,
    ...(validTo ? { validTo } : {}),
    ...(basis ? { basisClauseId: basis } : {}),
  };
  const valid = DockAssignmentBatchSchema.safeParse(body);
  const dateError =
    validFrom === ''
      ? 'Укажите, с какой даты док закреплён.'
      : validTo !== '' && validTo < validFrom
        ? 'Окончание раньше начала. Проверьте даты.'
        : null;
  const missingReason =
    parsed.values.length === 0
      ? 'Введите номера доков.'
      : found.length === 0
        ? 'Ни одного дока с такими номерами нет на объекте.'
        : dateError;

  // Проверка сервером — сама, при вводе: кто уже занял док, пересечения по датам.
  const preview = useAutoPreview({
    path: `/tenants/${tenantId}/dock-assignments/batch`,
    body: valid.success && missingReason === null ? body : null,
  });
  const checked = preview.status === 'ready' ? preview.result : null;
  const canApply = checked !== null && checked.created > 0;

  const edit =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setError(null);
      setResult(null);
    };

  async function apply() {
    if (!valid.success) return;
    setError(null);
    setBusy(true);
    try {
      const done = await mutate<BatchResult>(
        `/tenants/${tenantId}/dock-assignments/batch`,
        'POST',
        valid.data,
      );
      if (done.created > 0) toast(done.summary);
      if (done.errors.length === 0) {
        setSpec('');
        setResult(null);
      } else {
        setResult(done);
      }
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  const rowErrors = (result ?? checked)?.errors.map((e) => {
    const dock = found[e.row - 1];
    return { id: `${e.row}-${e.code}`, text: `Док № ${dock?.number ?? e.row}: ${e.message}` };
  });

  return (
    <Section
      title="Добавить доки"
      description="Номера диапазоном или списком: «1–10», «33–61, 70». Все доки получат одни и те же даты. Проверка идёт сама, пока вы вводите."
    >
      <div className="space-y-4">
        <Field
          label="Номера доков"
          required
          hint="Разделители — запятая, пробел или перенос строки. Диапазон — через дефис."
        >
          <Textarea
            value={spec}
            rows={2}
            placeholder="1–10, 33–61, 70"
            onChange={(e) => edit(setSpec)(e.target.value)}
          />
        </Field>

        {spec.trim() !== '' ? (
          <div className="space-y-2" aria-live="polite">
            {loading ? (
              <p className="text-sm text-muted-foreground">Загружаем доки объекта…</p>
            ) : (
              <p className="text-sm">
                Закрепится: <strong>{found.length}</strong> {found.length === 1 ? 'док' : 'доков'}{' '}
                из {parsed.values.length} введённых.
              </p>
            )}
            {!loading && missing.length > 0 ? (
              <Alert tone="warning">
                Доков с номерами {missing.slice(0, 20).join(', ')}
                {missing.length > 20 ? ` и ещё ${missing.length - 20}` : ''} нет на объекте —
                добавьте их в «Доки и зоны». Они не будут закреплены.{' '}
                <Link href="/admin/docks" className="font-medium underline">
                  Открыть «Доки и зоны»
                </Link>
              </Alert>
            ) : null}
            {parsed.errors.map((e) => (
              <Alert key={e.token} tone="danger">
                {e.message}
              </Alert>
            ))}
            {parsed.duplicates.length > 0 ? (
              <Alert tone="info">
                Номера повторяются: {parsed.duplicates.join(', ')}. Каждый док будет закреплён один
                раз.
              </Alert>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="С даты"
            required
            hint={
              validFrom === today
                ? 'Сегодня — дата объекта. Можно выбрать другую.'
                : 'Первый день, когда док числится за арендатором.'
            }
            error={dateError && validFrom === '' ? { message: dateError } : null}
          >
            <DateInput value={validFrom} todayIso={today} onChange={edit(setValidFrom)} />
          </Field>
          <Field
            label="По дату"
            hint="Последний день включительно. Пусто — бессрочно."
            error={dateError && validFrom !== '' ? { message: dateError } : null}
          >
            <DateInput value={validTo} todayIso={today} onChange={edit(setValidTo)} />
            {validTo === '' ? <p className="text-xs text-muted-foreground">бессрочно</p> : null}
          </Field>
        </div>

        <ClauseSelect clauses={clauses} track={track} value={basis} onChange={edit(setBasis)} />

        <ErrorAlert error={error ?? preview.error} />
        {checked && checked.errors.length > 0 ? (
          <Alert tone="warning" title="Проверка">
            {checked.summary}. Доки с ошибками закреплены не будут, остальные — будут.
          </Alert>
        ) : null}
        {result && result.errors.length > 0 ? (
          <Alert tone="warning" title="Результат">
            {result.summary}. Доки с ошибками не закреплены — исправьте и добавьте повторно.
          </Alert>
        ) : null}
        {rowErrors && rowErrors.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
            {rowErrors.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy || !canApply} onClick={() => void apply()}>
            {busy || preview.status === 'checking' ? (
              <Loader2 aria-hidden className="animate-spin" />
            ) : null}
            {canApply
              ? `Закрепить ${count(checked.created, 'док', 'дока', 'доков')}`
              : 'Закрепить доки'}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {missingReason ??
              (preview.status === 'checking'
                ? 'Проверяем…'
                : checked && checked.created === 0
                  ? 'Ни один док не может быть закреплён — исправьте ошибки выше.'
                  : null)}
          </span>
        </div>
      </div>
    </Section>
  );
}
