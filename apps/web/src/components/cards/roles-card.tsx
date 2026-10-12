import {
  PERMISSIONS,
  type PermissionViewSchema,
  ROLE_TEMPLATES,
  type RoleScope,
  type RoleViewSchema,
} from '@oxrana/contracts';
import { Alert, Badge, Button, Section, Table, TBody, TD, TH, THead, TR } from '@oxrana/ui';
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { z } from 'zod';
import { useApi } from '../../lib/data';
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
 * Карточка «Роли»: только чтение. Список ролей организации с областью и правами; права раскрываются
 * по кнопке, с понятными подписями. Редактор ролей — этап 6б.
 */
export function RolesCard() {
  const roles = useApi<{ items: RoleView[] }>('/roles');
  const permissions = useApi<{ items: PermissionView[] }>('/permissions');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const labels = new Map((permissions.data?.items ?? []).map((p) => [p.code, p.label]));
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const items = roles.data?.items ?? [];
  return (
    <Section
      title="Роли"
      description="Роль — набор прав. Человеку роль назначают в области: вся организация, объект или арендатор; учётка КПП получает роль «Пост КПП» сама."
    >
      <Alert tone="info" className="mb-4">
        Здесь роли только для просмотра. Создание ролей и правка прав появятся на следующем этапе
        (6б); пока приглашайте людей с готовыми ролями.
      </Alert>
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
              <TH className="w-40" />
            </TR>
          </THead>
          <TBody>
            {items.map((role) => {
              const expanded = open.has(role.id);
              const panelId = `role-permissions-${role.id}`;
              return (
                <Fragment key={role.id}>
                  <TR>
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
                    </TD>
                    <TD>
                      <div className="flex justify-end">
                        {role.permissions.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            Права не выданы — роль ничего не разрешает
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={expanded}
                            aria-controls={panelId}
                            onClick={() => toggle(role.id)}
                          >
                            {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                            {expanded ? 'Скрыть права' : 'Показать права'}
                            <span className="sr-only">: {role.name}</span>
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                  {expanded ? (
                    <TR id={panelId} className="bg-muted/30 hover:bg-muted/30">
                      <TD colSpan={4}>
                        <ul className="grid gap-x-6 gap-y-1.5 py-1 sm:grid-cols-2">
                          {role.permissions.map((code) => (
                            <li key={code} className="flex items-start gap-2 text-sm">
                              <ShieldCheck
                                aria-hidden
                                className="mt-0.5 size-4 shrink-0 text-success"
                              />
                              <span>
                                {labels.get(code) ?? code}
                                <code className="ml-2 text-xs text-muted-foreground">{code}</code>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </TD>
                    </TR>
                  ) : null}
                </Fragment>
              );
            })}
          </TBody>
        </Table>
      )}
    </Section>
  );
}

/** Шаг мастера «Люди»: приглашения и пользователи, ниже — роли только для просмотра. */
export function PeopleCard() {
  return (
    <>
      <UsersCard />
      <RolesCard />
    </>
  );
}
