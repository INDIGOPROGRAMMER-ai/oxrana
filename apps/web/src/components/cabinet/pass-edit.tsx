import type { PassPatchResultSchema, PassView } from '@oxrana/contracts';
import {
  Alert,
  Button,
  DateTimeInput,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  formatInZone,
  Input,
  Select,
  Textarea,
  useToast,
} from '@oxrana/ui';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import { useRefresh } from '../../lib/data';
import { instantToLocal, localToIso } from '../../lib/dates';
import { extensionLimitMs, extensionOutcome } from '../../lib/pass-extension';
import { buildFormView } from '../../lib/pass-form-view';
import { passTitle } from '../../lib/pass-text';
import { useDebounced } from '../../lib/use-debounced';
import { useCabinet } from './cabinet-context';
import { PlatePreview } from './pass-form-fields';
import { type PassHints, PassHintsPanel } from './pass-hints-panel';

type PatchResult = z.infer<typeof PassPatchResultSchema>;

interface EditValues {
  plate: string;
  categoryId: string;
  validFrom: string;
  validTo: string;
  windowFrom: string;
  windowTo: string;
  destinationZoneId: string;
  dockId: string;
  comment: string;
  reason: string;
}

function initialOf(pass: PassView, timezone: string): EditValues {
  return {
    plate: pass.plateRaw ?? '',
    categoryId: pass.categoryId ?? '',
    validFrom: instantToLocal(pass.validFrom, timezone),
    validTo: instantToLocal(pass.validTo, timezone),
    windowFrom: instantToLocal(pass.windowFrom, timezone),
    windowTo: instantToLocal(pass.windowTo, timezone),
    destinationZoneId: pass.destinationZoneId ?? '',
    dockId: pass.dockId ?? '',
    comment: pass.comment ?? '',
    reason: '',
  };
}

/** Что пользователь изменил: PATCH шлёт только изменённые поля (CLAUDE.md п. 5). */
function changesOf(
  initial: EditValues,
  now: EditValues,
  timezone: string,
): Record<string, string | null> {
  const body: Record<string, string | null> = {};
  if (now.plate.trim() !== initial.plate.trim()) body.plate = now.plate.trim();
  if (now.categoryId !== initial.categoryId) body.categoryId = now.categoryId || null;
  for (const key of ['validFrom', 'validTo', 'windowFrom', 'windowTo'] as const) {
    if (now[key] !== initial[key]) body[key] = localToIso(now[key], timezone);
  }
  if (now.destinationZoneId !== initial.destinationZoneId) {
    body.destinationZoneId = now.destinationZoneId || null;
  }
  if (now.dockId !== initial.dockId) body.dockId = now.dockId || null;
  if (now.comment.trim() !== initial.comment.trim()) body.comment = now.comment.trim() || null;
  return body;
}

/**
 * Правка пропуска по этапам (ADR-023): до въезда — номер, тип, время, место назначения,
 * комментарий, с повторной проверкой подсказок; после въезда (визит открыт) — только комментарий и
 * «действует до»; после выезда или использования — только просмотр (кнопки правки нет). Если
 * пропуск проходил согласование, изменение номера, типа и срока уйдёт заявкой.
 */
export function PassEditDialog({ pass, onClose }: { pass: PassView | null; onClose: () => void }) {
  const { tenant, ctx, passForm } = useCabinet();
  const refresh = useRefresh();
  const toast = useToast();
  const timezone = ctx?.site.timezone ?? 'UTC';
  const initial = useMemo(() => (pass ? initialOf(pass, timezone) : null), [pass, timezone]);
  const [values, setValues] = useState<EditValues | null>(initial);
  const [error, setError] = useState<ErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues(initial);
    setError(null);
  }, [initial]);
  const set = <K extends keyof EditValues>(key: K, value: EditValues[K]) =>
    setValues((v) => (v ? { ...v, [key]: value } : v));

  const inside = pass?.phase === 'inside';
  const vehicle = pass?.participant === 'vehicle';
  const body = values && initial ? changesOf(initial, values, timezone) : {};
  const changed = Object.keys(body);

  // повторная проверка подсказок для того, что получится после правки
  const wanted = {
    participant: pass?.participant ?? 'vehicle',
    passType: pass?.passType ?? 'single',
    categoryId: vehicle ? (values?.categoryId ?? '') : '',
    destinationZoneId: values?.destinationZoneId ?? '',
    plate: vehicle ? (values?.plate.trim() ?? '') : '',
    personName: !vehicle ? (pass?.personName ?? '') : '',
  };
  const key = useDebounced(wanted);
  const hintsQuery = useQuery({
    queryKey: ['hints', tenant?.id, 'edit', pass?.id, key],
    queryFn: () =>
      api<PassHints>(`/tenants/${tenant?.id}/pass-hints`, {
        method: 'POST',
        body: {
          participant: key.participant,
          passType: key.passType,
          ...(key.categoryId ? { categoryId: key.categoryId } : {}),
          ...(key.destinationZoneId ? { destinationZoneId: key.destinationZoneId } : {}),
          ...(key.plate ? { plate: key.plate } : {}),
          ...(key.personName ? { personName: key.personName } : {}),
        },
      }),
    enabled: Boolean(tenant && pass && !inside),
    placeholderData: (previous) => previous,
  });
  const hints = hintsQuery.data;
  const view = useMemo(
    () =>
      ctx && passForm
        ? buildFormView({ form: passForm.form, ctx, enforced: passForm.enforced })
        : null,
    [ctx, passForm],
  );
  const blockers = (hints?.notices ?? []).filter((n) => n.severity === 'error');
  const needsReason = Boolean(pass?.started);
  const substantive = changed.some((k) =>
    ['plate', 'categoryId', 'validFrom', 'validTo'].includes(k),
  );
  const viaRequest = pass?.status === 'approved' && hints?.approval?.mode !== 'allow';
  // После въезда «действует до»: сокращение и продление в пределах максимума — сразу, сверх — заявкой (Q-85)
  const outcome =
    inside && pass && ctx && body.validTo !== undefined
      ? extensionOutcome(pass, ctx.site, body.validTo)
      : 'same';
  const limitMs = inside && pass && ctx ? extensionLimitMs(pass, ctx.site) : null;

  async function save() {
    if (!pass || !values) return;
    if (changed.length === 0) {
      setError({
        message: 'Вы ничего не изменили.',
        field: null,
        settingLink: null,
        code: null,
      });
      return;
    }
    if (needsReason && values.reason.trim().length < 3) {
      setError({
        message:
          'Пропуск уже действует — укажите причину изменения (хотя бы 3 символа): она попадёт в журнал.',
        field: 'reason',
        settingLink: null,
        code: 'reason_required',
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<PatchResult>(`/passes/${pass.id}`, {
        method: 'PATCH',
        body: { ...body, ...(values.reason.trim() ? { reason: values.reason.trim() } : {}) },
      });
      await refresh();
      toast(
        result.changeRequest
          ? 'Заявка на изменение отправлена согласующему — до решения действует прежний пропуск'
          : `Пропуск ${passTitle(pass)} изменён`,
      );
      onClose();
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  const ready = pass !== null && values !== null && ctx !== undefined && view !== null;
  return (
    <Dialog open={pass !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" data-testid="pass-edit">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {pass ? `Изменить ${passTitle(pass)}` : 'Изменить пропуск'}
          </DialogTitle>
          <DialogDescription>
            {inside
              ? 'Машина или человек уже на территории: можно изменить только комментарий и «действует до».'
              : 'Пропуск ещё не использован: можно поправить номер, тип, время, место назначения и комментарий.'}
          </DialogDescription>
        </DialogHeader>
        {ready && pass && values && ctx && view ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {!inside && vehicle ? (
              <>
                <Field label="Номер машины" className="sm:col-span-2">
                  <Input
                    value={values.plate}
                    onChange={(e) => set('plate', e.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    className="font-mono uppercase"
                    maxLength={30}
                  />
                  <PlatePreview text={values.plate} />
                </Field>
                <Field label="Тип транспорта">
                  <Select
                    value={values.categoryId}
                    onChange={(e) => set('categoryId', e.target.value)}
                  >
                    {view.categories.some((c) => c.id === values.categoryId) ? null : (
                      <option value={values.categoryId}>
                        {ctx.categories.find((c) => c.id === values.categoryId)?.name ?? '—'}
                      </option>
                    )}
                    {view.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            ) : null}
            {!inside && pass.passType !== 'single' ? (
              <Field label="Действует с" hint={`Время объекта: ${ctx.site.timezoneLabel}`}>
                <DateTimeInput
                  value={values.validFrom}
                  todayIso={ctx.today}
                  onChange={(v) => set('validFrom', v)}
                />
              </Field>
            ) : null}
            {!inside && pass.passType === 'single' ? (
              <Field label="Действует с" hint={`Время объекта: ${ctx.site.timezoneLabel}`}>
                <DateTimeInput
                  value={values.validFrom}
                  todayIso={ctx.today}
                  onChange={(v) => set('validFrom', v)}
                />
              </Field>
            ) : null}
            {pass.passType !== 'permanent' ? (
              <Field
                label="Действует до"
                hint={
                  inside
                    ? `Время объекта: ${ctx.site.timezoneLabel}.${
                        limitMs !== null
                          ? ` Продлить сразу можно до ${formatInZone(new Date(limitMs).toISOString(), ctx.site.timezone)} — дальше заявкой согласующему.`
                          : ''
                      }`
                    : undefined
                }
              >
                <DateTimeInput
                  value={values.validTo}
                  todayIso={ctx.today}
                  onChange={(v) => set('validTo', v)}
                />
              </Field>
            ) : null}
            {!inside && vehicle && view.fields.window !== 'hidden' && pass.windowFrom ? (
              <>
                <Field label="Окно прибытия, с">
                  <DateTimeInput
                    value={values.windowFrom}
                    todayIso={ctx.today}
                    onChange={(v) => set('windowFrom', v)}
                  />
                </Field>
                <Field label="Окно прибытия, по">
                  <DateTimeInput
                    value={values.windowTo}
                    todayIso={ctx.today}
                    onChange={(v) => set('windowTo', v)}
                  />
                </Field>
              </>
            ) : null}
            {!inside && view.fields.destination !== 'hidden' && view.zones.length > 0 ? (
              <Field label="Место назначения">
                <Select
                  value={values.destinationZoneId}
                  onChange={(e) => set('destinationZoneId', e.target.value)}
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
            {!inside &&
            vehicle &&
            ctx.docks.length > 0 &&
            (values.dockId || ctx.tenant.trucksDockRequired) ? (
              <Field label="Док">
                <Select value={values.dockId} onChange={(e) => set('dockId', e.target.value)}>
                  <option value="">Без дока</option>
                  {ctx.docks.map((d) => (
                    <option key={d.id} value={d.id}>
                      Док {d.number}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {view.fields.comment !== 'hidden' ? (
              <Field label="Комментарий" className="sm:col-span-2">
                <Textarea
                  value={values.comment}
                  onChange={(e) => set('comment', e.target.value)}
                  rows={2}
                  maxLength={2000}
                />
              </Field>
            ) : null}
            {needsReason ? (
              <Field
                label="Причина изменения"
                required
                hint="Пропуск уже действует — причина попадёт в журнал."
                className="sm:col-span-2"
              >
                <Textarea
                  value={values.reason}
                  onChange={(e) => set('reason', e.target.value)}
                  rows={2}
                  maxLength={500}
                />
              </Field>
            ) : null}
          </div>
        ) : (
          <div role="status" className="text-sm text-muted-foreground">
            Загрузка…
          </div>
        )}
        {!inside && ready ? <PassHintsPanel hints={hints} loading={hintsQuery.isFetching} /> : null}
        {inside && outcome === 'beyond' ? (
          <Alert tone="warning" data-testid="edit-beyond-max">
            Срок выходит за максимум, который можно оформить без согласования, — уйдёт согласующему
            заявкой. До решения действует прежний срок.
          </Alert>
        ) : inside && outcome === 'within' ? (
          <Alert tone="info" data-testid="edit-within-max">
            Продление в пределах максимума — применится сразу.
          </Alert>
        ) : null}
        {!inside && viaRequest && substantive ? (
          <Alert tone="warning" data-testid="edit-via-request">
            Пропуск проходил согласование: изменение номера, типа и срока уйдёт согласующему
            заявкой. До решения действует прежний пропуск, комментарий изменится сразу.
          </Alert>
        ) : null}
        <ErrorAlert error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Закрыть
          </Button>
          <Button
            disabled={busy || !ready || blockers.length > 0}
            onClick={() => void save()}
            title={blockers[0]?.text}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
