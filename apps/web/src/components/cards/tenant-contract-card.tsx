import {
  ClauseCreateSchema,
  ClausePatchSchema,
  ContractCreateSchema,
  ContractPatchSchema,
  type ContractStatus,
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
  formatLocalDate,
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
import { FilePlus2, FileText, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import {
  type ClauseView,
  type ContractView,
  useClauses,
  useContracts,
  useMutate,
} from '../../lib/data';
import { DeleteAction, Empty, GuardPreview, LoadError } from '../common';

const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = {
  draft: 'черновик',
  active: 'действует',
  expired: 'истёк',
  terminated: 'расторгнут',
};
const CONTRACT_STATUS_TONE: Record<ContractStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  active: 'success',
  expired: 'warning',
  terminated: 'danger',
};

const CONTRACT_NULLABLE = ['number', 'signedOn', 'validFrom', 'validTo', 'notes'] as const;

/** Пустая строка → `null` (так сервер понимает «очистить»). */
function contractBody(input: object): Record<string, unknown> {
  const out = { ...input } as Record<string, unknown>;
  for (const key of CONTRACT_NULLABLE) {
    const value = out[key];
    if (typeof value === 'string') out[key] = value.trim() === '' ? null : value.trim();
  }
  return out;
}
const ContractPatchFormSchema = z.preprocess(
  (v) => (typeof v === 'object' && v !== null ? contractBody(v) : v),
  ContractPatchSchema,
);

interface ContractValues {
  number: string;
  signedOn: string;
  validFrom: string;
  validTo: string;
  status: ContractStatus;
  notes: string;
}

function ContractFields({ f }: { f: FormController<ContractValues> }) {
  const { register, watch } = f.form;
  const from = watch('validFrom');
  const to = watch('validTo');
  return (
    <>
      <Field label="Номер договора" error={f.fieldError('number')}>
        <Input {...register('number')} maxLength={100} placeholder="Как в договоре" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Дата подписания" error={f.fieldError('signedOn')}>
          <Input type="date" {...register('signedOn')} />
        </Field>
        <Field label="Действует с" error={f.fieldError('validFrom')}>
          <Input type="date" {...register('validFrom')} />
        </Field>
        <Field label="Действует по" error={f.fieldError('validTo')}>
          <Input type="date" {...register('validTo')} />
        </Field>
      </div>
      {from && to && to < from ? (
        <Alert tone="warning">
          Дата окончания раньше даты начала. Проверьте даты — договор с таким сроком нигде не будет
          действовать.
        </Alert>
      ) : null}
      <p className="-mt-2 text-xs text-muted-foreground">
        Даты — местные, по календарю объекта: без времени и без пересчёта поясов.
      </p>
      <Field label="Статус" error={f.fieldError('status')}>
        <Select {...register('status')}>
          {(Object.keys(CONTRACT_STATUS_LABEL) as ContractStatus[]).map((s) => (
            <option key={s} value={s}>
              {CONTRACT_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Примечание" error={f.fieldError('notes')}>
        <Textarea {...register('notes')} maxLength={2000} rows={3} />
      </Field>
      <Field label="Файл договора (PDF)" disabledReason="Загрузка файлов появится позже.">
        <Input type="file" accept="application/pdf" />
      </Field>
    </>
  );
}

function CreateContractForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<ContractValues>({
    schema: ContractCreateSchema,
    initial: { number: '', signedOn: '', validFrom: '', validTo: '', status: 'active', notes: '' },
    toBody: (v) => contractBody(v),
    onCreate: async (body) => {
      await mutate(`/tenants/${tenantId}/contracts`, 'POST', body);
      toast('Договор добавлен');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить договор">
      <ContractFields f={f} />
    </EditForm>
  );
}

function EditContractForm({ contract, onDone }: { contract: ContractView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<ContractValues>({
    values: {
      number: contract.number ?? '',
      signedOn: contract.signedOn ?? '',
      validFrom: contract.validFrom ?? '',
      validTo: contract.validTo ?? '',
      status: contract.status,
      notes: contract.notes ?? '',
    },
    schema: ContractPatchFormSchema,
    onPatch: async (patch) => {
      await mutate(`/contracts/${contract.id}`, 'PATCH', contractBody(patch));
      toast('Договор сохранён');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <ContractFields f={f} />
    </EditForm>
  );
}

interface ClauseValues {
  ref: string;
  summary: string;
}

function ClauseFields({ f }: { f: FormController<ClauseValues> }) {
  const { register } = f.form;
  return (
    <>
      <Field
        label="Пункт"
        required
        hint="Номер пункта в договоре: он покажется охране как основание."
        error={f.fieldError('ref')}
      >
        <Input
          {...register('ref')}
          maxLength={50}
          placeholder="Например, «п. 3.2» или «Приложение 1»"
        />
      </Field>
      <Field
        label="Что сказано"
        required
        hint="Коротко своими словами: сколько машин, какие условия."
        error={f.fieldError('summary')}
      >
        <Textarea {...register('summary')} maxLength={1000} rows={4} />
      </Field>
    </>
  );
}

function CreateClauseForm({ contractId, onDone }: { contractId: string; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useCreateForm<ClauseValues>({
    schema: ClauseCreateSchema,
    initial: { ref: '', summary: '' },
    onCreate: async (body) => {
      await mutate(`/contracts/${contractId}/clauses`, 'POST', body);
      toast('Пункт добавлен');
      onDone();
    },
  });
  return (
    <EditForm form={f} mode="create" submitLabel="Добавить пункт">
      <ClauseFields f={f} />
    </EditForm>
  );
}

function EditClauseForm({ clause, onDone }: { clause: ClauseView; onDone: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const f = useEditForm<ClauseValues>({
    values: { ref: clause.ref, summary: clause.summary },
    schema: ClausePatchSchema,
    onPatch: async (patch) => {
      await mutate(`/clauses/${clause.id}`, 'PATCH', patch);
      toast('Пункт сохранён');
      onDone();
    },
  });
  return (
    <EditForm form={f}>
      <ClauseFields f={f} />
    </EditForm>
  );
}

/** Пункты одного договора: основание лимитов, назначений и исключений. */
function ClausesPanel({ contractId }: { contractId: string }) {
  const clauses = useClauses(contractId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ClauseView | null>(null);
  if (clauses.error)
    return <LoadError error={clauses.error} retry={() => void clauses.refetch()} />;
  const items = clauses.items ?? [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Пункты договора</h4>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus aria-hidden /> Добавить пункт
        </Button>
      </div>
      {clauses.isLoading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Пунктов пока нет. Выпишите из договора то, на чём держатся лимиты, доки и исключения, —
          потом их можно будет выбрать как основание.
        </p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-40">Пункт</TH>
              <TH>Что сказано</TH>
              <TH className="w-24" />
            </TR>
          </THead>
          <TBody>
            {items.map((c) => (
              <TR key={c.id}>
                <TD className="font-medium">{c.ref}</TD>
                <TD className="whitespace-pre-line">{c.summary}</TD>
                <TD>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Изменить пункт: ${c.ref}`}
                      onClick={() => setEditing(c)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <DeleteAction
                      collection="clauses"
                      id={c.id}
                      name={`пункт «${c.ref}»`}
                      title="Удалить пункт договора?"
                    />
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Новый пункт договора</DialogTitle>
            <DialogDescription>Номер пункта и суть — основание для лимитов.</DialogDescription>
          </DialogHeader>
          <CreateClauseForm contractId={contractId} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Пункт «{editing?.ref}»</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? <EditClauseForm clause={editing} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function describePeriod(c: ContractView): string {
  if (c.validFrom && c.validTo)
    return `с ${formatLocalDate(c.validFrom)} по ${formatLocalDate(c.validTo)}`;
  if (c.validFrom) return `с ${formatLocalDate(c.validFrom)}, без даты окончания`;
  if (c.validTo) return `до ${formatLocalDate(c.validTo)}`;
  return 'срок не указан';
}

function contractTitle(c: ContractView): string {
  return c.number ? `Договор № ${c.number}` : 'Договор без номера';
}

/**
 * Договоры арендатора и их пункты. Пункт договора — основание лимитов, назначений доков и
 * исключений: его выбирают в этих формах, и охрана видит его в причине вердикта.
 */
export function TenantContractCard({ tenantId }: { tenantId: string }) {
  const contracts = useContracts(tenantId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ContractView | null>(null);
  if (contracts.error)
    return <LoadError error={contracts.error} retry={() => void contracts.refetch()} />;
  const items = contracts.items ?? [];
  return (
    <>
      <Section
        title="Договор и пункты"
        description="Договор арендатора и выписанные из него пункты. Пункт — основание лимита: по нему видно, откуда взялась цифра."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Добавить договор
          </Button>
        }
      >
        {contracts.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Загрузка…
          </p>
        ) : items.length === 0 ? (
          <Empty
            title="Договора ещё нет"
            hint="Добавьте договор, затем выпишите из него пункты. Без договора лимиты тоже работают, но без указания основания."
            action={
              <Button onClick={() => setCreating(true)}>
                <FilePlus2 aria-hidden /> Добавить договор
              </Button>
            }
          />
        ) : (
          <div className="space-y-5">
            {items.map((c) => (
              <article key={c.id} className="space-y-3 rounded-md border p-4">
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <h3 className="flex flex-wrap items-center gap-2 font-medium">
                      <FileText aria-hidden className="size-4 text-muted-foreground" />
                      {contractTitle(c)}
                      <Badge tone={CONTRACT_STATUS_TONE[c.status]}>
                        {CONTRACT_STATUS_LABEL[c.status]}
                      </Badge>
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Подписан: {c.signedOn ? formatLocalDate(c.signedOn) : '—'} · Действует{' '}
                      {describePeriod(c)}
                    </p>
                    {c.notes ? <p className="whitespace-pre-line text-sm">{c.notes}</p> : null}
                  </div>
                  <div className="flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Изменить: ${contractTitle(c)}`}
                      onClick={() => setEditing(c)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <DeleteAction
                      collection="contracts"
                      id={c.id}
                      name={contractTitle(c)}
                      title="Удалить договор?"
                    />
                  </div>
                </header>
                <ClausesPanel contractId={c.id} />
              </article>
            ))}
          </div>
        )}
      </Section>
      {items.length > 0 ? (
        <GuardPreview title="Как основание выглядит у охранника">
          <p>
            «Грузовые 25/25 — машина будет ждать · основание: п. 3.2 договора № …». Номер договора и
            пункта берётся отсюда, поэтому пишите их так, как они в бумажном договоре.
          </p>
        </GuardPreview>
      ) : null}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Новый договор</DialogTitle>
            <DialogDescription>
              Все поля необязательны: договор можно завести сразу, а подробности дописать позже.
            </DialogDescription>
          </DialogHeader>
          <CreateContractForm tenantId={tenantId} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? contractTitle(editing) : 'Договор'}</DialogTitle>
            <DialogDescription>Сохраняются только изменённые поля.</DialogDescription>
          </DialogHeader>
          {editing ? <EditContractForm contract={editing} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
