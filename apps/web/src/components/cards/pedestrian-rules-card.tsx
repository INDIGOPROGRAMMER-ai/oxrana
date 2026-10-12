import {
  PEDESTRIAN_ESCORTS,
  type PedestrianEscort,
  PedestrianRuleCreateSchema,
} from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
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
  Textarea,
  TH,
  THead,
  TR,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Footprints, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import {
  type PedestrianRuleView,
  useMutate,
  usePedestrianRules,
  useTenants,
  useZones,
} from '../../lib/data';
import { ESCORT_LABEL } from '../../lib/labels';
import { DeleteAction, Empty, GuardPreview, LoadError, RequireSite } from '../common';
import { useTenant } from './tenant-shared';

interface RuleValues {
  zoneId: string;
  documentRequired: boolean;
  escort: PedestrianEscort;
  escortPhone: string;
  guardText: string;
}

const NULLABLE = ['zoneId', 'escortPhone', 'guardText'] as const;

/** Пустая строка → `null`; при «сопровождение не нужно» телефон не отправляется как значение. */
function ruleBody(input: object): Record<string, unknown> {
  const out = { ...input } as Record<string, unknown>;
  for (const key of NULLABLE) {
    const value = out[key];
    if (typeof value === 'string') out[key] = value.trim() === '' ? null : value.trim();
  }
  if (out.escort === 'none') out.escortPhone = null;
  return out;
}

// Те же правила, что у сервера, но с русскими сообщениями о длине.
const PhoneField = z
  .string()
  .trim()
  .min(5, 'Телефон — не короче 5 символов')
  .max(30, 'Телефон — не длиннее 30 символов')
  .nullable()
  .optional();
const GuardTextField = z
  .string()
  .trim()
  .max(300, 'Текст для охраны — не длиннее 300 символов')
  .nullable()
  .optional();
const CreateFormSchema = PedestrianRuleCreateSchema.extend({
  escortPhone: PhoneField,
  guardText: GuardTextField,
});
const PatchFormSchema = z.preprocess(
  (v) => (typeof v === 'object' && v !== null ? ruleBody(v) : v),
  CreateFormSchema.partial(),
);

/**
 * Строка, как она появится в карточке пешехода на посту. Повторяет сборку строки движка:
 * текст для охраны, если он задан, заменяет стандартные фразы; телефон добавляется всегда.
 */
export function describeRuleForGuard(rule: {
  documentRequired: boolean;
  escort: PedestrianEscort;
  escortPhone: string | null;
  guardText: string | null;
}): string {
  const parts: string[] = [];
  if (rule.guardText) {
    parts.push(rule.guardText);
  } else {
    if (rule.documentRequired) parts.push('Проверьте документ');
    if (rule.escort === 'always') parts.push('Сопровождение: всегда');
    if (rule.escort === 'if_no_document') parts.push('Без документа — сопровождение');
  }
  if (rule.escortPhone) parts.push(`позвоните ${rule.escortPhone}`);
  return parts.length > 0 ? parts.join(' · ') : 'Особых условий нет — достаточно пропуска';
}

function RuleFields({
  f,
  zones,
  taken,
}: {
  f: FormController<RuleValues>;
  zones: { id: string; name: string }[];
  /** Зоны, для которых у арендатора уже есть правило ('' — «везде»). */
  taken: ReadonlySet<string>;
}) {
  const { register, watch, setValue } = f.form;
  const escort = watch('escort');
  const zoneId = watch('zoneId');
  const escortReg = register('escort');
  const phone = watch('escortPhone');
  return (
    <>
      <Field
        label="Где действует"
        hint="Правило на зону сильнее общего: если пешеход идёт в эту зону, берётся оно. Без зоны — правило действует везде у арендатора."
        error={f.fieldError('zoneId')}
      >
        <Select {...register('zoneId')}>
          <option value="">— везде у арендатора —</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
      </Field>
      {taken.has(zoneId) ? (
        <Alert tone="warning">
          {zoneId === ''
            ? 'Общее правило у этого арендатора уже есть.'
            : 'Для этой зоны правило уже есть.'}{' '}
          Два правила на одно место не нужны: охране покажется только одно из них. Лучше изменить
          имеющееся.
        </Alert>
      ) : null}
      <Checkbox
        {...register('documentRequired')}
        label="Документ обязателен"
        hint="Охрана проверяет документ у каждого пешехода этого арендатора."
      />
      <Field label="Сопровождение" error={f.fieldError('escort')}>
        <Select
          {...escortReg}
          onChange={(e) => {
            void escortReg.onChange(e);
            if (e.target.value === 'none') {
              setValue('escortPhone', '', { shouldDirty: true });
            }
          }}
        >
          {PEDESTRIAN_ESCORTS.map((v) => (
            <option key={v} value={v}>
              {ESCORT_LABEL[v]}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Телефон сопровождающего"
        required={escort !== 'none'}
        hint="Куда охране звонить, чтобы за посетителем вышли. Охрана увидит номер в карточке."
        disabledReason={
          escort === 'none'
            ? 'Недоступно: сопровождение не нужно. Выберите «если нет документа» или «всегда», чтобы указать телефон.'
            : undefined
        }
        error={f.fieldError('escortPhone')}
      >
        <Input {...register('escortPhone')} type="tel" maxLength={30} placeholder="+7 …" />
      </Field>
      {escort !== 'none' && phone.trim() === '' ? (
        <p className="-mt-2 text-xs text-warning">
          Без телефона правило не сохранится: сопровождение без номера для звонка охране не поможет.
        </p>
      ) : null}
      <Field
        label="Текст для охраны"
        hint="Одна короткая фраза. Если заполнить, она заменяет стандартные «Проверьте документ…» — телефон всё равно добавится."
        error={f.fieldError('guardText')}
      >
        <Textarea {...register('guardText')} rows={2} maxLength={300} />
      </Field>
      <GuardPreview title="Строка на посту">
        <p>
          {describeRuleForGuard({
            documentRequired: watch('documentRequired'),
            escort,
            escortPhone: escort === 'none' ? null : phone.trim() || null,
            guardText: watch('guardText').trim() || null,
          })}
        </p>
      </GuardPreview>
    </>
  );
}

function CreateRuleForm({
  tenantId,
  zones,
  taken,
  onDone,
}: {
  tenantId: string;
  zones: { id: string; name: string }[];
  taken: ReadonlySet<string>;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<RuleValues>({
    schema: CreateFormSchema,
    initial: { zoneId: '', documentRequired: true, escort: 'none', escortPhone: '', guardText: '' },
    toBody: (v) => ruleBody(v),
    onCreate: async (body) => {
      await mutate(`/tenants/${tenantId}/pedestrian-rules`, 'POST', body);
      toast('Правило для пешеходов добавлено');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить правило">
      <RuleFields f={f} zones={zones} taken={taken} />
    </EditForm>
  );
}

function EditRuleForm({
  rule,
  zones,
  taken,
  onDone,
}: {
  rule: PedestrianRuleView;
  zones: { id: string; name: string }[];
  taken: ReadonlySet<string>;
  onDone: () => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<RuleValues>({
    values: {
      zoneId: rule.zoneId ?? '',
      documentRequired: rule.documentRequired,
      escort: rule.escort,
      escortPhone: rule.escortPhone ?? '',
      guardText: rule.guardText ?? '',
    },
    schema: PatchFormSchema,
    onPatch: async (patch) => {
      await mutate(`/pedestrian-rules/${rule.id}`, 'PATCH', ruleBody(patch));
      toast('Правило сохранено');
      onDone();
    },
  });
  // своя зона не считается занятой
  const others = new Set(taken);
  others.delete(rule.zoneId ?? '');
  return (
    <EditForm form={f}>
      <RuleFields f={f} zones={zones} taken={others} />
    </EditForm>
  );
}

/**
 * Правила для пешеходов арендатора (16_ A3): документ, сопровождение, телефон, текст охране.
 * Правило может быть общим на арендатора или на зону; под списком — строка, как её увидит охранник.
 */
export function PedestrianRulesCard({ tenantId }: { tenantId: string }) {
  const tenant = useTenant(tenantId);
  const rules = usePedestrianRules(tenantId);
  const zones = useZones(tenant.data?.siteId ?? null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PedestrianRuleView | null>(null);
  if (rules.error) return <LoadError error={rules.error} retry={() => void rules.refetch()} />;
  const items = rules.items ?? [];
  const zoneList = zones.items ?? [];
  const zoneName = (id: string | null) =>
    id === null
      ? 'везде у арендатора'
      : (zoneList.find((z) => z.id === id)?.name ?? 'зона удалена');
  const taken = new Set(items.map((r) => r.zoneId ?? ''));
  return (
    <>
      <Section
        title="Правила для пешеходов"
        description="Что охране делать с пешеходом этого арендатора: проверять ли документ, нужно ли сопровождение и кому звонить."
        actions={
          <Button size="sm" onClick={() => setCreating(true)} disabled={!tenant.data}>
            <Plus aria-hidden /> Добавить правило
          </Button>
        }
      >
        {rules.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Правил для пешеходов нет"
            hint="Пока правила нет, охрана пускает пешехода по одному пропуску, без проверки документа и без сопровождения. Добавьте правило, если у арендатора есть особые условия."
            action={
              <Button onClick={() => setCreating(true)} disabled={!tenant.data}>
                <Footprints aria-hidden /> Добавить правило
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Где действует</TH>
                <TH>Документ</TH>
                <TH>Сопровождение</TH>
                <TH>Телефон</TH>
                <TH>Текст для охраны</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {items.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">{zoneName(r.zoneId)}</TD>
                  <TD>
                    <Badge tone={r.documentRequired ? 'info' : 'neutral'}>
                      {r.documentRequired ? 'обязателен' : 'не нужен'}
                    </Badge>
                  </TD>
                  <TD>{ESCORT_LABEL[r.escort]}</TD>
                  <TD className="tabular-nums">{r.escortPhone ?? '—'}</TD>
                  <TD className="text-muted-foreground">{r.guardText ?? '—'}</TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Изменить правило: ${zoneName(r.zoneId)}`}
                        onClick={() => setEditing(r)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteAction
                        collection="pedestrian-rules"
                        id={r.id}
                        name={`правило для пешеходов («${zoneName(r.zoneId)}»)`}
                        title="Удалить правило для пешеходов?"
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
            {items.map((r) => (
              <li key={r.id}>
                {r.zoneId === null ? 'Везде' : `Зона «${zoneName(r.zoneId)}»`}:{' '}
                {describeRuleForGuard(r)}
              </li>
            ))}
          </ul>
        </GuardPreview>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Новое правило для пешеходов</DialogTitle>
            <DialogDescription>
              Документ, сопровождение и телефон — охрана увидит их в карточке пешехода.
            </DialogDescription>
          </DialogHeader>
          <CreateRuleForm
            tenantId={tenantId}
            zones={zoneList}
            taken={taken}
            onDone={() => setCreating(false)}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Правило для пешеходов</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? (
            <EditRuleForm
              rule={editing}
              zones={zoneList}
              taken={taken}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Шаг мастера «Правила для пешеходов»: выбор арендатора и его правила. */
export function PedestrianRulesStep() {
  return <RequireSite>{(site) => <StepBody siteId={site.id} />}</RequireSite>;
}

function StepBody({ siteId }: { siteId: string }) {
  const tenants = useTenants(siteId);
  const [tenantId, setTenantId] = useState('');
  if (tenants.error)
    return <LoadError error={tenants.error} retry={() => void tenants.refetch()} />;
  const items = tenants.items ?? [];
  const chosen = items.find((t) => t.id === tenantId);
  return (
    <>
      <Section
        title="Арендатор"
        description="Правила для пешеходов задаются отдельно для каждого арендатора."
      >
        {tenants.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Арендаторов ещё нет"
            hint="Сначала добавьте арендаторов в шаге «Арендаторы» — затем вернитесь сюда."
          />
        ) : (
          <Field label="Для какого арендатора настроить правила">
            <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">— выберите арендатора —</option>
              {items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.shortName}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Section>
      {chosen ? <PedestrianRulesCard tenantId={chosen.id} /> : null}
    </>
  );
}
