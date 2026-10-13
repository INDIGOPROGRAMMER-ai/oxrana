import { ParkingAssignmentCreateSchema, ParkingAssignmentPatchSchema } from '@oxrana/contracts';
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
  FormDateInput,
  formatLocalDate,
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
  useLinkComponent,
  useToast,
} from '@oxrana/ui';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  type ParkingAreaView,
  type ParkingAssignmentView,
  useMutate,
  useParkingAreas,
  useParkingAssignments,
  useTrackContracts,
} from '../../lib/data';
import { DeleteAction, Empty, LoadError, RequireSite } from '../common';
import { assertValid, siteToday, useTenantClauses } from './tenant-rule-helpers';

interface Values {
  parkingAreaId: string;
  spaces: string;
  validFrom: string;
  validTo: string;
  basisClauseId: string;
}

function toBody(v: Values): Record<string, unknown> {
  return {
    parkingAreaId: v.parkingAreaId,
    spaces: v.spaces.trim() === '' ? undefined : Number(v.spaces),
    validFrom: v.validFrom,
    validTo: v.validTo === '' ? null : v.validTo,
    basisClauseId: v.basisClauseId === '' ? null : v.basisClauseId,
  };
}

function Fields({
  f,
  areas,
  today,
  lockArea,
  clauses,
  track,
}: {
  f: FormController<Values>;
  areas: readonly ParkingAreaView[];
  today: string;
  lockArea: boolean;
  clauses: ReturnType<typeof useTenantClauses>;
  track: boolean;
}) {
  const { register, control, watch } = f.form;
  const area = areas.find((a) => a.id === watch('parkingAreaId'));
  return (
    <>
      <Field
        label="Парковочный участок"
        required
        error={f.fieldError('parkingAreaId')}
        hint={
          area?.spaces != null
            ? `На участке всего мест: ${area.spaces}.`
            : area
              ? 'Число мест на участке не указано — ограничение не проверяется.'
              : undefined
        }
      >
        <Select {...register('parkingAreaId')} disabled={lockArea}>
          <option value="">— выберите —</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.spaces != null ? ` (${a.spaces} мест)` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Сколько мест" required error={f.fieldError('spaces')}>
        <Input type="number" min={1} step={1} {...register('spaces')} className="w-32" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="С даты" required error={f.fieldError('validFrom')}>
          <FormDateInput control={control} name="validFrom" todayIso={today} />
        </Field>
        <Field
          label="По дату"
          hint="Последний день включительно. Пусто — бессрочно."
          error={f.fieldError('validTo')}
        >
          <FormDateInput control={control} name="validTo" todayIso={today} />
          {watch('validTo') === '' ? (
            <p className="text-xs text-muted-foreground">бессрочно</p>
          ) : null}
        </Field>
      </div>
      {track ? (
        <Field label="Основание (необязательно)" error={f.fieldError('basisClauseId')}>
          <Select {...register('basisClauseId')} disabled={clauses.options.length === 0}>
            <option value="">
              {clauses.options.length === 0 ? '— не нужно —' : '— без основания —'}
            </option>
            {clauses.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </>
  );
}

function Create({
  tenantId,
  areas,
  today,
  clauses,
  track,
  onDone,
}: {
  tenantId: string;
  areas: readonly ParkingAreaView[];
  today: string;
  clauses: ReturnType<typeof useTenantClauses>;
  track: boolean;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<Values>({
    schema: ParkingAssignmentCreateSchema,
    initial: { parkingAreaId: '', spaces: '', validFrom: today, validTo: '', basisClauseId: '' },
    toBody: toBody as (v: Values) => unknown,
    onCreate: async (body) => {
      await mutate(`/tenants/${tenantId}/parking-assignments`, 'POST', body);
      toast('Места закреплены');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Закрепить места">
      <Fields f={f} areas={areas} today={today} lockArea={false} clauses={clauses} track={track} />
    </EditForm>
  );
}

function Edit({
  assignment,
  areas,
  today,
  clauses,
  track,
  onDone,
}: {
  assignment: ParkingAssignmentView;
  areas: readonly ParkingAreaView[];
  today: string;
  clauses: ReturnType<typeof useTenantClauses>;
  track: boolean;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<Values>({
    values: {
      parkingAreaId: assignment.parkingAreaId,
      spaces: String(assignment.spaces),
      validFrom: assignment.validFrom,
      validTo: assignment.validTo ?? '',
      basisClauseId: assignment.basisClauseId ?? '',
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.spaces !== undefined) body.spaces = Number(patch.spaces);
      if (patch.validFrom !== undefined) body.validFrom = patch.validFrom;
      if (patch.validTo !== undefined) body.validTo = patch.validTo || null;
      if (patch.basisClauseId !== undefined) body.basisClauseId = patch.basisClauseId || null;
      assertValid(ParkingAssignmentPatchSchema, body);
      await mutate(`/parking-assignments/${assignment.id}`, 'PATCH', body);
      toast('Закрепление сохранено');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <Fields f={f} areas={areas} today={today} lockArea clauses={clauses} track={track} />
    </EditForm>
  );
}

/**
 * Места на парковке (этап 6b): сколько мест на каких участках закреплено за арендатором и на
 * какой срок. Участки и число мест задаются в «Цели визита и парковки»; мест закрепляется не больше,
 * чем есть на участке.
 */
export function TenantParkingCard({ tenantId }: { tenantId: string }) {
  return (
    <RequireSite>
      {(site) => <Body siteId={site.id} tenantId={tenantId} timezone={site.timezone} />}
    </RequireSite>
  );
}

function Body({
  siteId,
  tenantId,
  timezone,
}: {
  siteId: string;
  tenantId: string;
  timezone: string;
}) {
  const Link = useLinkComponent();
  const areas = useParkingAreas(siteId);
  const assignments = useParkingAssignments(tenantId);
  const track = useTrackContracts();
  const clauses = useTenantClauses(track ? tenantId : null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ParkingAssignmentView | null>(null);
  const today = siteToday(timezone);
  const failed = areas.error ?? assignments.error;
  if (failed) {
    return (
      <LoadError
        error={failed}
        retry={() => {
          void areas.refetch();
          void assignments.refetch();
        }}
      />
    );
  }
  const areaList = areas.items ?? [];
  const items = assignments.items ?? [];
  const areaName = (id: string) => areaList.find((a) => a.id === id)?.name ?? '?';
  const noAreas = !areas.isLoading && areaList.length === 0;
  return (
    <>
      <Section
        title="Места на парковке"
        description="Какие места на парковочных участках закреплены за арендатором и на какой срок."
        actions={
          <Button size="sm" disabled={noAreas || areas.isLoading} onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Закрепить места
          </Button>
        }
      >
        {noAreas ? (
          <Alert tone="warning">
            Парковочных участков на объекте нет. Сначала создайте участок и укажите число мест —{' '}
            <Link href="/admin/catalogs" className="font-medium underline">
              «Цели визита и парковки»
            </Link>
            .
          </Alert>
        ) : assignments.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Мест не закреплено"
            hint="Нажмите «Закрепить места», чтобы выделить арендатору места на участке."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Участок</TH>
                <TH>Мест</TH>
                <TH>С даты</TH>
                <TH>По дату</TH>
                <TH>Сейчас</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((a) => (
                <TR key={a.id}>
                  <TD className="font-medium">{areaName(a.parkingAreaId)}</TD>
                  <TD>{a.spaces}</TD>
                  <TD>{formatLocalDate(a.validFrom)}</TD>
                  <TD>
                    {a.validTo ? (
                      formatLocalDate(a.validTo)
                    ) : (
                      <span className="text-muted-foreground">бессрочно</span>
                    )}
                  </TD>
                  <TD>
                    {a.validFrom > today ? (
                      <Badge tone="info">ещё не началось</Badge>
                    ) : a.validTo !== null && a.validTo < today ? (
                      <Badge tone="neutral">завершено</Badge>
                    ) : (
                      <Badge tone="success">действует</Badge>
                    )}
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить закрепление: ${areaName(a.parkingAreaId)}`}
                        onClick={() => setEditing(a)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="parking-assignments"
                        id={a.id}
                        name={`закрепление мест на «${areaName(a.parkingAreaId)}»`}
                        title="Удалить закрепление мест?"
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Закрепить места</DialogTitle>
            <DialogDescription>Мест закрепляется не больше, чем есть на участке.</DialogDescription>
          </DialogHeader>
          <Create
            tenantId={tenantId}
            areas={areaList}
            today={today}
            clauses={clauses}
            track={track}
            onDone={() => setCreating(false)}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? areaName(editing.parkingAreaId) : 'Закрепление'}</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <Edit
              assignment={editing}
              areas={areaList}
              today={today}
              clauses={clauses}
              track={track}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
