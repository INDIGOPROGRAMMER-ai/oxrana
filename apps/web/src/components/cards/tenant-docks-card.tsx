import {
  type BatchResult,
  DockAssignmentBatchSchema,
  DockAssignmentPatchSchema,
  expandNumberSpec,
} from '@oxrana/contracts';
import {
  Alert,
  api,
  Badge,
  Button,
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
  formatLocalDate,
  Input,
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
} from '../../lib/data';
import { count } from '../../lib/setup';
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
  const allowed = !perms.loaded || perms.can('tenant.manage');
  const docks = useDocks(siteId);
  const assignments = useDockAssignments(allowed ? tenantId : null);
  const clauses = useTenantClauses(allowed ? tenantId : null);
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
        description="Какие доки закреплены за арендатором и на какой срок. Лимит «по докам» считает только действующие назначения. Док не бывает у двух арендаторов сразу."
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
                <TH>Основание</TH>
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
                    <TD>
                      {clauses.refOf(a.basisClauseId) ?? (
                        <span className="text-muted-foreground">не указано</span>
                      )}
                    </TD>
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
        timezone={timezone}
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

function ClauseSelect({
  clauses,
  value,
  onChange,
  error,
}: {
  clauses: TenantClauses;
  value: string;
  onChange: (v: string) => void;
  error?: { message: string; settingLink?: string | null } | null;
}) {
  const reason = !clauses.hasContracts
    ? 'У арендатора нет договора — основание появится, когда вы добавите договор и его пункты.'
    : clauses.options.length === 0
      ? 'В договорах арендатора нет пунктов — выпишите пункт, чтобы сослаться на него.'
      : undefined;
  return (
    <Field
      label="Основание — пункт договора"
      hint="Необязательно. Показывается в журнале и в подсказках."
      disabledReason={reason}
      error={error ?? null}
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— без основания —</option>
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
  onDone,
}: {
  assignment: DockAssignmentView;
  clauses: TenantClauses;
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
  const { register, watch, setValue } = f.form;
  return (
    <EditForm form={f}>
      <Field label="С даты" required error={f.fieldError('validFrom')}>
        <Input type="date" {...register('validFrom')} />
      </Field>
      <Field
        label="По дату"
        hint="Последний день назначения включительно. Пусто — без окончания."
        error={f.fieldError('validTo')}
      >
        <Input type="date" {...register('validTo')} />
      </Field>
      <ClauseSelect
        clauses={clauses}
        value={watch('basisClauseId')}
        onChange={(v) => setValue('basisClauseId', v, { shouldDirty: true })}
        error={f.fieldError('basisClauseId')}
      />
    </EditForm>
  );
}

/** Итог отправки: предпросмотр (`dryRun`) или фактическое закрепление. */
interface Outcome {
  readonly applied: boolean;
  readonly result: BatchResult;
}

function AddDocks({
  tenantId,
  docks,
  clauses,
  timezone,
  today,
  loading,
}: {
  tenantId: string;
  docks: readonly DockView[];
  clauses: TenantClauses;
  timezone: string;
  today: string;
  loading: boolean;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const Link = useLinkComponent();
  const [spec, setSpec] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [basis, setBasis] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
  const current = outcome && !outcome.applied ? outcome.result : null;

  const reasonNotReady =
    parsed.values.length === 0
      ? 'Введите номера доков.'
      : found.length === 0
        ? 'Ни одного дока с такими номерами нет на объекте.'
        : validFrom === ''
          ? 'Укажите, с какой даты док закреплён.'
          : null;

  function changed<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setError(null);
      setFieldErrors({});
      setOutcome(null);
    };
  }

  async function send(dryRun: boolean) {
    setError(null);
    setFieldErrors({});
    const payload = DockAssignmentBatchSchema.safeParse({ ...body, dryRun });
    if (!payload.success) {
      const next: Record<string, string> = {};
      for (const issue of payload.error.issues) {
        next[String(issue.path[0] ?? '')] = issue.message;
      }
      setFieldErrors(next);
      return;
    }
    setBusy(true);
    try {
      const path = `/tenants/${tenantId}/dock-assignments/batch`;
      if (dryRun) {
        // предпросмотр ничего не меняет — данные экранов не обновляем
        setOutcome({
          applied: false,
          result: await api<BatchResult>(path, { method: 'POST', body: payload.data }),
        });
        return;
      }
      const result = await mutate<BatchResult>(path, 'POST', payload.data);
      if (result.created > 0) toast(result.summary);
      if (result.errors.length === 0) {
        setSpec('');
        setOutcome(null);
      } else {
        setOutcome({ applied: true, result });
      }
    } catch (raw) {
      const view = errorView(raw);
      if (view.field === 'validFrom' || view.field === 'validTo') {
        setFieldErrors({ [view.field]: view.message });
      } else {
        setError(view);
      }
    } finally {
      setBusy(false);
    }
  }

  const rowErrors = (outcome?.result.errors ?? []).map((e) => {
    const dock = found[e.row - 1];
    return { id: `${e.row}-${e.code}`, text: `Док № ${dock?.number ?? e.row}: ${e.message}` };
  });

  return (
    <Section
      title="Добавить доки"
      description="Номера диапазоном или списком: «1–10», «33–61, 70». Все доки получат одни и те же даты и основание."
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
            onChange={(e) => changed(setSpec)(e.target.value)}
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
            hint={`Дата объекта (${timezone}), день включительно.`}
            error={fieldErrors.validFrom ? { message: fieldErrors.validFrom } : null}
          >
            <Input
              type="date"
              value={validFrom}
              onChange={(e) => changed(setValidFrom)(e.target.value)}
            />
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => changed(setValidFrom)(today)}
                title="Подставить сегодняшнюю дату объекта"
              >
                Сегодня: {formatLocalDate(today)}
              </Button>
            </div>
          </Field>
          <Field
            label="По дату"
            hint="Последний день включительно. Пусто — без окончания."
            error={fieldErrors.validTo ? { message: fieldErrors.validTo } : null}
          >
            <Input
              type="date"
              value={validTo}
              onChange={(e) => changed(setValidTo)(e.target.value)}
            />
          </Field>
        </div>

        <ClauseSelect clauses={clauses} value={basis} onChange={changed(setBasis)} />

        {fieldErrors.dockIds ? <Alert tone="danger">{fieldErrors.dockIds}</Alert> : null}
        <ErrorAlert error={error} />

        {outcome ? (
          <Alert
            tone={outcome.result.errors.length > 0 ? 'warning' : 'success'}
            title={outcome.applied ? 'Результат' : 'Проверка'}
          >
            {outcome.result.summary}
            {outcome.result.errors.length > 0
              ? outcome.applied
                ? '. Доки с ошибками не закреплены — исправьте и добавьте повторно.'
                : '. Доки с ошибками закреплены не будут, остальные — будут.'
              : '.'}
          </Alert>
        ) : null}
        {rowErrors.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
            {rowErrors.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={busy || reasonNotReady !== null}
            onClick={() => void send(true)}
          >
            {busy && !current ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Проверить
          </Button>
          <Button
            disabled={busy || reasonNotReady !== null || !current || current.created === 0}
            onClick={() => void send(false)}
          >
            {busy && current ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {current && current.created > 0
              ? `Закрепить ${count(current.created, 'док', 'дока', 'доков')}`
              : 'Закрепить'}
          </Button>
          <span className="text-xs text-muted-foreground">
            {reasonNotReady ??
              (current
                ? current.created === 0
                  ? 'Ни один док не может быть закреплён — исправьте ошибки выше.'
                  : null
                : 'Сначала проверьте: сервер покажет, какие доки уже заняты.')}
          </span>
        </div>
      </div>
    </Section>
  );
}
