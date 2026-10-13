import {
  ClauseCreateSchema,
  ClausePatchSchema,
  CONTRACT_FILE_ERASE_WARNING,
  ContractCreateSchema,
  ContractPatchSchema,
  type ContractStatus,
} from '@oxrana/contracts';
import {
  Alert,
  api,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  Textarea,
  TH,
  THead,
  TR,
  useCreateForm,
  useEditForm,
  useToast,
} from '@oxrana/ui';
import { Download, FilePlus2, FileText, Loader2, Paperclip, Pencil, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { z } from 'zod';
import {
  type ClauseView,
  type ContractView,
  useClauses,
  useContracts,
  useMe,
  useMutate,
  useRefresh,
  useTrackContracts,
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
  const { register, watch, control } = f.form;
  const from = watch('validFrom');
  const to = watch('validTo');
  return (
    <>
      <Field label="Номер договора" error={f.fieldError('number')}>
        <Input {...register('number')} maxLength={100} placeholder="Как в договоре" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Дата подписания" error={f.fieldError('signedOn')}>
          <FormDateInput control={control} name="signedOn" />
        </Field>
        <Field label="Действует с" error={f.fieldError('validFrom')}>
          <FormDateInput control={control} name="validFrom" />
        </Field>
        <Field label="Действует по" error={f.fieldError('validTo')}>
          <FormDateInput control={control} name="validTo" />
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
      <p className="text-xs text-muted-foreground">
        Файл договора (PDF или скан) прикрепляется после сохранения — кнопкой «Прикрепить файл» у
        договора. Это по желанию.
      </p>
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

const FILE_MAX_MB = 10;

/**
 * Файл договора — по желанию и по отдельному праву `contract.file` (договор может быть
 * коммерческой тайной). Без права файл не виден и не загружается; причина названа.
 */
function ContractFile({ contract }: { contract: ContractView }) {
  const { can } = useMe();
  const refresh = useRefresh();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Подтверждение необратимого стирания: заменяемый файл или открепление.
  const [confirm, setConfirm] = useState<
    { kind: 'replace'; chosen: File } | { kind: 'detach' } | null
  >(null);
  if (!can('contract.file')) {
    return (
      <p className="text-xs text-muted-foreground">
        Файл договора доступен только пользователям с правом «Файлы договоров».
      </p>
    );
  }
  const file = contract.file;

  async function upload(chosen: File, confirmed = false) {
    setError(null);
    if (chosen.size > FILE_MAX_MB * 1024 * 1024) {
      setError(`Файл больше ${FILE_MAX_MB} МБ. Сожмите его или загрузите меньший.`);
      return;
    }
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(chosen.type)) {
      setError('Файл договора — PDF, PNG, JPEG или WebP. Другие форматы не принимаются.');
      return;
    }
    if (file && !confirmed) {
      setConfirm({ kind: 'replace', chosen });
      return;
    }
    setBusy(true);
    try {
      const query = `name=${encodeURIComponent(chosen.name)}${file ? '&confirm=true' : ''}`;
      await api(`/contracts/${contract.id}/file?${query}`, {
        method: 'PUT',
        file: chosen,
      });
      await refresh();
      toast('Файл прикреплён');
    } catch (raw) {
      setError(raw instanceof Error ? raw.message : 'Не удалось загрузить файл.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function detach() {
    setBusy(true);
    setError(null);
    try {
      await api(`/contracts/${contract.id}/file?confirm=true`, { method: 'DELETE' });
      await refresh();
      toast('Файл откреплён');
    } catch (raw) {
      setError(raw instanceof Error ? raw.message : 'Не удалось открепить файл.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Paperclip aria-hidden className="size-4 text-muted-foreground" />
      {file ? (
        <>
          <span className="font-medium">{file.fileName}</span>
          <span className="text-muted-foreground">
            {file.sizeBytes < 1024 * 1024
              ? `${Math.max(1, Math.round(file.sizeBytes / 1024))} КБ`
              : `${(file.sizeBytes / 1024 / 1024).toFixed(1)} МБ`}
          </span>
          <Button asChild size="sm" variant="outline">
            <a href={`/api/contracts/${contract.id}/file`} download>
              <Download aria-hidden /> Скачать
            </a>
          </Button>
        </>
      ) : (
        <span className="text-muted-foreground">Файла нет (по желанию)</span>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept="application/pdf,image/png,image/jpeg,image/webp"
        aria-label={`Файл договора: ${contractTitle(contract)}`}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) void upload(chosen);
        }}
      />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
        {file ? 'Заменить файл' : 'Прикрепить файл'}
      </Button>
      {file ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirm({ kind: 'detach' })}
        >
          <X aria-hidden /> Открепить
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'replace' ? 'Заменить файл договора?' : 'Открепить файл договора?'}
            </DialogTitle>
            <DialogDescription>
              Файл «{file?.fileName}» будет удалён без возможности восстановления.{' '}
              {CONTRACT_FILE_ERASE_WARNING.replace(
                /^Файл будет удалён без возможности восстановления\.\s*/,
                '',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action?.kind === 'replace') void upload(action.chosen, true);
                else void detach();
              }}
            >
              {confirm?.kind === 'replace' ? 'Заменить и удалить старый' : 'Открепить и удалить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Договоры арендатора и их пункты. Договор необязателен (бывает коммерческой тайной); если он есть,
 * он даёт две вещи: срок (после окончания договора пропуска перестают действовать сами) и пункты —
 * основание, на которое ссылаются лимиты и доки.
 */
export function TenantContractCard({ tenantId }: { tenantId: string }) {
  const track = useTrackContracts();
  const contracts = useContracts(track ? tenantId : null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ContractView | null>(null);
  if (!track) {
    return (
      <Alert tone="info" title="Ведение договоров выключено">
        В настройках организации выключено «Вести договоры»: разделы и поля договоров скрыты, срок
        договора не проверяется. Включить — «Объект» → «Настройки организации».
      </Alert>
    );
  }
  if (contracts.error)
    return <LoadError error={contracts.error} retry={() => void contracts.refetch()} />;
  const items = contracts.items ?? [];
  return (
    <>
      <Section
        title="Договор и пункты"
        description="Договор необязателен. Если он есть, он нужен для двух вещей: срок договора (когда договор кончился, пропуска арендатора перестают действовать сами) и пункты — основание, на которое ссылаются лимиты и доки."
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
            hint="Договор не обязателен: без него лимиты, доки и пропуска работают, только без срока договора и без ссылок на пункты."
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
                <ContractFile contract={c} />
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
