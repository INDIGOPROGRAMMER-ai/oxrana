import {
  type InvitationCreatedSchema,
  InvitationCreateSchema,
  type InvitationViewSchema,
  ROLE_TEMPLATES,
  type RoleViewSchema,
  type UserViewSchema,
} from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  EditForm,
  ErrorAlert,
  type ErrorView,
  errorView,
  Field,
  Input,
  Section,
  Select,
  SiteTime,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useCreateForm,
  useToast,
} from '@oxrana/ui';
import { Copy, KeyRound, RotateCw, UserCheck, UserX, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useApi, useMe, useMutate, useSites, useTenants } from '../../lib/data';
import { useSite } from '../../lib/site-context';
import { Empty, LoadError } from '../common';
import { ReasonDialog } from '../reason-dialog';

type UserView = z.infer<typeof UserViewSchema>;
type InvitationView = z.infer<typeof InvitationViewSchema>;
type InvitationCreated = z.infer<typeof InvitationCreatedSchema>;
type RoleView = z.infer<typeof RoleViewSchema>;
type Assignment = UserView['assignments'][number];

const PEOPLE_RIGHTS = ['user.manage', 'tenant_user.manage'];
const NO_PEOPLE_RIGHT =
  'Нужно право «Пользователи и приглашения» или «Пользователи своей компании» — его выдаёт владелец организации';
const NO_USER_RIGHT =
  'Нужно право «Пользователи и приглашения» — пользователей своей компании это право не затрагивает';

const INVITATION_STATUS: Record<
  InvitationView['status'],
  { label: string; tone: 'info' | 'success' | 'warning' | 'neutral' }
> = {
  pending: { label: 'ждёт ответа', tone: 'info' },
  accepted: { label: 'принято', tone: 'success' },
  expired: { label: 'истекло', tone: 'warning' },
  revoked: { label: 'отозвано', tone: 'neutral' },
};

const USER_STATUS: Record<
  UserView['status'],
  { label: string; tone: 'success' | 'danger' | 'info' }
> = {
  active: { label: 'работает', tone: 'success' },
  disabled: { label: 'отключён', tone: 'danger' },
  invited: { label: 'ещё не входил', tone: 'info' },
};

/** «Роль — область» для назначения. */
function assignmentText(a: Assignment): string {
  return `${a.roleName} — ${a.tenantName ?? a.siteName ?? 'вся организация'}`;
}

/** Одноразовая ссылка, выданная администратору: приглашение или сброс пароля (Q-59). */
interface IssuedLink {
  readonly title: string;
  readonly ariaLabel: string;
  readonly link: string;
  readonly expiresAt: string;
  readonly lifetime: string;
}

/** Кнопка действия в таблице: нет права или нельзя сейчас — неактивна, причина в подсказке и для чтения с экрана. */
function RowAction({
  reason,
  onClick,
  icon,
  children,
  tone = 'outline',
  busy = false,
}: {
  reason?: string | undefined;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
  tone?: 'outline' | 'ghost';
  busy?: boolean;
}) {
  return (
    <Button
      variant={tone}
      size="sm"
      disabled={Boolean(reason) || busy}
      title={reason}
      onClick={onClick}
    >
      {icon}
      {children}
      {reason ? <span className="sr-only"> — недоступно: {reason}</span> : null}
    </Button>
  );
}

/** Ссылка показывается один раз: после «Закрыть» её нельзя вернуть, только выдать новую. */
function IssuedLinkPanel({ issued, onClose }: { issued: IssuedLink; onClose: () => void }) {
  const toast = useToast();
  const { site } = useSite();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector('input')?.focus();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.link);
      toast('Ссылка скопирована');
    } catch {
      toast('Не удалось скопировать — выделите ссылку в поле и скопируйте вручную', 'danger');
    }
  }

  return (
    <div ref={panel} className="mb-5">
      <Alert tone="warning" title={issued.title}>
        <p>
          Письмо не отправляется — передайте человеку ссылку сами. Она одноразовая, действует{' '}
          {issued.lifetime}
          {site ? (
            <>
              {' '}
              (до <SiteTime value={issued.expiresAt} />)
            </>
          ) : null}{' '}
          и показывается только сейчас: после закрытия вернуть её нельзя, можно выдать новую.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            readOnly
            aria-label={issued.ariaLabel}
            value={issued.link}
            className="min-w-0 flex-1 font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <Copy aria-hidden /> Копировать
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X aria-hidden /> Закрыть
          </Button>
        </div>
      </Alert>
    </div>
  );
}

// --- приглашение ---

interface InviteValues {
  email: string;
  phone: string;
  fullName: string;
  roleId: string;
  siteId: string;
  tenantId: string;
}

const INVITE_INITIAL: InviteValues = {
  email: '',
  phone: '',
  fullName: '',
  roleId: '',
  siteId: '',
  tenantId: '',
};

/** Пустая роль — понятное сообщение на русском, остальное проверяет схема из contracts. */
const INVITE_SCHEMA = z
  .looseObject({ roleId: z.string().min(1, 'Выберите роль') })
  .pipe(InvitationCreateSchema);

function inviteBody(v: InviteValues) {
  return {
    ...(v.email.trim() ? { email: v.email.trim() } : {}),
    ...(v.phone.trim() ? { phone: v.phone.trim() } : {}),
    ...(v.fullName.trim() ? { fullName: v.fullName.trim() } : {}),
    roleId: v.roleId,
    ...(v.siteId ? { siteId: v.siteId } : {}),
    ...(v.tenantId ? { tenantId: v.tenantId } : {}),
  };
}

function InviteSection({
  canInvite,
  onIssued,
}: {
  canInvite: boolean;
  onIssued: (issued: IssuedLink) => void;
}) {
  const mutate = useMutate();
  const toast = useToast();
  const roles = useApi<{ items: RoleView[] }>('/roles');
  const sites = useSites();
  const f = useCreateForm<InviteValues>({
    schema: INVITE_SCHEMA,
    initial: INVITE_INITIAL,
    toBody: inviteBody,
    onCreate: async (body) => {
      const res = await mutate<InvitationCreated>('/invitations', 'POST', body);
      onIssued({
        title: 'Приглашение создано',
        ariaLabel: 'Ссылка приглашения',
        link: res.link,
        expiresAt: res.invitation.expiresAt,
        lifetime: '7 дней',
      });
      toast('Приглашение создано');
    },
  });
  const { register, watch, setValue } = f.form;
  const siteId = watch('siteId');
  const roleId = watch('roleId');
  const tenants = useTenants(siteId || null);

  const roleItems = roles.data?.items ?? [];
  const chosenRole = roleItems.find((r) => r.id === roleId);
  const chosenScope = ROLE_TEMPLATES.find((t) => t.code === chosenRole?.templateCode)?.scope;

  return (
    <Section
      title="Пригласить человека"
      description="Укажите e-mail или телефон, роль и область. Человек получит одноразовую ссылку, задаст пароль и согласится на обработку персональных данных."
    >
      <fieldset disabled={!canInvite} className="m-0 min-w-0 border-0 p-0">
        {canInvite ? null : (
          <Alert tone="warning" className="mb-4">
            {NO_PEOPLE_RIGHT}.
          </Alert>
        )}
        <EditForm form={f} mode="create" submitLabel="Пригласить">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="E-mail"
              hint="Нужен e-mail или телефон — хотя бы одно"
              error={f.fieldError('email')}
            >
              <Input
                type="email"
                autoComplete="off"
                placeholder="name@example.ru"
                {...register('email')}
              />
            </Field>
            <Field label="Телефон" error={f.fieldError('phone')}>
              <Input
                type="tel"
                autoComplete="off"
                placeholder="+7 900 123-45-67"
                {...register('phone')}
              />
            </Field>
            <Field
              label="Фамилия и имя"
              hint="Не обязательно: человек поправит при принятии приглашения"
              error={f.fieldError('fullName')}
              className="md:col-span-2"
            >
              <Input autoComplete="off" {...register('fullName')} />
            </Field>
            <Field
              label="Роль"
              error={f.fieldError('roleId')}
              hint={
                chosenScope === 'tenant'
                  ? 'Роль арендатора: выберите объект и арендатора.'
                  : chosenScope === 'organization'
                    ? 'Эта роль обычно действует на всю организацию.'
                    : 'Роль не шире ваших прав в выбранной области.'
              }
            >
              <Select {...register('roleId')}>
                <option value="">{roles.isLoading ? 'Загрузка…' : '— выберите —'}</option>
                {roleItems.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Объект" hint="Пусто — вся организация" error={f.fieldError('siteId')}>
              <Select
                {...register('siteId', {
                  // другой объект — другой список арендаторов: выбранный прежде не подходит
                  onChange: () => setValue('tenantId', ''),
                })}
              >
                <option value="">Вся организация</option>
                {(sites.items ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Арендатор"
              hint="Нужен только для ролей арендатора"
              disabledReason={siteId ? undefined : 'Сначала выберите объект'}
              error={f.fieldError('tenantId')}
            >
              <Select {...register('tenantId')}>
                <option value="">
                  {tenants.isLoading && siteId ? 'Загрузка…' : '— не выбран —'}
                </option>
                {(tenants.items ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.shortName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </EditForm>
      </fieldset>
    </Section>
  );
}

// --- пользователи ---

function UsersSection({
  canManage,
  selfId,
  onIssued,
}: {
  canManage: boolean;
  selfId: string | undefined;
  onIssued: (issued: IssuedLink) => void;
}) {
  const users = useApi<{ items: UserView[] }>('/users');
  const mutate = useMutate();
  const toast = useToast();
  const [target, setTarget] = useState<{ user: UserView; action: 'disable' | 'enable' } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ErrorView | null>(null);

  async function resetPassword(user: UserView) {
    setBusyId(user.id);
    setFailure(null);
    try {
      const res = await mutate<{ link: string; expiresAt: string }>(
        `/users/${user.id}/password-reset`,
        'POST',
      );
      onIssued({
        title: `Ссылка для нового пароля: ${user.fullName}`,
        ariaLabel: 'Ссылка сброса пароля',
        link: res.link,
        expiresAt: res.expiresAt,
        lifetime: 'сутки',
      });
    } catch (e) {
      setFailure(errorView(e));
    } finally {
      setBusyId(null);
    }
  }

  const items = users.data?.items ?? [];
  return (
    <Section
      title="Пользователи"
      description="Кто работает в организации, с какими ролями и в какой области."
    >
      <ErrorAlert error={failure} className="mb-4" />
      {users.error ? (
        <LoadError error={users.error} retry={() => void users.refetch()} />
      ) : users.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <Empty
          title="Пользователей пока нет"
          hint="Пригласите первого человека формой выше — он появится здесь после принятия приглашения."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Имя</TH>
              <TH>Контакт</TH>
              <TH>Роли и области</TH>
              <TH>Статус</TH>
              <TH className="w-px" />
            </TR>
          </THead>
          <TBody>
            {items.map((u) => {
              const status = USER_STATUS[u.status];
              const isSelf = u.id === selfId;
              const reason = canManage ? undefined : NO_USER_RIGHT;
              return (
                <TR key={u.id}>
                  <TD className="font-medium">{u.fullName}</TD>
                  <TD>{u.email ?? u.phone ?? '—'}</TD>
                  <TD>
                    {u.assignments.length === 0 ? (
                      <span className="text-muted-foreground">ролей нет</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {u.assignments.map((a) => (
                          <li key={a.id}>{assignmentText(a)}</li>
                        ))}
                      </ul>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-2">
                      {u.status === 'disabled' ? (
                        <RowAction
                          reason={reason}
                          icon={<UserCheck aria-hidden />}
                          onClick={() => setTarget({ user: u, action: 'enable' })}
                        >
                          Включить
                        </RowAction>
                      ) : (
                        <RowAction
                          reason={
                            reason ?? (isSelf ? 'Свою учётную запись отключить нельзя' : undefined)
                          }
                          icon={<UserX aria-hidden />}
                          onClick={() => setTarget({ user: u, action: 'disable' })}
                        >
                          Отключить
                        </RowAction>
                      )}
                      <RowAction
                        reason={reason}
                        busy={busyId === u.id}
                        icon={<KeyRound aria-hidden />}
                        onClick={() => void resetPassword(u)}
                      >
                        Сбросить пароль
                      </RowAction>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      <ReasonDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={
          target?.action === 'enable'
            ? `Включить: ${target.user.fullName}?`
            : `Отключить: ${target?.user.fullName ?? ''}?`
        }
        description={
          target?.action === 'enable'
            ? 'Человек снова сможет войти со своим паролем.'
            : 'Все сессии человека завершатся сразу, войти он не сможет, пока вы его не включите.'
        }
        confirmLabel={target?.action === 'enable' ? 'Включить' : 'Отключить'}
        destructive={target?.action !== 'enable'}
        onConfirm={async (reason) => {
          if (!target) return;
          await mutate(`/users/${target.user.id}/${target.action}`, 'POST', { reason });
          toast(target.action === 'enable' ? 'Пользователь включён' : 'Пользователь отключён');
        }}
      />
    </Section>
  );
}

// --- приглашения ---

/** Область приглашения словами: названия берутся из уже загруженных списков. */
function InvitationArea({ invitation }: { invitation: InvitationView }) {
  const sites = useSites();
  const tenants = useTenants(invitation.siteId);
  if (!invitation.siteId) return <>вся организация</>;
  const site = sites.items?.find((s) => s.id === invitation.siteId);
  const tenant = tenants.items?.find((t) => t.id === invitation.tenantId);
  if (invitation.tenantId) return <>{tenant?.shortName ?? 'арендатор'}</>;
  return <>{site?.name ?? 'объект'}</>;
}

function InvitationsSection({
  canInvite,
  onIssued,
}: {
  canInvite: boolean;
  onIssued: (issued: IssuedLink) => void;
}) {
  const invitations = useApi<{ items: InvitationView[] }>('/invitations');
  const mutate = useMutate();
  const toast = useToast();
  const { site } = useSite();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ErrorView | null>(null);

  async function act(invitation: InvitationView, action: 'resend' | 'revoke') {
    setBusyId(invitation.id);
    setFailure(null);
    try {
      if (action === 'resend') {
        const res = await mutate<InvitationCreated>(`/invitations/${invitation.id}/resend`, 'POST');
        onIssued({
          title: `Новая ссылка приглашения: ${invitation.fullName ?? invitation.email ?? invitation.phone ?? ''}`,
          ariaLabel: 'Ссылка приглашения',
          link: res.link,
          expiresAt: res.invitation.expiresAt,
          lifetime: '7 дней',
        });
        toast('Ссылка выдана заново, прежняя перестала действовать');
      } else {
        await mutate(`/invitations/${invitation.id}/revoke`, 'POST');
        toast('Приглашение отозвано');
      }
    } catch (e) {
      setFailure(errorView(e));
    } finally {
      setBusyId(null);
    }
  }

  const items = invitations.data?.items ?? [];
  return (
    <Section
      title="Приглашения"
      description="Кого пригласили и что с приглашением. Ссылка действует 7 дней; «Отправить заново» выдаёт новую, прежняя перестаёт работать."
    >
      <ErrorAlert error={failure} className="mb-4" />
      {invitations.error ? (
        <LoadError error={invitations.error} retry={() => void invitations.refetch()} />
      ) : invitations.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <Empty
          title="Приглашений пока нет"
          hint="Заполните форму «Пригласить человека» — приглашение появится здесь со статусом «ждёт ответа»."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Кого пригласили</TH>
              <TH>Контакт</TH>
              <TH>Роль и область</TH>
              <TH>Статус</TH>
              <TH>Действует до</TH>
              <TH className="w-px" />
            </TR>
          </THead>
          <TBody>
            {items.map((i) => {
              const status = INVITATION_STATUS[i.status];
              const noRight = canInvite ? undefined : NO_PEOPLE_RIGHT;
              const resendReason =
                noRight ?? (i.status === 'accepted' ? 'Приглашение уже принято' : undefined);
              const revokeReason =
                noRight ??
                (i.status === 'accepted'
                  ? 'Приглашение уже принято — уберите роль у пользователя'
                  : i.status === 'revoked'
                    ? 'Приглашение уже отозвано'
                    : i.status === 'expired'
                      ? 'Срок приглашения истёк — ссылка уже не работает'
                      : undefined);
              return (
                <TR key={i.id}>
                  <TD className="font-medium">{i.fullName ?? '—'}</TD>
                  <TD>{i.email ?? i.phone ?? '—'}</TD>
                  <TD>
                    {i.roleName} — <InvitationArea invitation={i} />
                  </TD>
                  <TD>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </TD>
                  <TD>
                    {i.status === 'pending' && site ? (
                      <SiteTime value={i.expiresAt} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-2">
                      <RowAction
                        reason={resendReason}
                        busy={busyId === i.id}
                        icon={<RotateCw aria-hidden />}
                        onClick={() => void act(i, 'resend')}
                      >
                        Отправить заново
                      </RowAction>
                      <RowAction
                        reason={revokeReason}
                        busy={busyId === i.id}
                        icon={<X aria-hidden />}
                        onClick={() => void act(i, 'revoke')}
                      >
                        Отозвать
                      </RowAction>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Section>
  );
}

/**
 * Карточка «Пользователи» (шаг 9, страница `/admin/users`): приглашение с ролью и областью,
 * пользователи (отключить, включить, сбросить пароль) и приглашения (отправить заново, отозвать).
 * Ссылки приглашения и сброса пароля показываются один раз выдавшему администратору (Q-59).
 */
export function UsersCard() {
  const { can, me } = useMe();
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const canInvite = PEOPLE_RIGHTS.some((p) => can(p));
  return (
    <>
      <InviteSection canInvite={canInvite} onIssued={setIssued} />
      {issued ? (
        <IssuedLinkPanel key={issued.link} issued={issued} onClose={() => setIssued(null)} />
      ) : null}
      <UsersSection canManage={can('user.manage')} selfId={me?.id} onIssued={setIssued} />
      <InvitationsSection canInvite={canInvite} onIssued={setIssued} />
    </>
  );
}
