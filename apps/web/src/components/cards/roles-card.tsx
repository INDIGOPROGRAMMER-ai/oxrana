import {
  PERMISSION_GROUPS,
  PERMISSIONS,
  type PermissionViewSchema,
  ROLE_TEMPLATES,
  type RoleScope,
  type RoleViewSchema,
} from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  Input,
  Section,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@oxrana/ui';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { useApi, useMe, useMutate } from '../../lib/data';
import { Empty, LoadError } from '../common';
import { UsersCard } from './users-card';

type RoleView = z.infer<typeof RoleViewSchema>;
type PermissionView = z.infer<typeof PermissionViewSchema>;

const SCOPE_LABEL: Record<RoleScope, string> = {
  organization: 'вся организация',
  site: 'объект',
  gate: 'КПП',
  tenant: 'арендатор',
};

/** Область, в которой роль обычно назначают, — по шаблону; у своей роли она задаётся при назначении. */
function scopeOf(role: RoleView): string {
  const template = ROLE_TEMPLATES.find((t) => t.code === role.templateCode);
  return template ? SCOPE_LABEL[template.scope] : 'выбирается при назначении';
}

function plural(n: number, forms: readonly [string, string, string]): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

/**
 * Редактор роли: права группами с понятными подписями. Нельзя выдать шире своих прав: право, которого
 * нет у вас, показано неактивным с причиной (ADR-007, 018). Без права «Роли и права» окно — только
 * для просмотра.
 */
function RoleEditor({
  role,
  labels,
  onClose,
}: {
  role: RoleView;
  labels: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const { me, can } = useMe();
  const mutate = useMutate();
  const toast = useToast();
  const mine = new Set(me?.permissions ?? []);
  const canEdit = can('role.manage');
  const tooBroad = role.permissions.some((p) => !mine.has(p));
  const readOnly = !canEdit || tooBroad;
  const [name, setName] = useState(role.name);
  const [granted, setGranted] = useState<ReadonlySet<string>>(new Set(role.permissions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);

  const permissionsChanged =
    granted.size !== role.permissions.length || role.permissions.some((p) => !granted.has(p));
  const nameChanged = name.trim() !== role.name;
  const changed = permissionsChanged || nameChanged;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/roles/${role.id}`, 'PATCH', {
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(permissionsChanged ? { permissions: [...granted].sort() } : {}),
      });
      toast('Роль сохранена');
      onClose();
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Роль «{role.name}»</DialogTitle>
        <DialogDescription>
          {readOnly
            ? 'Только просмотр.'
            : 'Отметьте права, которые даёт роль. Сохраняются только изменения.'}
        </DialogDescription>
      </DialogHeader>
      {!canEdit ? (
        <Alert tone="warning">
          Менять роли может пользователь с правом «Роли и права». Здесь права только для просмотра.
        </Alert>
      ) : tooBroad ? (
        <Alert tone="warning">
          Роль шире ваших прав — изменить её может владелец организации или тот, у кого есть все её
          права.
        </Alert>
      ) : null}
      <Field label="Название роли" required>
        <Input
          value={name}
          maxLength={100}
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
        {PERMISSION_GROUPS.map((group) => (
          <fieldset key={group.title} className="space-y-1.5 border-0 p-0">
            <legend className="text-sm font-medium">{group.title}</legend>
            <p className="text-xs text-muted-foreground">{group.hint}</p>
            {group.codes.map((code) => {
              const held = mine.has(code);
              const on = granted.has(code);
              return (
                <Checkbox
                  key={code}
                  label={labels.get(code) ?? code}
                  hint={
                    !held && !readOnly ? 'Нельзя выдать: этого права нет у вас самих.' : undefined
                  }
                  checked={on}
                  disabled={readOnly || (!held && !on)}
                  onChange={(e) => {
                    const next = new Set(granted);
                    if (e.target.checked) next.add(code);
                    else next.delete(code);
                    setGranted(next);
                  }}
                />
              );
            })}
          </fieldset>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Выдано прав: {granted.size} из {PERMISSIONS.length}.
        {granted.size === 0 ? ' Роль без прав ничего не разрешает.' : ''}
      </p>
      <ErrorAlert error={error} />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {readOnly ? 'Закрыть' : 'Отмена'}
        </Button>
        {readOnly ? null : (
          <Button disabled={busy || !changed || name.trim() === ''} onClick={() => void save()}>
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            Сохранить
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function CreateRole({
  onCreated,
  onClose,
}: {
  onCreated: (role: RoleView) => void;
  onClose: () => void;
}) {
  const mutate = useMutate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      // Новая роль создаётся без прав (ADR-007): права выдаются следующим шагом осознанно.
      const role = await mutate<RoleView>('/roles', 'POST', { name: name.trim(), permissions: [] });
      onCreated(role);
    } catch (raw) {
      setError(errorView(raw));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Новая роль</DialogTitle>
        <DialogDescription>
          Роль создаётся без прав: сначала название, потом вы сами отмечаете, что она разрешает.
        </DialogDescription>
      </DialogHeader>
      <Field label="Название роли" required>
        <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <ErrorAlert error={error} />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy || name.trim() === ''} onClick={() => void create()}>
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
          Создать роль
        </Button>
      </DialogFooter>
    </>
  );
}

function DeleteRole({ role, onClose }: { role: RoleView; onClose: () => void }) {
  const mutate = useMutate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorView | null>(null);
  const [needConfirm, setNeedConfirm] = useState(false);
  async function remove(confirm: boolean) {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/roles/${role.id}?confirm=${confirm}`, 'DELETE');
      toast('Роль удалена');
      onClose();
    } catch (raw) {
      const view = errorView(raw);
      setError(view);
      // роль кому-то назначена: покажем, кому, и спросим подтверждение
      if (view.code === 'in_use' && !view.message.includes('учёткам КПП')) setNeedConfirm(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Удалить роль «{role.name}»?</DialogTitle>
        <DialogDescription>
          Люди с этой ролью потеряют её права. Если роль кому-то назначена, система покажет, кому.
        </DialogDescription>
      </DialogHeader>
      <ErrorAlert error={error} />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void remove(needConfirm)}>
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {needConfirm ? 'Удалить всё равно' : 'Удалить'}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Карточка «Роли» (этап 6б): список ролей организации, создание (без прав), правка прав группами,
 * удаление с показом, кому роль назначена. Нельзя выдать шире своих прав.
 */
export function RolesCard() {
  const roles = useApi<{ items: RoleView[] }>('/roles');
  const permissions = useApi<{ items: PermissionView[] }>('/permissions');
  const { can } = useMe();
  const [editing, setEditing] = useState<RoleView | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RoleView | null>(null);
  const labels = new Map((permissions.data?.items ?? []).map((p) => [p.code, p.label]));
  const items = roles.data?.items ?? [];
  const canManage = can('role.manage');
  // после создания роль открывается в редакторе, чтобы выдать права
  const fresh = (id: string) => items.find((r) => r.id === id) ?? null;
  return (
    <Section
      title="Роли"
      description="Роль — набор прав. Человеку роль назначают в области: вся организация, объект или арендатор; учётка КПП получает роль «Пост КПП» сама. Новая роль создаётся без прав; выдать больше, чем есть у вас самих, нельзя."
      actions={
        <Button
          size="sm"
          disabled={!canManage}
          onClick={() => setCreating(true)}
          title={canManage ? undefined : 'Нужно право «Роли и права»'}
        >
          <Plus aria-hidden /> Новая роль
        </Button>
      }
    >
      {roles.error ? (
        <LoadError error={roles.error} retry={() => void roles.refetch()} />
      ) : roles.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <Empty
          title="Ролей пока нет"
          hint="Шаблоны ролей создаются вместе с организацией. Если их нет, обратитесь к владельцу платформы."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Роль</TH>
              <TH>Обычно назначают на</TH>
              <TH>Права</TH>
              <TH className="w-28" />
            </TR>
          </THead>
          <TBody>
            {items.map((role) => (
              <TR key={role.id}>
                <TD className="font-medium">
                  {role.name}{' '}
                  {role.isTemplate ? (
                    <Badge tone="outline" className="ml-1">
                      шаблон
                    </Badge>
                  ) : null}
                </TD>
                <TD>{scopeOf(role)}</TD>
                <TD>
                  {role.permissions.length}{' '}
                  {plural(role.permissions.length, ['право', 'права', 'прав'])}
                  <span className="text-muted-foreground"> из {PERMISSIONS.length}</span>
                  {role.permissions.length === 0 ? (
                    <span className="block text-xs text-muted-foreground">
                      прав нет — роль ничего не разрешает
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${canManage ? 'Изменить' : 'Посмотреть'} роль: ${role.name}`}
                      onClick={() => setEditing(role)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Удалить роль: ${role.name}`}
                      disabled={!canManage}
                      title={canManage ? undefined : 'Нужно право «Роли и права»'}
                      onClick={() => setDeleting(role)}
                    >
                      <Trash2 aria-hidden className="text-destructive" />
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          {editing ? (
            <RoleEditor
              key={editing.id}
              role={fresh(editing.id) ?? editing}
              labels={labels}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <CreateRole
            onClose={() => setCreating(false)}
            onCreated={(role) => {
              setCreating(false);
              setEditing(role);
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          {deleting ? (
            <DeleteRole key={deleting.id} role={deleting} onClose={() => setDeleting(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/** Шаг мастера «Люди»: приглашения и пользователи, ниже — роли. */
export function PeopleCard() {
  return (
    <>
      <UsersCard />
      <RolesCard />
    </>
  );
}
