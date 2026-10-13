import type { QuotaWhatIfResultSchema, SandboxCheck, SandboxResultSchema } from '@oxrana/contracts';
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
import { useEffect, useMemo, useRef, useState } from 'react';
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
export function VerdictBox({ result }: { result: Result }) {
  const { verdict, subject } = result;
  const style = VERDICT_STYLE[verdict.color] ?? VERDICT_STYLE.green;
  const [showTrace, setShowTrace] = useState(false);
  if (!style) return null;
  return (
    <div className="space-y-3">
      <div
        data-testid="verdict"
        data-color={verdict.color}
        data-code={verdict.code}
        className={`rounded-lg border-2 p-4 ${style.box}`}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {subject.directionLabel} · {subject.tenantName} · {subject.gateName}
          {subject.categoryName ? ` · ${subject.categoryName}` : ''}
          {subject.plateNorm ? ` · ${subject.plateNorm}` : ''}
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
        Время проверки: {subject.atLabel}. Движок {verdict.engineVersion}.
      </p>
      {result.assumptions.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {result.assumptions.map((a) => (
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
    <>
      <Section
        title="Что скажет система охраннику"
        description="Выберите арендатора, тип, КПП и время — песочница покажет тот же вердикт, что получит пост, с причинами и проверками. Ничего не записывается."
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
            {result && !error ? <VerdictBox result={result} /> : null}
          </div>
        </div>
      </Section>
      <WhatIfSection site={site} />
    </>
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

/** Страница «Песочница правил»; `initial` — запрос из примера мастера. */
export function SandboxCard({ initial }: { initial?: SandboxCheck | undefined }) {
  return <RequireSite>{(site) => <SandboxBody site={site} initial={initial} />}</RequireSite>;
}
