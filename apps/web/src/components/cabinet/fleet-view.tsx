import {
  type BatchResult,
  FleetVehicleCreateSchema,
  FleetVehiclePatchSchema,
  type FleetVehicleViewSchema,
  type ParsedRow,
} from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import {
  Alert,
  BatchInput,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  EmptyState,
  Field,
  type FormController,
  Input,
  Section,
  Select,
  Textarea,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { Pencil, Plus, Truck } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import {
  columnsLabel,
  type BatchColumn as FleetColumnKey,
  fleetBatchLayout,
  placeholderOf,
  templateTitles,
} from '../../lib/batch-columns';
import { useApi, useMe, useMutate } from '../../lib/data';
import { type FleetLine, ignoredColumnTitles, parseFleetRows, tableOf } from '../../lib/pass-batch';
import { buildFormView } from '../../lib/pass-form-view';
import {
  findMultiPlateLines,
  multiPlateQuestion,
  splitMultiPlateLines,
} from '../../lib/plate-split';
import { assertValid } from '../cards/tenant-rule-helpers';
import { DeleteAction, LoadError } from '../common';
import { useCabinet } from './cabinet-context';
import { RepeatDay } from './repeat-day';

type Vehicle = z.infer<typeof FleetVehicleViewSchema>;

interface Values {
  plate: string;
  categoryId: string;
  brand: string;
  driverName: string;
  driverPhone: string;
  dockId: string;
  comment: string;
}
const EMPTY: Values = {
  plate: '',
  categoryId: '',
  brand: '',
  driverName: '',
  driverPhone: '',
  dockId: '',
  comment: '',
};

/** Поля машины автопарка — те же, что в форме пропуска: скрытое настройкой формы не показывается. */
function useFleetFields() {
  const { ctx, passForm } = useCabinet();
  return useMemo(
    () =>
      ctx && passForm
        ? buildFormView({ form: passForm.form, ctx, enforced: passForm.enforced }).fields
        : null,
    [ctx, passForm],
  );
}

function Fields({ f }: { f: FormController<Values> }) {
  const { ctx } = useCabinet();
  const mode = useFleetFields();
  const { register, watch } = f.form;
  const available = (ctx?.categories ?? []).filter((c) => c.available);
  const plate = watch('plate');
  const preview = plate.trim() ? normalizePlate(plate) : null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Номер машины" required error={f.fieldError('plate')} className="sm:col-span-2">
        <Input
          {...register('plate')}
          className="font-mono uppercase"
          autoComplete="off"
          maxLength={30}
        />
        {preview?.norm ? (
          <p className="text-xs text-muted-foreground">
            Запишется как{' '}
            <span className="font-mono font-medium text-foreground">{preview.norm}</span>
          </p>
        ) : null}
      </Field>
      <Field label="Тип транспорта" required error={f.fieldError('categoryId')}>
        <Select {...register('categoryId')}>
          <option value="">Выберите тип</option>
          {available.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {mode && mode.brand !== 'hidden' ? (
        <Field label="Марка" required={mode.brand === 'required'} error={f.fieldError('brand')}>
          <Input {...register('brand')} maxLength={100} />
        </Field>
      ) : null}
      {mode && mode.driverName !== 'hidden' ? (
        <Field
          label="Водитель"
          required={mode.driverName === 'required'}
          error={f.fieldError('driverName')}
        >
          <Input {...register('driverName')} maxLength={200} />
        </Field>
      ) : null}
      {mode && mode.driverPhone !== 'hidden' ? (
        <Field
          label="Телефон водителя"
          required={mode.driverPhone === 'required'}
          error={f.fieldError('driverPhone')}
        >
          <Input type="tel" {...register('driverPhone')} maxLength={30} />
        </Field>
      ) : null}
      {(ctx?.docks.length ?? 0) > 0 ? (
        <Field
          label="Док по умолчанию"
          hint="Подставляется в пропуск на эту машину."
          error={f.fieldError('dockId')}
        >
          <Select {...register('dockId')}>
            <option value="">Без дока</option>
            {(ctx?.docks ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                Док {d.number}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {mode && mode.comment !== 'hidden' ? (
        <Field
          label="Комментарий по умолчанию"
          required={mode.comment === 'required'}
          hint="Подставляется в пропуск на эту машину."
          error={f.fieldError('comment')}
          className="sm:col-span-2"
        >
          <Textarea rows={2} {...register('comment')} maxLength={2000} />
        </Field>
      ) : null}
    </div>
  );
}

const nullable = (v: string) => (v.trim() === '' ? null : v.trim());

function CreateForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<Values>({
    schema: FleetVehicleCreateSchema,
    initial: EMPTY,
    toBody: (v) => ({
      plate: v.plate.trim(),
      categoryId: v.categoryId,
      ...(v.brand.trim() ? { brand: v.brand.trim() } : {}),
      ...(v.driverName.trim() ? { driverName: v.driverName.trim() } : {}),
      ...(v.driverPhone.trim() ? { driverPhone: v.driverPhone.trim() } : {}),
      ...(v.dockId ? { dockId: v.dockId } : {}),
      ...(v.comment.trim() ? { comment: v.comment.trim() } : {}),
    }),
    onCreate: async (body) => {
      await mutate(`/tenants/${tenantId}/fleet`, 'POST', body);
      toast('Машина добавлена в автопарк');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить в автопарк">
      <Fields f={f} />
    </EditForm>
  );
}

function EditVehicle({ vehicle, onDone }: { vehicle: Vehicle; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<Values>({
    values: {
      plate: vehicle.plateRaw,
      categoryId: vehicle.categoryId,
      brand: vehicle.brand ?? '',
      driverName: vehicle.driverName ?? '',
      driverPhone: vehicle.driverPhone ?? '',
      dockId: vehicle.dockId ?? '',
      comment: vehicle.comment ?? '',
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.plate !== undefined) body.plate = patch.plate.trim();
      if (patch.categoryId !== undefined) body.categoryId = patch.categoryId;
      if (patch.brand !== undefined) body.brand = nullable(patch.brand);
      if (patch.driverName !== undefined) body.driverName = nullable(patch.driverName);
      if (patch.driverPhone !== undefined) body.driverPhone = nullable(patch.driverPhone);
      if (patch.dockId !== undefined) body.dockId = patch.dockId === '' ? null : patch.dockId;
      if (patch.comment !== undefined) body.comment = nullable(patch.comment);
      assertValid(FleetVehiclePatchSchema, body);
      await mutate(`/fleet/${vehicle.id}`, 'PATCH', body);
      toast('Машина сохранена');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <Fields f={f} />
    </EditForm>
  );
}

/**
 * Пакетная вставка машин: колонки — из той же действующей настройки формы, что и форма пропуска
 * (скрытое поле — нет колонки, обязательное — обязательная колонка), с проверкой при вводе.
 */
function BatchFleet({ tenantId }: { tenantId: string }) {
  const { ctx } = useCabinet();
  const mode = useFleetFields();
  const mutate = useMutate();
  const catalog = useMemo(
    () => ({
      categories: (ctx?.categories ?? []).filter((c) => c.available),
      docks: ctx?.docks ?? [],
      defaultCategoryId: ctx?.tenant.defaultCategoryId ?? null,
    }),
    [ctx],
  );
  const layout = useMemo(
    () =>
      mode
        ? fleetBatchLayout({ fields: mode, hasDocks: catalog.docks.length > 0, zoneChoice: false })
        : null,
    [mode, catalog.docks.length],
  );
  const parse = useCallback(
    (text: string): ParsedRow<FleetLine>[] => (layout ? parseFleetRows(text, catalog, layout) : []),
    [catalog, layout],
  );
  const toBody = (rows: FleetLine[]) =>
    rows.map((r) => ({
      plate: r.plate,
      categoryId: r.categoryId,
      ...(r.brand ? { brand: r.brand } : {}),
      ...(r.driverName ? { driverName: r.driverName } : {}),
      ...(r.driverPhone ? { driverPhone: r.driverPhone } : {}),
      ...(r.comment ? { comment: r.comment } : {}),
      ...(r.dockId ? { dockId: r.dockId } : {}),
    }));
  const columns = useMemo(() => {
    const render: Record<string, { header: string; render: (v: FleetLine) => ReactNode }> = {
      plate: {
        header: 'Номер',
        render: (v) => <span className="font-mono">{v.plate}</span>,
      },
      type: { header: 'Тип', render: (v) => v.categoryName },
      brand: { header: 'Марка', render: (v) => v.brand || '—' },
      driver: { header: 'Водитель', render: (v) => v.driverName || '—' },
      phone: { header: 'Телефон', render: (v) => v.driverPhone || '—' },
      comment: { header: 'Комментарий', render: (v) => v.comment || '—' },
      dock: { header: 'Док', render: (v) => (v.dockNumber ? `Док ${v.dockNumber}` : '—') },
    };
    return (layout?.columns ?? []).flatMap((c) => {
      const column = render[c.key as FleetColumnKey];
      return column ? [column] : [];
    });
  }, [layout]);
  if (!layout) return null;
  return (
    <BatchInput<FleetLine>
      label="Вставьте машины из Excel"
      placeholder={placeholderOf(layout.columns, '')}
      help={`${columnsLabel(layout.columns)} Комментарий и док — по умолчанию для машины, они подставляются в пропуск на неё.`}
      template={{
        fileName: 'шаблон-автопарк.xlsx',
        titles: templateTitles(layout.columns),
      }}
      suggest={(text) => {
        const lines = findMultiPlateLines(text);
        return lines.length > 0
          ? { message: multiPlateQuestion(lines), apply: splitMultiPlateLines }
          : null;
      }}
      notice={(text) => {
        const ignored = ignoredColumnTitles(tableOf(text), layout);
        return ignored.length > 0 ? (
          <Alert tone="warning" data-testid="batch-ignored">
            Колонки «{ignored.join('», «')}» отключены настройкой формы пропуска — значения из них
            не сохранятся.
          </Alert>
        ) : null;
      }}
      parse={parse}
      columns={columns}
      check={(rows) =>
        api<BatchResult>(`/tenants/${tenantId}/fleet/batch`, {
          method: 'POST',
          body: { items: toBody(rows), dryRun: true },
        })
      }
      commit={(rows) =>
        mutate<BatchResult>(`/tenants/${tenantId}/fleet/batch`, 'POST', { items: toBody(rows) })
      }
      commitLabel={(n) => `Добавить машин: ${n}`}
    />
  );
}

/** Автопарк (08_): постоянные машины арендатора; пропуск из автопарка — в один клик. */
export function FleetView() {
  const { can } = useMe();
  const { tenant, ctx, passForm } = useCabinet();
  const list = useApi<{ items: Vehicle[] }>(tenant ? `/tenants/${tenant.id}/fleet` : null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const canManage = can('fleet.manage');
  const canCreate = ['pass.create.single', 'pass.create.multi', 'pass.create.permanent'].some((p) =>
    can(p),
  );
  const items = list.data?.items ?? [];
  const category = (id: string) => ctx?.categories.find((c) => c.id === id)?.name ?? '—';
  if (!tenant) return null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!canManage}
          title={canManage ? undefined : 'Автопарк ведёт ответственный вашей компании.'}
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden /> Добавить машину
        </Button>
        {canCreate && passForm?.form.repeatYesterday === true ? <RepeatDay /> : null}
        {!canManage ? (
          <span className="text-xs text-muted-foreground">
            Автопарк ведёт ответственный вашей компании — у вас нет права его менять.
          </span>
        ) : null}
      </div>

      {list.error ? <LoadError error={list.error} retry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : items.length === 0 && !list.error ? (
        <EmptyState
          icon={Truck}
          title="В автопарке пока пусто"
          hint="Добавьте постоянные машины компании — пропуск на них оформляется одним нажатием."
        />
      ) : (
        <ul className="space-y-2" aria-label="Автопарк" data-testid="fleet-list">
          {items.map((v) => (
            <li key={v.id}>
              <Card data-testid="fleet-row">
                <CardContent className="flex flex-wrap items-center gap-3 pt-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-base font-semibold">{v.plateNorm}</p>
                    <p className="text-sm text-muted-foreground">
                      {category(v.categoryId)}
                      {v.brand ? ` · ${v.brand}` : ''}
                      {v.driverName ? ` · ${v.driverName}` : ''}
                      {v.driverPhone ? ` · ${v.driverPhone}` : ''}
                      {v.dockId
                        ? ` · док ${ctx?.docks.find((d) => d.id === v.dockId)?.number ?? '—'}`
                        : ''}
                    </p>
                    {v.comment ? (
                      <p className="text-xs text-muted-foreground">{v.comment}</p>
                    ) : null}
                  </div>
                  {canCreate ? (
                    <Button asChild size="sm">
                      <Link to="/cabinet/passes/new" search={{ fleet: v.id }}>
                        Оформить пропуск
                      </Link>
                    </Button>
                  ) : null}
                  {canManage ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить: ${v.plateNorm}`}
                        onClick={() => setEditing(v)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="fleet"
                        id={v.id}
                        name={`машину ${v.plateNorm}`}
                        title="Машина автопарка"
                      />
                    </>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <Section
          title="Вставить из Excel"
          description="Для первого заполнения или большого обновления автопарка."
        >
          <BatchFleet tenantId={tenant.id} />
        </Section>
      ) : null}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новая машина автопарка</DialogTitle>
            <DialogDescription>
              Номер, тип и водитель — для быстрого оформления пропусков.
            </DialogDescription>
          </DialogHeader>
          <CreateForm tenantId={tenant.id} onDone={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Машина {editing?.plateNorm}</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? <EditVehicle vehicle={editing} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
