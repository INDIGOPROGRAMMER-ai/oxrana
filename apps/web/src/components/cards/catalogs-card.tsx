import {
  ParkingAreaCreateSchema,
  ParkingAreaPatchSchema,
  VisitPurposeCreateSchema,
  VisitPurposePatchSchema,
} from '@oxrana/contracts';
import {
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
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  type ParkingAreaView,
  type SiteView,
  useMutate,
  useParkingAreas,
  useVisitPurposes,
  useZones,
  type VisitPurposeView,
} from '../../lib/data';
import { DeleteAction, Empty, LoadError, RequireSite } from '../common';
import { assertValid } from './tenant-rule-helpers';

const numOrNull = (text: string): number | null => (text.trim() === '' ? null : Number(text));

// ——— цели визита ———

interface PurposeValues {
  name: string;
  maxStayMinutes: string;
}

function PurposeFields({ f }: { f: FormController<PurposeValues> }) {
  const { register } = f.form;
  return (
    <>
      <Field label="Название цели" required error={f.fieldError('name')}>
        <Input {...register('name')} maxLength={100} placeholder="Например, «Разгрузка»" />
      </Field>
      <Field
        label="Норматив времени на территории, минут"
        hint="Необязательно. Сколько машине разрешено быть на территории с этой целью; превышение попадёт в отчёты."
        error={f.fieldError('maxStayMinutes')}
      >
        <Input type="number" min={1} step={1} className="w-40" {...register('maxStayMinutes')} />
      </Field>
    </>
  );
}

function PurposeCreate({ siteId, onDone }: { siteId: string; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<PurposeValues>({
    schema: VisitPurposeCreateSchema,
    initial: { name: '', maxStayMinutes: '' },
    toBody: (v) => ({ name: v.name, maxStayMinutes: numOrNull(v.maxStayMinutes) }),
    onCreate: async (body) => {
      await mutate(`/sites/${siteId}/visit-purposes`, 'POST', body);
      toast('Цель добавлена');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить цель">
      <PurposeFields f={f} />
    </EditForm>
  );
}

function PurposeEdit({ purpose, onDone }: { purpose: VisitPurposeView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<PurposeValues>({
    values: {
      name: purpose.name,
      maxStayMinutes: purpose.maxStayMinutes === null ? '' : String(purpose.maxStayMinutes),
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.maxStayMinutes !== undefined) body.maxStayMinutes = numOrNull(patch.maxStayMinutes);
      assertValid(VisitPurposePatchSchema, body);
      await mutate(`/visit-purposes/${purpose.id}`, 'PATCH', body);
      toast('Цель сохранена');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <PurposeFields f={f} />
    </EditForm>
  );
}

export function VisitPurposesSection({ siteId }: { siteId: string }) {
  const list = useVisitPurposes(siteId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<VisitPurposeView | null>(null);
  if (list.error) return <LoadError error={list.error} retry={() => void list.refetch()} />;
  const items = list.items ?? [];
  return (
    <>
      <Section
        title="Цели визита"
        description="Зачем машина или человек приезжают: разгрузка, погрузка, совещание. У цели может быть норматив времени на территории."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Добавить цель
          </Button>
        }
      >
        {list.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Целей визита нет"
            hint="Цели нужны, если вы хотите контролировать время на территории. Иначе можно не заполнять."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Цель</TH>
                <TH>Норматив</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((p) => (
                <TR key={p.id}>
                  <TD className="font-medium">{p.name}</TD>
                  <TD>
                    {p.maxStayMinutes === null ? (
                      <span className="text-muted-foreground">не задан</span>
                    ) : (
                      `${p.maxStayMinutes} мин`
                    )}
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить цель: ${p.name}`}
                        onClick={() => setEditing(p)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="visit-purposes"
                        id={p.id}
                        name={`цель «${p.name}»`}
                        title="Удалить цель визита?"
                      />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новая цель визита</DialogTitle>
            <DialogDescription>Название и, по желанию, норматив времени.</DialogDescription>
          </DialogHeader>
          <PurposeCreate siteId={siteId} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Цель «{editing?.name}»</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? <PurposeEdit purpose={editing} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ——— парковочные участки ———

interface AreaValues {
  name: string;
  zoneId: string;
  spaces: string;
}

function AreaFields({ f, site }: { f: FormController<AreaValues>; site: SiteView }) {
  const { register } = f.form;
  const zones = useZones(site.id);
  return (
    <>
      <Field label="Название участка" required error={f.fieldError('name')}>
        <Input {...register('name')} maxLength={100} placeholder="Например, «Стоянка у въезда»" />
      </Field>
      <Field
        label="Число мест"
        hint="Необязательно, но без него нельзя проверить, что закреплено не больше, чем есть."
        error={f.fieldError('spaces')}
      >
        <Input type="number" min={0} step={1} className="w-40" {...register('spaces')} />
      </Field>
      <Field
        label="Зона"
        hint="Необязательно."
        error={f.fieldError('zoneId')}
        {...((zones.items ?? []).length === 0
          ? { disabledReason: 'Зон на объекте пока нет — создайте их в «Доки и зоны».' }
          : {})}
      >
        <Select {...register('zoneId')}>
          <option value="">— не указана —</option>
          {(zones.items ?? []).map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

function AreaCreate({ site, onDone }: { site: SiteView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<AreaValues>({
    schema: ParkingAreaCreateSchema,
    initial: { name: '', zoneId: '', spaces: '' },
    toBody: (v) => ({
      name: v.name,
      zoneId: v.zoneId || null,
      spaces: numOrNull(v.spaces),
    }),
    onCreate: async (body) => {
      await mutate(`/sites/${site.id}/parking-areas`, 'POST', body);
      toast('Участок добавлен');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить участок">
      <AreaFields f={f} site={site} />
    </EditForm>
  );
}

function AreaEdit({
  area,
  site,
  onDone,
}: {
  area: ParkingAreaView;
  site: SiteView;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<AreaValues>({
    values: {
      name: area.name,
      zoneId: area.zoneId ?? '',
      spaces: area.spaces === null ? '' : String(area.spaces),
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.zoneId !== undefined) body.zoneId = patch.zoneId || null;
      if (patch.spaces !== undefined) body.spaces = numOrNull(patch.spaces);
      assertValid(ParkingAreaPatchSchema, body);
      await mutate(`/parking-areas/${area.id}`, 'PATCH', body);
      toast('Участок сохранён');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <AreaFields f={f} site={site} />
    </EditForm>
  );
}

export function ParkingAreasSection({ site }: { site: SiteView }) {
  const list = useParkingAreas(site.id);
  const zones = useZones(site.id);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ParkingAreaView | null>(null);
  if (list.error) return <LoadError error={list.error} retry={() => void list.refetch()} />;
  const items = list.items ?? [];
  const zoneName = (id: string | null) =>
    id === null ? '—' : ((zones.items ?? []).find((z) => z.id === id)?.name ?? '—');
  return (
    <>
      <Section
        title="Парковочные участки"
        description="Участки с числом мест. Места закрепляются за арендатором в его карточке, вкладка «Парковка»."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Добавить участок
          </Button>
        }
      >
        {list.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Участков нет"
            hint="Добавьте участок и число мест — потом можно закрепить места за арендаторами."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Участок</TH>
                <TH>Мест</TH>
                <TH>Зона</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((a) => (
                <TR key={a.id}>
                  <TD className="font-medium">{a.name}</TD>
                  <TD>
                    {a.spaces === null ? (
                      <span className="text-muted-foreground">не указано</span>
                    ) : (
                      a.spaces
                    )}
                  </TD>
                  <TD>{zoneName(a.zoneId)}</TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить участок: ${a.name}`}
                        onClick={() => setEditing(a)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="parking-areas"
                        id={a.id}
                        name={`участок «${a.name}»`}
                        title="Удалить парковочный участок?"
                      />
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новый участок</DialogTitle>
            <DialogDescription>Название и число мест.</DialogDescription>
          </DialogHeader>
          <AreaCreate site={site} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Участок «{editing?.name}»</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? <AreaEdit area={editing} site={site} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Страница «Цели визита и парковки». */
export function CatalogsCard() {
  return (
    <RequireSite>
      {(site) => (
        <>
          <VisitPurposesSection siteId={site.id} />
          <ParkingAreasSection site={site} />
        </>
      )}
    </RequireSite>
  );
}
