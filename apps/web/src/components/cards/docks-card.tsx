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
  Alert,
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
import { Loader2, Pencil } from 'lucide-react';
import { type SelectHTMLAttributes, useCallback, useMemo, useState } from 'react';
import { z } from 'zod';
import { api } from '../../lib/api';
import { type DockView, useDocks, useMutate, useZones, type ZoneView } from '../../lib/data';
import { DOCK_KIND_LABEL, ZONE_KIND_LABEL } from '../../lib/labels';
import { useAutoPreview } from '../../lib/use-auto-preview';
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

/**
 * Выбор зоны для дока. Зон нет — список неактивен, а рядом ясно сказано, что делать: сначала
 * создать зону в блоке «Зоны» (ссылка на него). Зона дока необязательна.
 */
function ZoneSelect({
  zones,
  value,
  onChange,
  emptyLabel = '— не указана —',
  clearLabel,
  ...rest
}: {
  zones: readonly ZoneView[];
  value?: string;
  onChange?: (value: string) => void;
  emptyLabel?: string;
  /** Пункт «убрать зону» (значение `__none`) — для массовой правки. */
  clearLabel?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const none = zones.length === 0;
  return (
    <>
      <Select
        {...rest}
        {...(onChange ? { value: value ?? '', onChange: (e) => onChange(e.target.value) } : {})}
        disabled={none || rest.disabled}
      >
        <option value="">{none ? '— зон пока нет —' : emptyLabel}</option>
        {clearLabel && !none ? <option value="__none">{clearLabel}</option> : null}
        {zones.map((z) => (
          <option key={z.id} value={z.id}>
            {z.name}
          </option>
        ))}
      </Select>
      {none ? (
        <p className="text-xs text-warning">
          Сначала создайте зону —{' '}
          <a href="#zones" className="font-medium underline">
            блок «Зоны» выше
          </a>
          . Зона дока необязательна: без неё док просто не привязан к зданию.
        </p>
      ) : null}
    </>
  );
}

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
        <ZoneSelect
          zones={zones}
          value={f.form.watch('zoneId')}
          onChange={(v) => f.form.setValue('zoneId', v, { shouldDirty: true })}
        />
      </Field>
      <Field label="Размер" hint="Необязательно, например «40 футов»." error={f.fieldError('size')}>
        <Input {...f.form.register('size')} />
      </Field>
      <Checkbox
        label="Считается в лимите грузовых"
        hint="Док входит в число доков арендатора, по которому можно считать лимит."
        {...f.form.register('countsInQuota')}
      />
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Дополнительно</summary>
        <div className="mt-3">
          <Field
            label="Вид дока"
            hint="Обычно менять не нужно: по умолчанию «с уравнивающей платформой»."
            error={f.fieldError('kind')}
          >
            <Select {...f.form.register('kind')}>
              {DOCK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DOCK_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </details>
    </EditForm>
  );
}

function DocksBatch({ siteId, zones }: { siteId: string; zones: ZoneView[] }) {
  const mutate = useMutate();
  const [zoneId, setZoneId] = useState('');
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
    countsInQuota,
  });
  const check = (numbers: string[]) =>
    api<BatchResult>(`/sites/${siteId}/docks/batch`, { method: 'POST', body: body(numbers, true) });
  const commit = (numbers: string[]) =>
    mutate<BatchResult>(`/sites/${siteId}/docks/batch`, 'POST', body(numbers, false));
  const columns = useMemo(() => [{ header: 'Док', render: (v: string) => v }], []);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Зона" hint="Для всех добавляемых доков. Необязательно.">
          <ZoneSelect zones={zones} value={zoneId} onChange={setZoneId} />
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
        checkKey={`${zoneId}|${countsInQuota}`}
        commit={commit}
        commitLabel={(n) => `Добавить доков: ${n}`}
      />
    </div>
  );
}

type Tri = '' | 'yes' | 'no';

/**
 * Массовая правка: выбранным докам разом задать зону и «считаются в лимите». «Не менять» —
 * поле не отправляется. Проверка идёт сама (сервер знает, какие доки нельзя изменить); одна кнопка.
 */
function DocksBulkEdit({
  siteId,
  zones,
  ids,
  onDone,
}: {
  siteId: string;
  zones: readonly ZoneView[];
  ids: readonly string[];
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const [zoneId, setZoneId] = useState('');
  const [counts, setCounts] = useState<Tri>('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const changes = {
    ...(zoneId === '__none' ? { zoneId: null } : zoneId ? { zoneId } : {}),
    ...(counts ? { countsInQuota: counts === 'yes' } : {}),
  };
  const nothing = Object.keys(changes).length === 0;
  const preview = useAutoPreview({
    path: `/sites/${siteId}/docks/batch`,
    method: 'PATCH',
    body: nothing ? null : { ids, changes },
  });
  const checked = preview.status === 'ready' ? preview.result : null;

  async function apply() {
    setBusy(true);
    setFailure(null);
    try {
      const done = await mutate<BatchResult>(`/sites/${siteId}/docks/batch`, 'PATCH', {
        ids,
        changes,
      });
      toast(done.summary);
      if (done.errors.length === 0) onDone();
      else setFailure(`${done.summary}. ${done.errors[0]?.message ?? ''}`);
    } catch (raw) {
      setFailure(raw instanceof Error ? raw.message : 'Не удалось изменить доки.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <p className="text-sm font-medium">Выбрано доков: {ids.length}. Что им задать?</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Зона">
          <ZoneSelect
            zones={zones}
            value={zoneId}
            onChange={setZoneId}
            emptyLabel="— не менять —"
            clearLabel="— убрать зону —"
          />
        </Field>
        <Field label="Считаются в лимите грузовых">
          <Select value={counts} onChange={(e) => setCounts(e.target.value as Tri)}>
            <option value="">— не менять —</option>
            <option value="yes">да</option>
            <option value="no">нет</option>
          </Select>
        </Field>
      </div>
      {zones.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Чтобы убрать зону у выбранных доков, выберите «— убрать зону —» в списке выше.
        </p>
      ) : null}
      {checked && checked.errors.length > 0 ? (
        <Alert tone="warning">
          {checked.summary}. {checked.errors[0]?.message}
        </Alert>
      ) : null}
      {failure ? <Alert tone="danger">{failure}</Alert> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || nothing || !checked || checked.created === 0}
          onClick={() => void apply()}
        >
          {busy || preview.status === 'checking' ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : null}
          {checked && checked.created > 0
            ? `Изменить доков: ${checked.created}`
            : 'Изменить выбранные'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {nothing
            ? 'Выберите, что изменить.'
            : preview.status === 'checking'
              ? 'Проверяем…'
              : null}
        </span>
      </div>
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
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
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
        id="zones"
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {selecting
                  ? 'Отметьте доки, которым нужно разом задать зону, вид или «считаются в лимите».'
                  : 'Нажмите на номер, чтобы изменить док или удалить его.'}
              </p>
              <Button
                variant={selecting ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={selecting}
                onClick={() => {
                  setSelecting(!selecting);
                  setSelected(new Set());
                }}
              >
                {selecting ? 'Закончить выбор' : 'Выбрать несколько'}
              </Button>
            </div>
            {[...groups.entries()].map(([zoneKey, list]) => (
              <div key={zoneKey}>
                <p className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                  {zoneName(zoneKey || null)} <Badge tone="neutral">{list.length}</Badge>
                  {selecting ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const next = new Set(selected);
                        const all = list.every((d) => next.has(d.id));
                        for (const d of list) {
                          if (all) next.delete(d.id);
                          else next.add(d.id);
                        }
                        setSelected(next);
                      }}
                    >
                      {list.every((d) => selected.has(d.id)) ? 'Снять все' : 'Выбрать все'}
                    </Button>
                  ) : null}
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {list.map((d) => (
                    <li key={d.id}>
                      {selecting ? (
                        <Button
                          variant={selected.has(d.id) ? 'default' : 'outline'}
                          size="sm"
                          role="checkbox"
                          aria-checked={selected.has(d.id)}
                          aria-label={`Выбрать док ${d.number}`}
                          onClick={() => {
                            const next = new Set(selected);
                            if (next.has(d.id)) next.delete(d.id);
                            else next.add(d.id);
                            setSelected(next);
                          }}
                        >
                          {d.number}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Док ${d.number}`}
                          onClick={() => setEditingDock(d)}
                        >
                          {d.number}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {selecting && selected.size > 0 ? (
              <DocksBulkEdit
                siteId={siteId}
                zones={zoneList}
                ids={[...selected]}
                onDone={() => {
                  setSelected(new Set());
                  setSelecting(false);
                }}
              />
            ) : null}
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
