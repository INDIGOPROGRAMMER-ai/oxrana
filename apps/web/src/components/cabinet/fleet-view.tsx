import {
  type BatchResult,
  FleetVehicleCreateSchema,
  FleetVehiclePatchSchema,
  type FleetVehicleViewSchema,
  type ParsedRow,
} from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import {
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
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { Pencil, Plus, Truck } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { z } from 'zod';
import { api } from '../../lib/api';
import { useApi, useMe, useMutate } from '../../lib/data';
import { type FleetLine, parseFleetRows } from '../../lib/pass-batch';
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
}
const EMPTY: Values = { plate: '', categoryId: '', brand: '', driverName: '', driverPhone: '' };

function Fields({ f }: { f: FormController<Values> }) {
  const { ctx } = useCabinet();
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
      <Field label="Марка" error={f.fieldError('brand')}>
        <Input {...register('brand')} maxLength={100} />
      </Field>
      <Field label="Водитель" error={f.fieldError('driverName')}>
        <Input {...register('driverName')} maxLength={200} />
      </Field>
      <Field label="Телефон водителя" error={f.fieldError('driverPhone')}>
        <Input type="tel" {...register('driverPhone')} maxLength={30} />
      </Field>
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
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.plate !== undefined) body.plate = patch.plate.trim();
      if (patch.categoryId !== undefined) body.categoryId = patch.categoryId;
      if (patch.brand !== undefined) body.brand = nullable(patch.brand);
      if (patch.driverName !== undefined) body.driverName = nullable(patch.driverName);
      if (patch.driverPhone !== undefined) body.driverPhone = nullable(patch.driverPhone);
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

/** Пакетная вставка машин (Номер · Тип · Марка · Водитель · Телефон) с проверкой при вводе. */
function BatchFleet({ tenantId }: { tenantId: string }) {
  const { ctx } = useCabinet();
  const mutate = useMutate();
  const catalog = useMemo(
    () => ({
      categories: (ctx?.categories ?? []).filter((c) => c.available),
      docks: [],
      defaultCategoryId: ctx?.tenant.defaultCategoryId ?? null,
    }),
    [ctx],
  );
  const parse = useCallback(
    (text: string): ParsedRow<FleetLine>[] => parseFleetRows(text, catalog),
    [catalog],
  );
  const toBody = (rows: FleetLine[]) =>
    rows.map((r) => ({
      plate: r.plate,
      categoryId: r.categoryId,
      ...(r.brand ? { brand: r.brand } : {}),
      ...(r.driverName ? { driverName: r.driverName } : {}),
      ...(r.driverPhone ? { driverPhone: r.driverPhone } : {}),
    }));
  const columns = useMemo(
    () => [
      { header: 'Номер', render: (v: FleetLine) => <span className="font-mono">{v.plate}</span> },
      { header: 'Тип', render: (v: FleetLine) => v.categoryName },
      { header: 'Марка', render: (v: FleetLine) => v.brand || '—' },
      { header: 'Водитель', render: (v: FleetLine) => v.driverName || '—' },
    ],
    [],
  );
  return (
    <BatchInput<FleetLine>
      label="Вставьте машины из Excel"
      placeholder={'А123ВС174\tфура\tVolvo\tИванов И. И.\t+7 900 000-00-00'}
      help="Колонки: Номер · Тип · Марка · Водитель · Телефон."
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
  const { tenant, ctx } = useCabinet();
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
        {canCreate ? <RepeatDay /> : null}
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
                    </p>
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
