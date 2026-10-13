import type {
  QuotaWhatIfResultSchema,
  SandboxCheck,
  SandboxPlateResultSchema,
  SandboxResultSchema,
} from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import {
  Alert,
  api,
  Badge,
  Button,
  Checkbox,
  DateTimeInput,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  formatInZone,
  Input,
  localToInstant,
  Section,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@oxrana/ui';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  type SiteView,
  useCategories,
  useDocks,
  useGates,
  useMe,
  useQuotas,
  useTenants,
} from '../../lib/data';
import { Empty, LoadError, RequireSite } from '../common';
import { siteToday } from './tenant-rule-helpers';

type Result = z.infer<typeof SandboxResultSchema>;
type PlateResult = z.infer<typeof SandboxPlateResultSchema>;
type WhatIf = z.infer<typeof QuotaWhatIfResultSchema>;

export const VERDICT_STYLE: Record<string, { emoji: string; label: string; box: string }> = {
  green: { emoji: '🟢', label: 'Можно впустить', box: 'border-success bg-success-soft' },
  yellow: { emoji: '🟡', label: 'Ждать', box: 'border-warning bg-warning-soft' },
  blue: { emoji: '🔵', label: 'Не тот КПП', box: 'border-primary bg-info-soft' },
  red: { emoji: '🔴', label: 'Отказ', box: 'border-destructive bg-danger-soft' },
  orange: {
    emoji: '🟠',
    label: 'Впустить со сверхлимитом',
    box: 'border-[oklch(0.6_0.17_55)] bg-[oklch(0.96_0.05_60)] dark:bg-[oklch(0.3_0.06_55)]',
  },
};

export const CHECK_LABEL: Record<string, string> = {
  pass_found: 'Пропуск найден',
  pass_status: 'Статус пропуска',
  blacklist: 'Чёрный список',
  tenant_status: 'Статус арендатора',
  contract: 'Договор арендатора',
  pass_validity: 'Срок пропуска',
  single_used: 'Разовый пропуск использован',
  open_visit: 'Уже на территории',
  gate_admits: 'КПП пропускает такой транспорт',
  routing: 'Маршрут (тип × КПП)',
  working_hours: 'Рабочее время',
  time_window: 'Окно прибытия',
  dock_required: 'Док',
  quota: 'Лимит',
  pedestrian_rule: 'Правила для пешеходов',
  override: 'Одобренное исключение',
};
const RESULT_LABEL: Record<
  string,
  { text: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }
> = {
  pass: { text: 'пройдена', tone: 'success' },
  fail: { text: 'не пройдена', tone: 'danger' },
  warn: { text: 'предупреждение', tone: 'warning' },
  skipped: { text: 'не применялась', tone: 'neutral' },
};

/** Светофор вердикта: цвет, одна фраза, причины, а по кнопке — каждая проверка (trace). */
export function VerdictBox({
  verdict,
  header,
  atLabel,
  assumptions = [],
  notice = null,
}: {
  verdict: Result['verdict'];
  /** Мелкая строка над светофором: что и где проверяли. */
  header: string;
  atLabel: string;
  assumptions?: readonly string[];
  /** Крупная пометка над светофором (например, «это пример»). */
  notice?: ReactNode;
}) {
  const style = VERDICT_STYLE[verdict.color] ?? VERDICT_STYLE.green;
  const [showTrace, setShowTrace] = useState(false);
  if (!style) return null;
  return (
    <div className="space-y-3">
      {notice}
      <div
        data-testid="verdict"
        data-color={verdict.color}
        data-code={verdict.code}
        className={`rounded-lg border-2 p-4 ${style.box}`}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {header}
        </p>
        <p className="mt-1 text-xl font-semibold">
          <span aria-hidden>{style.emoji}</span> {style.label}
        </p>
        <p className="mt-1 text-base">{verdict.headline}</p>
        {verdict.reasons.length > 1 ? (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
            {verdict.reasons.slice(1).map((r) => (
              <li key={`${r.code}-${r.message}`}>{r.message}</li>
            ))}
          </ul>
        ) : null}
        {verdict.infoLines.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-sm text-muted-foreground">
            {verdict.infoLines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        {verdict.reasons.some((r) => r.settingLink) ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Где исправить:{' '}
            {[
              ...new Set(verdict.reasons.flatMap((r) => (r.settingLink ? [r.settingLink] : []))),
            ].join('; ')}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Время проверки: {atLabel}. Движок {verdict.engineVersion}.
      </p>
      {assumptions.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
      {verdict.quotaStates.length > 0 ? (
        <ul className="space-y-0.5 text-sm">
          {verdict.quotaStates.map((q) => (
            <li key={q.quotaId}>
              {q.tenantName}, «{q.name}»: сейчас {q.occupied} из {q.capacity}; после въезда —{' '}
              {q.wouldBe}
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        aria-expanded={showTrace}
        onClick={() => setShowTrace(!showTrace)}
      >
        {showTrace ? 'Скрыть' : 'Почему так?'} — какие проверки сработали
      </Button>
      {showTrace ? (
        <Table>
          <THead>
            <TR>
              <TH>Проверка</TH>
              <TH>Итог</TH>
              <TH>Подробности</TH>
            </TR>
          </THead>
          <TBody>
            {verdict.trace.map((t, i) => {
              const check = String(t.check ?? '');
              const res = RESULT_LABEL[String(t.result)] ?? RESULT_LABEL.skipped;
              const details = t.details ? JSON.stringify(t.details) : '';
              return (
                <TR key={`${check}-${i}`}>
                  <TD className="font-medium">{CHECK_LABEL[check] ?? check}</TD>
                  <TD>{res ? <Badge tone={res.tone}>{res.text}</Badge> : null}</TD>
                  <TD className="max-w-96 break-words text-xs text-muted-foreground">
                    {t.skippedBy ? `снята: ${JSON.stringify(t.skippedBy)} ` : ''}
                    {t.basis ? `основание: ${String(t.basis)} ` : ''}
                    {details}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      ) : null}
    </div>
  );
}

/** Текущее время объекта как `ГГГГ-ММ-ДДTЧЧ:ММ`. */
function nowLocal(timezone: string): string {
  const [d = '', t = ''] = formatInZone(new Date().toISOString(), timezone).split(' ');
  const [dd = '', mm = '', yyyy = ''] = d.split('.');
  return `${yyyy}-${mm}-${dd}T${t}`;
}

interface Form {
  tenantId: string;
  participant: 'vehicle' | 'pedestrian';
  categoryId: string;
  passType: 'single' | 'multi' | 'permanent';
  gateId: string;
  direction: 'in' | 'out';
  at: string;
  plate: string;
  personName: string;
  dockId: string;
  quotaFull: boolean;
}

function fromRequest(r: SandboxCheck | undefined, timezone: string): Form {
  const at = r?.at ? formatLocalIso(r.at, timezone) : nowLocal(timezone);
  return {
    tenantId: r?.tenantId ?? '',
    participant: r?.participant ?? 'vehicle',
    categoryId: r?.categoryId ?? '',
    passType: r?.passType ?? 'multi',
    gateId: r?.gateId ?? '',
    direction: r?.direction ?? 'in',
    at,
    plate: r?.plate ?? '',
    personName: r?.personName ?? '',
    dockId: r?.dockId ?? '',
    quotaFull: r?.quotaFull ?? false,
  };
}

function formatLocalIso(iso: string, timezone: string): string {
  const [d = '', t = ''] = formatInZone(iso, timezone).split(' ');
  const [dd = '', mm = '', yyyy = ''] = d.split('.');
  return `${yyyy}-${mm}-${dd}T${t}`;
}

function SandboxBody({ site, initial }: { site: SiteView; initial: SandboxCheck | undefined }) {
  const tenants = useTenants(site.id);
  const gates = useGates(site.id);
  const categories = useCategories(site.id, false);
  const docks = useDocks(site.id);
  const [form, setForm] = useState<Form>(() => fromRequest(initial, site.timezone));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const body: SandboxCheck | null = useMemo(() => {
    if (!form.tenantId || !form.gateId) return null;
    if (form.participant === 'vehicle' && !form.categoryId) return null;
    const [date = '', time = '00:00'] = form.at.split('T');
    return {
      tenantId: form.tenantId,
      passType: form.passType,
      participant: form.participant,
      ...(form.participant === 'vehicle' ? { categoryId: form.categoryId } : {}),
      gateId: form.gateId,
      direction: form.direction,
      ...(date ? { at: localToInstant(date, time, site.timezone) } : {}),
      ...(form.plate.trim() && form.participant === 'vehicle' ? { plate: form.plate.trim() } : {}),
      ...(form.personName.trim() && form.participant === 'pedestrian'
        ? { personName: form.personName.trim() }
        : {}),
      ...(form.dockId && form.participant === 'vehicle' ? { dockId: form.dockId } : {}),
      ...(form.quotaFull ? { quotaFull: true } : {}),
    };
  }, [form, site.timezone]);

  // Проверка идёт сама, пока вы меняете условия (с паузой в наборе).
  const key = body ? JSON.stringify(body) : null;
  useEffect(() => {
    if (!key) {
      setResult(null);
      return;
    }
    const mine = ++ticket.current;
    setBusy(true);
    const timer = setTimeout(() => {
      api<Result>(`/sites/${site.id}/sandbox/check`, { method: 'POST', body: JSON.parse(key) })
        .then((r) => {
          if (mine === ticket.current) {
            setResult(r);
            setError(null);
          }
        })
        .catch((raw: unknown) => {
          if (mine === ticket.current) {
            setResult(null);
            setError(errorView(raw));
          }
        })
        .finally(() => {
          if (mine === ticket.current) setBusy(false);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [key, site.id]);

  const failed = tenants.error ?? gates.error ?? categories.error ?? docks.error;
  if (failed) return <LoadError error={failed} />;
  if (tenants.isLoading || gates.isLoading || categories.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Загрузка…
      </p>
    );
  }
  if ((tenants.items ?? []).length === 0 || (gates.items ?? []).length === 0) {
    return (
      <Empty
        title="Проверять пока нечего"
        hint="Нужны хотя бы один КПП и один арендатор — их добавляют в мастере настройки."
      />
    );
  }
  const plate = form.plate.trim() ? normalizePlate(form.plate) : null;
  const missing =
    form.tenantId === ''
      ? 'Выберите арендатора.'
      : form.participant === 'vehicle' && form.categoryId === ''
        ? 'Выберите тип транспорта.'
        : form.gateId === ''
          ? 'Выберите КПП.'
          : null;
  return (
    <Section
      title="Проверить правила на примере"
      description="Выберите арендатора, тип, КПП и время — песочница проверит воображаемый пропуск по правилам объекта и покажет вердикт с причинами и проверками. Настоящие пропуска не проверяются, ничего не записывается."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label="Арендатор" required>
            <Select value={form.tenantId} onChange={(e) => set('tenantId', e.target.value)}>
              <option value="">— выберите —</option>
              {(tenants.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.shortName}
                  {t.status === 'active'
                    ? ''
                    : ` (${t.status === 'archived' ? 'архив' : 'заблокирован'})`}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Кто едет">
              <Select
                value={form.participant}
                onChange={(e) => set('participant', e.target.value as Form['participant'])}
              >
                <option value="vehicle">Машина</option>
                <option value="pedestrian">Пешеход</option>
              </Select>
            </Field>
            <Field label="Тип пропуска">
              <Select
                value={form.passType}
                onChange={(e) => set('passType', e.target.value as Form['passType'])}
              >
                <option value="single">Разовый</option>
                <option value="multi">Многоразовый</option>
                <option value="permanent">Постоянный</option>
              </Select>
            </Field>
          </div>
          {form.participant === 'vehicle' ? (
            <Field label="Тип транспорта" required>
              <Select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">— выберите —</option>
                {(categories.items ?? [])
                  .filter((c) => c.enabled)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="КПП" required>
              <Select value={form.gateId} onChange={(e) => set('gateId', e.target.value)}>
                <option value="">— выберите —</option>
                {(gates.items ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Направление">
              <Select
                value={form.direction}
                onChange={(e) => set('direction', e.target.value as Form['direction'])}
              >
                <option value="in">Въезд</option>
                <option value="out">Выезд</option>
              </Select>
            </Field>
          </div>
          <Field label="Время проверки" hint={`Время объекта (${site.timezoneLabel}).`}>
            <div className="flex flex-wrap items-start gap-2">
              <DateTimeInput
                value={form.at}
                todayIso={siteToday(site.timezone)}
                onChange={(v) => set('at', v)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => set('at', nowLocal(site.timezone))}
              >
                Сейчас
              </Button>
            </div>
          </Field>
          {form.participant === 'vehicle' ? (
            <>
              <Field
                label="Номер машины"
                hint={
                  plate?.norm
                    ? `Запишется как ${plate.norm}${plate.recognized ? '' : ' (формат не распознан)'}. Без номера чёрный список не проверяется.`
                    : 'Необязательно. Нужен, чтобы проверить чёрный список.'
                }
              >
                <Input
                  value={form.plate}
                  onChange={(e) => set('plate', e.target.value)}
                  className="font-mono"
                  autoComplete="off"
                  maxLength={30}
                />
              </Field>
              <Field
                label="Док"
                hint="Нужен, если арендатору положено ездить грузовым только к докам."
              >
                <Select value={form.dockId} onChange={(e) => set('dockId', e.target.value)}>
                  <option value="">— без дока —</option>
                  {(docks.items ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      № {d.number}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : (
            <Field
              label="Фамилия и имя"
              hint="Необязательно. Нужно, чтобы проверить чёрный список по человеку."
            >
              <Input
                value={form.personName}
                onChange={(e) => set('personName', e.target.value)}
                maxLength={200}
              />
            </Field>
          )}
          <Checkbox
            label="Что если все места лимитов арендатора заняты"
            hint="Покажет, что увидит охранник, когда лимит исчерпан."
            checked={form.quotaFull}
            onChange={(e) => set('quotaFull', e.target.checked)}
          />
        </div>
        <div className="space-y-3" aria-live="polite">
          {missing ? <Alert tone="info">{missing}</Alert> : null}
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 aria-hidden className="size-4 animate-spin" /> Проверяем…
            </p>
          ) : null}
          <ErrorAlert error={error} />
          {result && !error ? (
            <VerdictBox
              verdict={result.verdict}
              header={`${result.subject.directionLabel} · ${result.subject.tenantName} · ${result.subject.gateName}${
                result.subject.categoryName ? ` · ${result.subject.categoryName}` : ''
              }${result.subject.plateNorm ? ` · ${result.subject.plateNorm}` : ''}`}
              atLabel={result.subject.atLabel}
              assumptions={result.assumptions}
              notice={
                <div
                  role="note"
                  data-testid="example-notice"
                  className="rounded-lg border-2 border-warning bg-warning-soft p-3 text-lg font-semibold"
                >
                  Это пример: пропуск воображаемый, настоящие пропуска не проверялись.
                </div>
              }
            />
          ) : null}
        </div>
      </div>
    </Section>
  );
}

const PASS_STATUS_LABEL: Record<string, string> = {
  draft: 'черновик',
  pending_approval: 'ждёт согласования',
  approved: 'согласован',
  rejected: 'отклонён',
  cancelled: 'отменён',
  expired: 'истёк',
  used: 'использован',
};
const PASS_TYPE_WORD: Record<string, string> = {
  single: 'разовый',
  multi: 'многоразовый',
  permanent: 'постоянный',
};

/** Что нашлось по номеру среди настоящих пропусков — крупно, до светофора. */
function FoundPass({ result, timezone }: { result: PlateResult; timezone: string }) {
  const { pass } = result;
  if (pass) {
    const until = pass.validTo
      ? `действует до ${formatInZone(pass.validTo, timezone)}`
      : 'без срока';
    return (
      <div
        data-testid="plate-found"
        className="rounded-lg border-2 border-primary bg-info-soft p-3 text-base"
      >
        <p className="text-lg font-semibold">Найден настоящий пропуск</p>
        <p>
          {result.tenantName ?? 'Арендатор'} · {PASS_TYPE_WORD[pass.passType] ?? pass.passType} ·{' '}
          {pass.plateNorm ?? pass.personName ?? '—'} ·{' '}
          {PASS_STATUS_LABEL[pass.status] ?? pass.status} · {until}
        </p>
        {result.openVisit ? <p>Сейчас на территории.</p> : null}
      </div>
    );
  }
  return (
    <div
      data-testid="plate-not-found"
      className="rounded-lg border-2 border-primary bg-info-soft p-3 text-lg font-semibold"
    >
      {result.candidates > 1
        ? `По этому номеру нашлось пропусков: ${result.candidates} — охранник выберет нужный сам.`
        : 'Настоящих пропусков по этому номеру нет — охранник увидит то, что ниже.'}
    </div>
  );
}

/** «Проверить номер, как на посту»: настоящие пропуска, настоящая занятость, тот же вердикт. */
function PlateCheckBody({ site }: { site: SiteView }) {
  const gates = useGates(site.id);
  const [gateId, setGateId] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [plate, setPlate] = useState('');
  const [result, setResult] = useState<PlateResult | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);
  const gateItems = gates.items ?? [];
  // Единственный КПП выбирается сам: лишний клик ни к чему.
  const effectiveGate = gateId || (gateItems.length === 1 ? (gateItems[0]?.id ?? '') : '');
  const norm = plate.trim() ? normalizePlate(plate) : null;
  const ready = effectiveGate !== '' && plate.trim().length >= 2;
  const key = ready
    ? JSON.stringify({ gateId: effectiveGate, plate: plate.trim(), direction })
    : null;

  useEffect(() => {
    if (!key) {
      setResult(null);
      setError(null);
      return;
    }
    const mine = ++ticket.current;
    setBusy(true);
    const timer = setTimeout(() => {
      api<PlateResult>(`/sites/${site.id}/sandbox/check-plate`, {
        method: 'POST',
        body: JSON.parse(key),
      })
        .then((r) => {
          if (mine === ticket.current) {
            setResult(r);
            setError(null);
          }
        })
        .catch((raw: unknown) => {
          if (mine === ticket.current) {
            setResult(null);
            setError(errorView(raw));
          }
        })
        .finally(() => {
          if (mine === ticket.current) setBusy(false);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [key, site.id]);

  if (gates.error) return <LoadError error={gates.error} />;
  if (gates.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Загрузка…
      </p>
    );
  }
  if (gateItems.length === 0) {
    return (
      <Empty
        title="Проверять пока нечего"
        hint="Нужен хотя бы один КПП — его добавляют в мастере настройки."
      />
    );
  }
  return (
    <Section
      title="Проверить номер, как на посту"
      description="Введите номер (можно только цифры): песочница найдёт настоящие пропуска объекта и покажет ровно то, что увидит охранник на выбранном КПП сейчас. В журнал КПП ничего не пишется."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="КПП" required>
              <Select value={effectiveGate} onChange={(e) => setGateId(e.target.value)}>
                <option value="">— выберите —</option>
                {gateItems.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Направление">
              <Select
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'in' | 'out')}
              >
                <option value="in">Въезд</option>
                <option value="out">Выезд</option>
              </Select>
            </Field>
          </div>
          <Field
            label="Номер машины"
            hint={
              norm?.norm
                ? `Ищем как ${norm.norm}${norm.recognized ? '' : ' (формат не распознан)'}.`
                : 'Номер целиком или несколько цифр, как у охранника.'
            }
          >
            <Input
              value={plate}
              onChange={(e) => setPlate(e.target.value)}
              className="font-mono"
              autoComplete="off"
              maxLength={30}
            />
          </Field>
        </div>
        <div className="space-y-3" aria-live="polite">
          {!ready ? (
            <Alert tone="info">
              {effectiveGate === '' ? 'Выберите КПП.' : 'Введите номер — проверка пойдёт сама.'}
            </Alert>
          ) : null}
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 aria-hidden className="size-4 animate-spin" /> Проверяем…
            </p>
          ) : null}
          <ErrorAlert error={error} />
          {result && !error ? (
            <>
              <FoundPass result={result} timezone={site.timezone} />
              <VerdictBox
                verdict={result.verdict}
                header={`${result.subject.directionLabel} · ${result.subject.gateName} · ${result.subject.plateNorm}`}
                atLabel={result.subject.atLabel}
              />
            </>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/** «Что будет, если»: изменить лимит и увидеть, кто сейчас внутри и кто окажется сверх. */
function WhatIfSection({ site }: { site: SiteView }) {
  const { can } = useMe();
  const allowed = can('quota.manage');
  const quotas = useQuotas(allowed ? site.id : null);
  const tenants = useTenants(site.id);
  const [quotaId, setQuotaId] = useState('');
  const [capacity, setCapacity] = useState('');
  const [result, setResult] = useState<WhatIf | null>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const tenantName = (id: string) => tenants.items?.find((t) => t.id === id)?.shortName ?? '';
  const quota = quotas.items?.find((q) => q.id === quotaId);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<WhatIf>(`/sites/${site.id}/sandbox/quota-what-if`, {
          method: 'POST',
          body: { quotaId, ...(capacity.trim() !== '' ? { capacity: Number(capacity) } : {}) },
        }),
      );
    } catch (raw) {
      setResult(null);
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Что будет, если изменить лимит"
      description="Выберите лимит и новое число мест: покажем, сколько сейчас внутри и кто окажется сверх. Ничего не меняется."
    >
      {!allowed ? (
        <Alert tone="warning">
          Лимиты видит пользователь с правом «Лимиты». Попросите администратора или выдайте право в
          «Ролях».
        </Alert>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Лимит" required>
              <Select
                value={quotaId}
                onChange={(e) => {
                  setQuotaId(e.target.value);
                  setResult(null);
                }}
              >
                <option value="">— выберите —</option>
                {(quotas.items ?? []).map((q) => (
                  <option key={q.id} value={q.id}>
                    {tenantName(q.tenantId)}: {q.name} (
                    {q.capacityFromDocks ? 'по докам' : q.capacity})
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Новое число мест"
              hint={
                quota
                  ? `Сейчас: ${quota.capacityFromDocks ? 'по числу доков' : quota.capacity}.`
                  : undefined
              }
            >
              <Input
                type="number"
                min={0}
                step={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className="w-32"
              />
            </Field>
            <div className="flex items-end">
              <Button disabled={!quotaId || busy} onClick={() => void run()}>
                {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
                Показать последствия
              </Button>
            </div>
          </div>
          <ErrorAlert error={error} />
          {result ? (
            <div className="space-y-3" aria-live="polite">
              <Alert tone={result.overBy > 0 ? 'warning' : 'success'} title={result.quotaName}>
                {result.summary}
              </Alert>
              {result.inside.length > 0 ? (
                <Table>
                  <THead>
                    <TR>
                      <TH>Кто внутри</TH>
                      <TH>Тип</TH>
                      <TH>Въехал</TH>
                      <TH>После изменения</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {result.inside.map((v) => (
                      <TR key={v.visitId}>
                        <TD className="font-mono">{v.plate ?? v.personName ?? '—'}</TD>
                        <TD>{v.categoryName ?? '—'}</TD>
                        <TD>{v.timeIn ? formatInZone(v.timeIn, site.timezone) : '—'}</TD>
                        <TD>
                          {v.over ? (
                            <Badge tone="warning">сверх лимита</Badge>
                          ) : (
                            <Badge tone="success">в лимите</Badge>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

type Mode = 'plate' | 'example';
const MODE_LABEL: Record<Mode, string> = {
  plate: 'Проверить номер, как на посту',
  example: 'Проверить правила на примере',
};

/** Страница «Песочница правил»; `initial` — запрос из примера мастера (режим «на примере»). */
export function SandboxCard({ initial }: { initial?: SandboxCheck | undefined }) {
  const { can } = useMe();
  // Настоящие пропуска всех арендаторов видит тот, у кого есть право поста их видеть.
  const plateAllowed = can('pass.view_all_tenants');
  const [chosen, setMode] = useState<Mode>(initial ? 'example' : 'plate');
  const mode: Mode = plateAllowed ? chosen : 'example';
  return (
    <RequireSite>
      {(site) => (
        <>
          <div
            role="tablist"
            aria-label="Режим песочницы"
            className="mb-5 flex gap-1 overflow-x-auto border-b"
          >
            {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                disabled={m === 'plate' && !plateAllowed}
                title={
                  m === 'plate' && !plateAllowed
                    ? 'Нужно право «Просмотр пропусков всех арендаторов» — выдаётся в «Ролях».'
                    : undefined
                }
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  mode === m
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                } disabled:cursor-not-allowed disabled:opacity-50`}
                onClick={() => setMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          {mode === 'plate' ? (
            <PlateCheckBody site={site} />
          ) : (
            <SandboxBody site={site} initial={initial} />
          )}
          <WhatIfSection site={site} />
        </>
      )}
    </RequireSite>
  );
}
