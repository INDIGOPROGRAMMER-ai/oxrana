import {
  type BatchResult,
  BlacklistCreateSchema,
  type BlacklistLevel,
  BlacklistPatchSchema,
  type ParsedRow,
} from '@oxrana/contracts';
import { normalizePlate } from '@oxrana/plates';
import {
  Alert,
  Badge,
  BatchInput,
  Button,
  Checkbox,
  DateInput,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EditForm,
  Field,
  type FormController,
  formatInZone,
  Input,
  localToInstant,
  Section,
  Select,
  SiteTime,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { type BlacklistView, type SiteView, useBlacklist, useMe, useMutate } from '../../lib/data';
import { Empty, LoadError, RequireSite } from '../common';
import { assertValid, fieldProblem, siteToday } from './tenant-rule-helpers';

const LEVEL_LABEL: Record<BlacklistLevel, string> = {
  site: 'этот объект',
  organization: 'вся организация (все объекты)',
};

/** Конец выбранного дня по времени объекта: срок «до даты включительно» = начало следующих суток. */
function endOfDay(date: string, timezone: string): string {
  const next = new Date(Date.UTC(...(date.split('-').map(Number) as [number, number, number])));
  next.setUTCMonth(next.getUTCMonth() - 1);
  next.setUTCDate(next.getUTCDate() + 1);
  const iso = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  return localToInstant(iso, '00:00', timezone);
}

/** Последний день срока (включительно) по времени объекта — для поля «до даты». */
function lastDay(validTo: string, timezone: string): string {
  const [d = '', m = '', y = ''] = formatInZone(
    new Date(Date.parse(validTo) - 60_000).toISOString(),
    timezone,
  )
    .slice(0, 10)
    .split('.');
  return `${y}-${m}-${d}`;
}

/** Организация целиком: роль без области объекта и арендатора. */
function useWholeOrganization(): boolean {
  const { me } = useMe();
  return (me?.user?.assignments ?? []).some((a) => a.siteName === null && a.tenantName === null);
}

interface Values {
  plate: string;
  personName: string;
  reason: string;
  level: BlacklistLevel;
  indefinite: boolean;
  until: string;
}

const EMPTY: Values = {
  plate: '',
  personName: '',
  reason: '',
  level: 'site',
  indefinite: true,
  until: '',
};

function PlatePreview({ text }: { text: string }) {
  const plate = text.trim() === '' ? null : normalizePlate(text);
  if (!plate?.norm) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Запишется как <span className="font-mono font-medium text-foreground">{plate.norm}</span>
      {plate.recognized ? '' : ' (формат не распознан — номер сохранится как есть)'}
    </p>
  );
}

function Fields({
  f,
  site,
  mode,
}: {
  f: FormController<Values>;
  site: SiteView;
  mode: 'create' | 'edit';
}) {
  const { register, watch, setValue } = f.form;
  const whole = useWholeOrganization();
  const indefinite = watch('indefinite');
  const today = siteToday(site.timezone);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Номер машины"
          hint="Любая раскладка: «в 777 ор 174» запишется заглавными латинскими без пробелов."
          error={f.fieldError('plate')}
        >
          <Input {...register('plate')} className="font-mono" autoComplete="off" maxLength={30} />
          <PlatePreview text={watch('plate')} />
        </Field>
        <Field
          label="Человек"
          hint="Фамилия и имя. Нужен номер, человек или оба."
          error={f.fieldError('personName')}
        >
          <Input {...register('personName')} autoComplete="off" maxLength={200} />
        </Field>
      </div>
      <Field
        label="Причина"
        required
        hint="Обязательна: попадёт в журнал и на пост (охрана увидит, за что). Арендаторы причину не видят."
        error={f.fieldError('reason')}
      >
        <Textarea {...register('reason')} rows={2} maxLength={500} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Срок" error={f.fieldError('until')}>
          <Checkbox
            label="Бессрочно"
            checked={indefinite}
            onChange={(e) => setValue('indefinite', e.target.checked, { shouldDirty: true })}
          />
          {indefinite ? null : (
            <>
              <DateInput
                value={watch('until')}
                todayIso={today}
                onChange={(v) => setValue('until', v, { shouldDirty: true })}
                aria-label="Действует до даты"
              />
              <p className="text-xs text-muted-foreground">
                Последний день включительно, по времени объекта ({site.timezoneLabel}).
              </p>
            </>
          )}
        </Field>
        {mode === 'create' ? (
          <Field
            label="Уровень"
            hint="«Вся организация» действует на всех объектах."
            disabledReason={
              whole
                ? undefined
                : 'Запись для всей организации добавляет только роль на всю организацию.'
            }
            error={f.fieldError('level')}
          >
            <Select {...register('level')}>
              <option value="site">{LEVEL_LABEL.site}</option>
              <option value="organization" disabled={!whole}>
                {LEVEL_LABEL.organization}
              </option>
            </Select>
          </Field>
        ) : null}
      </div>
    </>
  );
}

function bodyOf(v: Values, site: SiteView) {
  return {
    level: v.level,
    ...(v.plate.trim() ? { plate: v.plate.trim() } : {}),
    ...(v.personName.trim() ? { personName: v.personName.trim() } : {}),
    reason: v.reason.trim(),
    validTo: v.indefinite || !v.until ? null : endOfDay(v.until, site.timezone),
  };
}

function CreateForm({ site, onDone }: { site: SiteView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<Values>({
    schema: BlacklistCreateSchema,
    initial: EMPTY,
    toBody: (v) => {
      if (!v.indefinite && !v.until) {
        // без даты срок не «бессрочно» по умолчанию, а ошибка у поля
        f.form.setError('until', {
          message: 'Укажите последний день срока или отметьте «Бессрочно».',
        });
        return null;
      }
      return bodyOf(v, site);
    },
    onCreate: async (body) => {
      await mutate(`/sites/${site.id}/blacklist`, 'POST', body);
      toast('Добавлено в чёрный список');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить в чёрный список">
      <Fields f={f} site={site} mode="create" />
    </EditForm>
  );
}

function EditEntry({
  entry,
  site,
  onDone,
}: {
  entry: BlacklistView;
  site: SiteView;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<Values>({
    values: {
      plate: entry.plateNorm ?? '',
      personName: entry.personName ?? '',
      reason: entry.reason,
      level: entry.level,
      indefinite: entry.validTo === null,
      until: entry.validTo ? lastDay(entry.validTo, site.timezone) : '',
    },
    onPatch: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.plate !== undefined) body.plate = patch.plate.trim() || null;
      if (patch.personName !== undefined) body.personName = patch.personName.trim() || null;
      if (patch.reason !== undefined) body.reason = patch.reason.trim();
      if (patch.indefinite !== undefined || patch.until !== undefined) {
        const now = f.form.getValues();
        if (!now.indefinite && !now.until) {
          throw fieldProblem('until', 'Укажите последний день срока или отметьте «Бессрочно».');
        }
        body.validTo = now.indefinite || !now.until ? null : endOfDay(now.until, site.timezone);
      }
      assertValid(BlacklistPatchSchema, body);
      await mutate(`/blacklist/${entry.id}`, 'PATCH', body);
      toast('Запись сохранена');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <Fields f={f} site={site} mode="edit" />
    </EditForm>
  );
}

/** Пакетная вставка номеров (из Excel): общие причина, уровень и срок; проверка — сервером. */
function BatchPlates({ site }: { site: SiteView }) {
  const mutate = useMutate();
  const whole = useWholeOrganization();
  const [reason, setReason] = useState('');
  const [level, setLevel] = useState<BlacklistLevel>('site');
  const [indefinite, setIndefinite] = useState(true);
  const [until, setUntil] = useState('');
  const today = siteToday(site.timezone);

  const parse = useCallback((text: string): ParsedRow<string>[] => {
    return text
      .split(/[\n,;\t]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((raw, i) => {
        const plate = normalizePlate(raw);
        return plate.norm
          ? {
              line: i + 1,
              value: raw,
              ...(plate.recognized ? {} : { note: 'формат номера не распознан' }),
            }
          : { line: i + 1, error: `«${raw}»: в номере нет букв и цифр.` };
      });
  }, []);
  const common = {
    level,
    reason: reason.trim(),
    validTo: indefinite || !until ? null : endOfDay(until, site.timezone),
  };
  const ready = reason.trim().length >= 3 && (indefinite || until !== '');
  const send = (plates: string[], dryRun: boolean) =>
    dryRun
      ? api<BatchResult>(`/sites/${site.id}/blacklist/batch`, {
          method: 'POST',
          body: { ...common, plates, dryRun: true },
        })
      : mutate<BatchResult>(`/sites/${site.id}/blacklist/batch`, 'POST', { ...common, plates });
  const columns = useMemo(
    () => [
      { header: 'Как введено', render: (v: string) => v },
      { header: 'Запишется', render: (v: string) => normalizePlate(v).norm },
    ],
    [],
  );
  return (
    <div className="space-y-4">
      <Field label="Причина для всех номеров" required hint="Одна причина на весь список.">
        <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Срок">
          <Checkbox
            label="Бессрочно"
            checked={indefinite}
            onChange={(e) => setIndefinite(e.target.checked)}
          />
          {indefinite ? null : (
            <DateInput value={until} todayIso={today} onChange={setUntil} aria-label="До даты" />
          )}
        </Field>
        <Field
          label="Уровень"
          disabledReason={
            whole
              ? undefined
              : 'Запись для всей организации добавляет только роль на всю организацию.'
          }
        >
          <Select value={level} onChange={(e) => setLevel(e.target.value as BlacklistLevel)}>
            <option value="site">{LEVEL_LABEL.site}</option>
            <option value="organization" disabled={!whole}>
              {LEVEL_LABEL.organization}
            </option>
          </Select>
        </Field>
      </div>
      {ready ? (
        <BatchInput<string>
          label="Номера машин"
          placeholder={'А123ВС174\nВ777ОР174'}
          help="По одному в строке, через запятую или столбцом из Excel."
          parse={parse}
          columns={columns}
          check={(plates) => send(plates, true)}
          checkKey={`${common.reason}|${common.level}|${common.validTo ?? ''}`}
          commit={(plates) => send(plates, false)}
          commitLabel={(n) => `Добавить номеров: ${n}`}
        />
      ) : (
        <Alert tone="info">
          Укажите причину (и дату, если не «бессрочно») — тогда появится поле для номеров.
        </Alert>
      )}
    </div>
  );
}

function Validity({ entry }: { entry: BlacklistView }) {
  if (entry.validTo === null) return <Badge tone="danger">бессрочно</Badge>;
  return entry.active ? (
    <span>
      до <SiteTime value={entry.validTo} />
    </span>
  ) : (
    <Badge tone="neutral">срок истёк</Badge>
  );
}

/**
 * Чёрный список (этап 6b, ADR-017): номер машины и/или человек, причина, срок, уровень. Въезд —
 * отказ, выезд — только предупреждение. На посту красная карточка с причиной — этап 8.
 */
export function BlacklistCard() {
  return <RequireSite>{(site) => <Body site={site} />}</RequireSite>;
}

function Body({ site }: { site: SiteView }) {
  const list = useBlacklist(site.id);
  const mutate = useMutate();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BlacklistView | null>(null);
  const [removing, setRemoving] = useState<BlacklistView | null>(null);
  const whole = useWholeOrganization();
  if (list.error) return <LoadError error={list.error} retry={() => void list.refetch()} />;
  const items = list.items ?? [];
  return (
    <>
      <Section
        title="Чёрный список"
        description="Номера машин и люди, которых нельзя пускать. Причина обязательна. Въезд такой машине — отказ с причиной; выезд — только предупреждение (выпускаем всегда)."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Добавить
          </Button>
        }
      >
        {list.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Чёрный список пуст"
            hint="Добавьте номер или человека с причиной. Запись можно сделать бессрочной или до даты, для объекта или для всей организации."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus aria-hidden /> Добавить
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Кто</TH>
                <TH>Причина</TH>
                <TH>Срок</TH>
                <TH>Уровень</TH>
                <TH>Добавил</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((e) => {
                // запись «вся организация» правит только роль на всю организацию; администратор объекта её читает
                const readOnly = e.level === 'organization' && !whole;
                const why =
                  'Запись для всей организации: изменить может только роль на всю организацию.';
                return (
                  <TR key={e.id} className={e.active ? undefined : 'opacity-60'}>
                    <TD className="font-medium">
                      {e.plateNorm ? <span className="font-mono">{e.plateNorm}</span> : null}
                      {e.plateNorm && e.personName ? ' · ' : null}
                      {e.personName}
                    </TD>
                    <TD className="max-w-72 break-words">{e.reason}</TD>
                    <TD>
                      <Validity entry={e} />
                    </TD>
                    <TD>
                      <Badge tone={e.level === 'organization' ? 'info' : 'neutral'}>
                        {e.level === 'organization' ? 'вся организация' : 'объект'}
                      </Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      {e.createdByName ?? '—'}
                      <br />
                      <span className="text-xs">
                        <SiteTime value={e.createdAt} />
                      </span>
                    </TD>
                    <TD>
                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Изменить запись: ${e.plateNorm ?? e.personName}`}
                          disabled={readOnly}
                          title={readOnly ? why : undefined}
                          onClick={() => setEditing(e)}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Убрать из списка: ${e.plateNorm ?? e.personName}`}
                          disabled={readOnly}
                          title={readOnly ? why : undefined}
                          onClick={() => setRemoving(e)}
                        >
                          <Trash2 aria-hidden className="text-destructive" />
                        </Button>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Section>

      <Section
        title="Вставить список номеров"
        description="Много номеров сразу, например выгрузка от охраны или из Excel. Причина, срок и уровень — общие для всего списка."
      >
        <BatchPlates site={site} />
      </Section>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>В чёрный список</DialogTitle>
            <DialogDescription>
              Номер и/или человек, причина и срок. Запись попадёт в журнал с вашим именем.
            </DialogDescription>
          </DialogHeader>
          <CreateForm site={site} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Запись чёрного списка</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditEntry entry={editing} site={site} onDone={() => setEditing(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Убрать из чёрного списка?</DialogTitle>
            <DialogDescription>
              {removing?.plateNorm ?? removing?.personName}: запись исчезнет из списка, в журнале
              останется. Машину или человека снова будут пускать.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!removing) return;
                await mutate(`/blacklist/${removing.id}`, 'DELETE');
                toast('Убрано из чёрного списка');
                setRemoving(null);
              }}
            >
              Убрать
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
