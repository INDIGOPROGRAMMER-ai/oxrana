import {
  type GateAdmits,
  GateCreateSchema,
  type GateKind,
  GatePatchSchema,
  type WorkingHours,
} from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  Field,
  type FormController,
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
import { DoorOpen, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { type GateView, useGates, useMutate, useZones } from '../../lib/data';
import { ADMITS_LABEL, GATE_KIND_LABEL } from '../../lib/labels';
import { DeleteAction, Empty, GuardPreview, LoadError, RequireSite } from '../common';
import { describeHours, WorkingHoursInput } from '../working-hours';

interface GateValues {
  name: string;
  kind: GateKind;
  admits: GateAdmits;
  zoneId: string;
  workingHours: WorkingHours | null;
}

function GateFields({
  f,
  zones,
  tzLabel,
}: {
  f: FormController<GateValues>;
  zones: { id: string; name: string }[];
  tzLabel: string;
}) {
  const { register, watch, setValue } = f.form;
  const kind = watch('kind');
  const admits = watch('admits');
  return (
    <>
      <Field label="Название КПП" required error={f.fieldError('name')}>
        <Input {...register('name')} placeholder="Например, «Въезд 1»" />
      </Field>
      <fieldset className="space-y-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Кого пропускает</legend>
        {(Object.keys(ADMITS_LABEL) as GateAdmits[]).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input type="radio" value={value} {...register('admits')} />
            {ADMITS_LABEL[value]}
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Вид КПП</legend>
        {(Object.keys(GATE_KIND_LABEL) as GateKind[]).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input type="radio" value={value} {...register('kind')} />
            {GATE_KIND_LABEL[value]}
          </label>
        ))}
      </fieldset>
      {kind === 'internal' && admits !== 'pedestrians' ? (
        <Alert tone="warning">
          Пост внутри здания обычно пропускает только пешеходов: отметка на нём не открывает и не
          закрывает визит на территорию.
        </Alert>
      ) : null}
      <Field
        label="Здание или зона КПП"
        hint="Для поста внутри здания — какое это здание. Не обязательно."
        error={f.fieldError('zoneId')}
      >
        <Select {...register('zoneId')}>
          <option value="">— не указана —</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Часы работы КПП</p>
        <WorkingHoursInput
          value={watch('workingHours')}
          onChange={(v) => setValue('workingHours', v, { shouldDirty: true })}
          tzLabel={tzLabel}
        />
      </div>
    </>
  );
}

const toBody = (v: GateValues) => ({
  name: v.name,
  kind: v.kind,
  admits: v.admits,
  zoneId: v.zoneId || null,
  workingHours: v.workingHours,
});

function CreateGateForm({
  siteId,
  tzLabel,
  nextSort,
  onDone,
}: {
  siteId: string;
  tzLabel: string;
  nextSort: number;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const zones = useZones(siteId);
  const f = useCreateForm<GateValues>({
    schema: GateCreateSchema,
    initial: {
      name: '',
      kind: 'perimeter',
      admits: 'vehicles_and_pedestrians',
      zoneId: '',
      workingHours: null,
    },
    toBody: (v) => ({ ...toBody(v), sort: nextSort }),
    onCreate: async (body) => {
      await mutate(`/sites/${siteId}/gates`, 'POST', body);
      toast('КПП добавлен');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить КПП">
      <GateFields f={f} zones={zones.items ?? []} tzLabel={tzLabel} />
    </EditForm>
  );
}

function EditGateForm({
  gate,
  tzLabel,
  onDone,
}: {
  gate: GateView;
  tzLabel: string;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const zones = useZones(gate.siteId);
  const f = useEditForm<GateValues>({
    values: {
      name: gate.name,
      kind: gate.kind,
      admits: gate.admits,
      zoneId: gate.zoneId ?? '',
      workingHours: gate.workingHours,
    },
    schema: GatePatchSchema,
    onPatch: async (patch) => {
      const body: Record<string, unknown> = { ...patch };
      if (patch.zoneId !== undefined) body.zoneId = patch.zoneId || null;
      await mutate(`/gates/${gate.id}`, 'PATCH', body);
      toast('КПП сохранён');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <GateFields f={f} zones={zones.items ?? []} tzLabel={tzLabel} />
    </EditForm>
  );
}

/**
 * Карточка «КПП» (шаг 2): список, «кого пропускает», вид, часы. Добавление и правка — в окне;
 * правка отправляет только изменённые поля.
 */
export function GatesCard() {
  return (
    <RequireSite>
      {(site) => <GatesBody siteId={site.id} tzLabel={site.timezoneLabel} />}
    </RequireSite>
  );
}

function GatesBody({ siteId, tzLabel }: { siteId: string; tzLabel: string }) {
  const gates = useGates(siteId);
  const [editing, setEditing] = useState<GateView | null>(null);
  const [creating, setCreating] = useState(false);
  if (gates.error) return <LoadError error={gates.error} retry={() => void gates.refetch()} />;
  const items = gates.items ?? [];
  return (
    <>
      <Section
        title="КПП объекта"
        description="Сколько угодно постов. У каждого — кого пропускает и вид: на периметре (открывает и закрывает визит) или внутри здания (только отметка прохода). У каждого КПП сразу появляется учётка поста — устройства привязываются в шаге «Устройства КПП»."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Добавить КПП
          </Button>
        }
      >
        {gates.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="КПП ещё нет"
            hint="Добавьте первый КПП: например, въезд для машин и пешеходов. Остальные можно добавить позже."
            action={
              <Button onClick={() => setCreating(true)}>
                <DoorOpen aria-hidden /> Добавить КПП
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Название</TH>
                <TH>Кого пропускает</TH>
                <TH>Вид</TH>
                <TH>Часы работы</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((g) => (
                <TR key={g.id}>
                  <TD className="font-medium">{g.name}</TD>
                  <TD>{ADMITS_LABEL[g.admits]}</TD>
                  <TD>
                    <Badge tone={g.kind === 'perimeter' ? 'info' : 'neutral'}>
                      {g.kind === 'perimeter' ? 'периметр' : 'в здании'}
                    </Badge>
                  </TD>
                  <TD className="text-muted-foreground">{describeHours(g.workingHours)}</TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить: ${g.name}`}
                        onClick={() => setEditing(g)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="gates"
                        id={g.id}
                        name={`КПП «${g.name}»`}
                        title="Удалить КПП?"
                      />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      {items.length > 0 ? (
        <GuardPreview>
          <ul className="list-disc space-y-0.5 pl-5">
            {items.map((g) => (
              <li key={g.id}>
                «{g.name}» — {ADMITS_LABEL[g.admits]}; {describeHours(g.workingHours)}.
                {g.admits === 'vehicles' ? ' Пешеходу здесь будет «не тот КПП».' : ''}
                {g.admits === 'pedestrians' ? ' Машине здесь будет «не тот КПП».' : ''}
              </li>
            ))}
          </ul>
        </GuardPreview>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Новый КПП</DialogTitle>
            <DialogDescription>Название, кого пропускает, вид и часы работы.</DialogDescription>
          </DialogHeader>
          <CreateGateForm
            siteId={siteId}
            tzLabel={tzLabel}
            nextSort={items.reduce((m, g) => Math.max(m, g.sort), 0) + 1}
            onDone={() => setCreating(false)}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>КПП «{editing?.name}»</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditGateForm gate={editing} tzLabel={tzLabel} onDone={() => setEditing(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
