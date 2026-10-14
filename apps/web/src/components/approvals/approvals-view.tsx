import type { ApprovalViewSchema, CabinetContext } from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  DateTimeInput,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  EmptyState,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  Input,
  Select,
  SiteTime,
  Textarea,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { CheckCheck, CheckCircle2, Pencil, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { useApi, useMutate } from '../../lib/data';
import { instantToLocal, localToIso } from '../../lib/dates';
import { PASS_TYPE_LABEL, passTitle } from '../../lib/pass-text';
import { useSite } from '../../lib/site-context';
import { PassFields } from '../cabinet/pass-fields';
import { LoadError } from '../common';
import { ReasonDialog } from '../reason-dialog';

type Approval = z.infer<typeof ApprovalViewSchema>;

const SOURCE: Record<string, string> = {
  web: 'из кабинета',
  pwa: 'с телефона',
  bot: 'через бота',
  gate: 'с поста охраны',
  import: 'импорт',
  api: 'по API',
};

interface Values {
  categoryId: string;
  dockId: string;
  destinationZoneId: string;
  validFrom: string;
  validTo: string;
  windowFrom: string;
  windowTo: string;
  comment: string;
  note: string;
}

/** «Одобрить с изменениями» (сценарий 24): меняются только отмеченные поля — они увидит арендатор. */
function ApproveWithChanges({
  item,
  ctx,
  open,
  onOpenChange,
}: {
  item: Approval;
  ctx: CabinetContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const { pass } = item;
  const tz = ctx.site.timezone;
  const f = useEditForm<Values>({
    values: {
      categoryId: pass.categoryId ?? '',
      dockId: pass.dockId ?? '',
      destinationZoneId: pass.destinationZoneId ?? '',
      validFrom: instantToLocal(pass.validFrom, tz),
      validTo: instantToLocal(pass.validTo, tz),
      windowFrom: instantToLocal(pass.windowFrom, tz),
      windowTo: instantToLocal(pass.windowTo, tz),
      comment: pass.comment ?? '',
      note: '',
    },
    onPatch: async (patch) => {
      const changes: Record<string, unknown> = {};
      if (patch.categoryId) changes.categoryId = patch.categoryId;
      if (patch.dockId !== undefined) changes.dockId = patch.dockId || null;
      if (patch.destinationZoneId !== undefined) {
        changes.destinationZoneId = patch.destinationZoneId || null;
      }
      if (patch.validFrom) changes.validFrom = localToIso(patch.validFrom, tz);
      if (patch.validTo !== undefined) changes.validTo = localToIso(patch.validTo, tz);
      if (patch.windowFrom !== undefined) changes.windowFrom = localToIso(patch.windowFrom, tz);
      if (patch.windowTo !== undefined) changes.windowTo = localToIso(patch.windowTo, tz);
      if (patch.comment !== undefined) changes.comment = patch.comment.trim() || null;
      const note = patch.note?.trim();
      await mutate(`/passes/${pass.id}/approve`, 'POST', {
        ...(note ? { note } : {}),
        ...(Object.keys(changes).length > 0 ? { changes } : {}),
      });
      toast(`Пропуск ${passTitle(pass)} одобрен с изменениями`);
      onOpenChange(false);
    },
  });
  const { register, watch, setValue } = f.form;
  const set = (key: keyof Values, value: string) => setValue(key, value, { shouldDirty: true });
  const today = ctx.today;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Одобрить с изменениями: {passTitle(pass)}</DialogTitle>
          <DialogDescription>
            Измените нужные поля — арендатор увидит, что именно вы изменили. Время — по объекту (
            {ctx.site.timezoneLabel}).
          </DialogDescription>
        </DialogHeader>
        <EditForm form={f} submitLabel="Одобрить с изменениями">
          <div className="grid gap-4 sm:grid-cols-2">
            {pass.participant === 'vehicle' ? (
              <Field label="Тип транспорта" error={f.fieldError('categoryId')}>
                <Select {...register('categoryId')}>
                  {ctx.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {pass.participant === 'vehicle' ? (
              <Field label="Док" error={f.fieldError('dockId')} hint="Доки арендатора.">
                <Select {...register('dockId')}>
                  <option value="">Без дока</option>
                  {ctx.docks.map((d) => (
                    <option key={d.id} value={d.id}>
                      Док {d.number}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Место назначения" error={f.fieldError('destinationZoneId')}>
              <Select {...register('destinationZoneId')}>
                <option value="">Не указано</option>
                {ctx.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div />
            <Field label="Действует с" error={f.fieldError('validFrom')}>
              <DateTimeInput
                value={watch('validFrom')}
                todayIso={today}
                onChange={(v) => set('validFrom', v)}
              />
            </Field>
            <Field
              label="Действует по"
              error={f.fieldError('validTo')}
              hint={
                pass.passType === 'permanent' ? 'У постоянного пропуска окончания нет.' : undefined
              }
            >
              <DateTimeInput
                value={watch('validTo')}
                todayIso={today}
                disabled={pass.passType === 'permanent'}
                onChange={(v) => set('validTo', v)}
              />
            </Field>
            <Field label="Окно прибытия, с" error={f.fieldError('windowFrom')}>
              <DateTimeInput
                value={watch('windowFrom')}
                todayIso={today}
                onChange={(v) => set('windowFrom', v)}
              />
            </Field>
            <Field label="Окно прибытия, по" error={f.fieldError('windowTo')}>
              <DateTimeInput
                value={watch('windowTo')}
                todayIso={today}
                onChange={(v) => set('windowTo', v)}
              />
            </Field>
            <Field
              label="Комментарий к пропуску"
              error={f.fieldError('comment')}
              className="sm:col-span-2"
            >
              <Textarea {...register('comment')} rows={2} maxLength={2000} />
            </Field>
            <Field
              label="Комментарий согласующего"
              hint="Увидит арендатор рядом с решением."
              error={f.fieldError('note')}
              className="sm:col-span-2"
            >
              <Input {...register('note')} maxLength={1000} />
            </Field>
          </div>
        </EditForm>
      </DialogContent>
    </Dialog>
  );
}

/** Карточка согласования: все поля будущего пропуска и три решения. */
function ApprovalCard({ item }: { item: Approval }) {
  const mutate = useMutate();
  const toast = useToast();
  const { pass } = item;
  const cabinet = useApi<CabinetContext>(`/tenants/${pass.tenantId}/cabinet`);
  const [rejecting, setRejecting] = useState(false);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const ctx = cabinet.data;

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/passes/${pass.id}/approve`, 'POST', {});
      toast(`Пропуск ${passTitle(pass)} одобрен`);
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="approval-card" data-pass={passTitle(pass)}>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-mono text-lg font-semibold">{passTitle(pass)}</p>
            <p className="text-sm text-muted-foreground">
              {item.tenantName} · {PASS_TYPE_LABEL[pass.passType]}
            </p>
          </div>
          <Badge tone="warning">На согласовании</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Заказал: {item.createdByName ?? 'неизвестно'} (
          {SOURCE[pass.createdVia] ?? pass.createdVia}
          {pass.batchId ? ', пакетом' : ''}), <SiteTime value={pass.createdAt} />
        </p>
        {cabinet.error ? (
          <LoadError error={cabinet.error} retry={() => void cabinet.refetch()} />
        ) : (
          <PassFields pass={pass} ctx={ctx} />
        )}
        <ErrorAlert error={error} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void approve()}>
            <CheckCircle2 aria-hidden /> Одобрить
          </Button>
          <Button variant="outline" disabled={!ctx} onClick={() => setChanging(true)}>
            <Pencil aria-hidden /> Одобрить с изменениями…
          </Button>
          <Button variant="outline" onClick={() => setRejecting(true)}>
            <XCircle aria-hidden className="text-destructive" /> Отклонить…
          </Button>
        </div>
        {ctx ? (
          <ApproveWithChanges item={item} ctx={ctx} open={changing} onOpenChange={setChanging} />
        ) : null}
        <ReasonDialog
          open={rejecting}
          onOpenChange={setRejecting}
          title={`Отклонить пропуск ${passTitle(pass)}?`}
          description="Причину увидит арендатор рядом со статусом «Отклонено»."
          confirmLabel="Отклонить пропуск"
          destructive
          onConfirm={async (reason) => {
            await mutate(`/passes/${pass.id}/reject`, 'POST', { note: reason });
            toast(`Пропуск ${passTitle(pass)} отклонён`);
          }}
        />
      </CardContent>
    </Card>
  );
}

/** Очередь согласований объекта: новые заявки появляются сами (события объекта), без F5. */
export function ApprovalsView() {
  const { site } = useSite();
  const list = useApi<{ items: Approval[] }>(site ? `/sites/${site.id}/approvals` : null);
  const items = list.data?.items ?? [];
  if (!site) return null;
  if (list.error) return <LoadError error={list.error} retry={() => void list.refetch()} />;
  if (list.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Загрузка…
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={CheckCheck}
        title="Заявок на согласование нет"
        hint="Когда арендатор оформит пропуск, требующий согласования, он появится здесь сам — обновлять страницу не нужно."
      />
    );
  }
  return (
    <div className="space-y-4">
      <Alert tone="info">Заявок на согласование: {items.length}. Старые — выше.</Alert>
      <ul className="space-y-4" aria-label="Заявки на согласование">
        {items.map((item) => (
          <li key={item.pass.id}>
            <ApprovalCard item={item} />
          </li>
        ))}
      </ul>
    </div>
  );
}
