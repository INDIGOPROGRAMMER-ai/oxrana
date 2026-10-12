import {
  type BatchResult,
  DOCK_KINDS,
  type DockKind,
  expandNumberSpec,
  type ParsedRow,
  ZONE_KINDS,
  type ZoneKind,
} from '@oxrana/contracts';
import {
  Badge,
  BatchInput,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  Field,
  Input,
  Section,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Pencil } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { z } from 'zod';
import { api } from '../../lib/api';
import { type DockView, useDocks, useMutate, useZones, type ZoneView } from '../../lib/data';
import { DOCK_KIND_LABEL, ZONE_KIND_LABEL } from '../../lib/labels';
import { DeleteAction, Empty, LoadError, RequireSite } from '../common';

// ——— зоны ———

const ZoneFormSchema = z.strictObject({
  name: z.string().trim().min(1, 'Заполните название').max(200),
  kind: z.enum(ZONE_KINDS, { error: 'Выберите вид зоны' }),
});

function ZoneCreateForm({ siteId }: { siteId: string }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<{ name: string; kind: ZoneKind | '' }>({
    schema: ZoneFormSchema,
    initial: { name: '', kind: '' },
    onCreate: async (body) => {
      await mutate(`/sites/${siteId}/zones`, 'POST', body);
      toast('Зона добавлена');
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить зону">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Название зоны" required error={f.fieldError('name')}>
          <Input {...f.form.register('name')} placeholder="Например, «Здание 2» или «Двор»" />
        </Field>
        <Field label="Вид зоны" required error={f.fieldError('kind')}>
          <Select {...f.form.register('kind')}>
            <option value="">— выберите —</option>
            {ZONE_KINDS.map((k) => (
              <option key={k} value={k}>
                {ZONE_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </EditForm>
  );
}

function ZoneEditForm({ zone, onDone }: { zone: ZoneView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<{ name: string; kind: ZoneKind }>({
    values: { name: zone.name, kind: zone.kind },
    schema: ZoneFormSchema.partial(),
    onPatch: async (patch) => {
      await mutate(`/zones/${zone.id}`, 'PATCH', patch);
      toast('Зона сохранена');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <Field label="Название зоны" error={f.fieldError('name')}>
        <Input {...f.form.register('name')} />
      </Field>
      <Field label="Вид зоны" error={f.fieldError('kind')}>
        <Select {...f.form.register('kind')}>
          {ZONE_KINDS.map((k) => (
            <option key={k} value={k}>
              {ZONE_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
    </EditForm>
  );
}

// ——— доки ———

function DockEditForm({
  dock,
  zones,
  onDone,
}: {
  dock: DockView;
  zones: ZoneView[];
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<{
    number: string;
    zoneId: string;
    kind: DockKind;
    countsInQuota: boolean;
    size: string;
  }>({
    values: {
      number: dock.number,
      zoneId: dock.zoneId ?? '',
      kind: dock.kind,
      countsInQuota: dock.countsInQuota,
      size: dock.size ?? '',
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = { ...patch };
      if (patch.zoneId !== undefined) body.zoneId = patch.zoneId || null;
      if (patch.size !== undefined) body.size = patch.size.trim() || null;
      await mutate(`/docks/${dock.id}`, 'PATCH', body);
      toast('Док сохранён');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <Field label="Номер дока" error={f.fieldError('number')}>
        <Input {...f.form.register('number')} />
      </Field>
      <Field label="Зона" error={f.fieldError('zoneId')}>
        <Select {...f.form.register('zoneId')}>
          <option value="">— не указана —</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Вид дока" error={f.fieldError('kind')}>
        <Select {...f.form.register('kind')}>
          {DOCK_KINDS.map((k) => (
            <option key={k} value={k}>
              {DOCK_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Размер" hint="Необязательно, например «40 футов»." error={f.fieldError('size')}>
        <Input {...f.form.register('size')} />
      </Field>
      <Checkbox
        label="Считается в лимите грузовых"
        hint="Док входит в число доков арендатора, по которому можно считать лимит."
        {...f.form.register('countsInQuota')}
      />
    </EditForm>
  );
}

function DocksBatch({ siteId, zones }: { siteId: string; zones: ZoneView[] }) {
  const mutate = useMutate();
  const [zoneId, setZoneId] = useState('');
  const [kind, setKind] = useState<DockKind>('leveller');
  const [countsInQuota, setCountsInQuota] = useState(true);

  const parse = useCallback((text: string): ParsedRow<string>[] => {
    const spec = expandNumberSpec(text);
    const rows: ParsedRow<string>[] = spec.values.map((value, i) => ({
      line: i + 1,
      value,
      ...(spec.duplicates.includes(value) ? { note: 'повторялся в списке — оставлен один' } : {}),
    }));
    for (const [i, e] of spec.errors.entries()) {
      rows.push({ line: spec.values.length + i + 1, error: e.message });
    }
    return rows;
  }, []);

  const body = (numbers: string[], dryRun: boolean) => ({
    numbers,
    dryRun,
    ...(zoneId ? { zoneId } : {}),
    kind,
    countsInQuota,
  });
  const check = (numbers: string[]) =>
    api<BatchResult>(`/sites/${siteId}/docks/batch`, { method: 'POST', body: body(numbers, true) });
  const commit = (numbers: string[]) =>
    mutate<BatchResult>(`/sites/${siteId}/docks/batch`, 'POST', body(numbers, false));
  const columns = useMemo(() => [{ header: 'Док', render: (v: string) => v }], []);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Зона" hint="Для всех добавляемых доков. Необязательно.">
          <Select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">— не указана —</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Вид дока"
          hint="Один для всех добавляемых; у каждого дока потом можно изменить."
        >
          <Select value={kind} onChange={(e) => setKind(e.target.value as DockKind)}>
            {DOCK_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOCK_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox
            label="Считаются в лимите грузовых"
            checked={countsInQuota}
            onChange={(e) => setCountsInQuota(e.target.checked)}
          />
        </div>
      </div>
      <BatchInput<string>
        label="Номера доков"
        placeholder={'1–72\nили списком: 1-10, 15, 20..22'}
        help="Диапазон «1–72», список через запятую или по одному в строке. Буквы сохраняются: «З1–З7»."
        parse={parse}
        columns={columns}
        check={check}
        checkKey={`${zoneId}|${kind}|${countsInQuota}`}
        commit={commit}
        commitLabel={(n) => `Добавить доков: ${n}`}
      />
    </div>
  );
}

/**
 * Карточка «Доки и зоны» (шаг 5): зоны (здания, двор, парковка…) и доки. Доки добавляются
 * диапазоном «1–72» или вставкой списка, с предпросмотром до сохранения.
 */
export function DocksCard() {
  return <RequireSite>{(site) => <DocksBody siteId={site.id} />}</RequireSite>;
}

function DocksBody({ siteId }: { siteId: string }) {
  const zones = useZones(siteId);
  const docks = useDocks(siteId);
  const [editingZone, setEditingZone] = useState<ZoneView | null>(null);
  const [editingDock, setEditingDock] = useState<DockView | null>(null);
  const failed = zones.error ?? docks.error;
  if (failed)
    return (
      <LoadError
        error={failed}
        retry={() => {
          void zones.refetch();
          void docks.refetch();
        }}
      />
    );
  const zoneList = zones.items ?? [];
  const dockList = [...(docks.items ?? [])].sort((a, b) =>
    a.number.localeCompare(b.number, 'ru', { numeric: true }),
  );
  const zoneName = (id: string | null) => zoneList.find((z) => z.id === id)?.name ?? 'без зоны';
  const groups = new Map<string, DockView[]>();
  for (const d of dockList) {
    const key = d.zoneId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }

  return (
    <>
      <Section
        title="Зоны"
        description="Здания, двор, парковки. Зона нужна, чтобы направлять посетителей и группировать доки; можно добавить позже."
      >
        {zoneList.length === 0 ? (
          <Empty
            title="Зон пока нет"
            hint="Добавьте зоны, если на объекте несколько зданий или участков. Иначе шаг можно пропустить."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Название</TH>
                <TH>Вид</TH>
                <TH>Доков</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {zoneList.map((z) => (
                <TR key={z.id}>
                  <TD className="font-medium">{z.name}</TD>
                  <TD>{ZONE_KIND_LABEL[z.kind]}</TD>
                  <TD>{groups.get(z.id)?.length ?? 0}</TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить зону: ${z.name}`}
                        onClick={() => setEditingZone(z)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="zones"
                        id={z.id}
                        name={`зона «${z.name}»`}
                        title="Удалить зону?"
                      />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <div className="mt-4 border-t pt-4">
          <ZoneCreateForm siteId={siteId} />
        </div>
      </Section>

      <Section
        title="Доки"
        description={`Сейчас на объекте доков: ${dockList.length}. Добавьте номера диапазоном — например, «1–72».`}
      >
        <DocksBatch siteId={siteId} zones={zoneList} />
        {dockList.length > 0 ? (
          <div className="mt-6 space-y-4">
            {[...groups.entries()].map(([zoneKey, list]) => (
              <div key={zoneKey}>
                <p className="mb-1.5 text-sm font-medium">
                  {zoneName(zoneKey || null)} <Badge tone="neutral">{list.length}</Badge>
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {list.map((d) => (
                    <li key={d.id}>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Док ${d.number}`}
                        onClick={() => setEditingDock(d)}
                      >
                        {d.number}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Нажмите на номер, чтобы изменить док или удалить его.
            </p>
          </div>
        ) : null}
      </Section>

      <Dialog open={editingZone !== null} onOpenChange={(o) => !o && setEditingZone(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Зона «{editingZone?.name}»</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editingZone ? (
            <ZoneEditForm zone={editingZone} onDone={() => setEditingZone(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={editingDock !== null} onOpenChange={(o) => !o && setEditingDock(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Док {editingDock?.number}</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editingDock ? (
            <>
              <DockEditForm
                dock={editingDock}
                zones={zoneList}
                onDone={() => setEditingDock(null)}
              />
              <div className="flex justify-end border-t pt-3">
                <DeleteAction
                  collection="docks"
                  id={editingDock.id}
                  name={`док ${editingDock.number}`}
                  title="Удалить док?"
                />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
