import type {
  EnrollmentCreatedSchema,
  GateAccountViewSchema,
  GateDeviceViewSchema,
} from '@oxrana/contracts';
import {
  Alert,
  Badge,
  Button,
  ErrorAlert,
  type ErrorView,
  errorView,
  Section,
  SiteTime,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@oxrana/ui';
import { Link } from '@tanstack/react-router';
import { DoorOpen, Loader2, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { renderSVG } from 'uqr';
import type { z } from 'zod';
import { useApi, useGates, useMutate } from '../../lib/data';
import { Empty, LoadError, RequireSite } from '../common';
import { ReasonDialog } from '../reason-dialog';

type GateAccountView = z.infer<typeof GateAccountViewSchema>;
type GateDeviceView = z.infer<typeof GateDeviceViewSchema>;
type EnrollmentCreated = z.infer<typeof EnrollmentCreatedSchema>;

/** Код привязки, показанный администратору: один раз, пока он не нажмёт «Готово». */
interface Enrollment {
  readonly gateName: string;
  readonly data: EnrollmentCreated;
}

/**
 * Карточка «Устройства КПП» (шаг 10, `/admin/devices`): у каждого КПП своя учётка поста, у неё —
 * привязанные устройства. «Привязать устройство» даёт код и QR на 10 минут; «Отозвать» действует
 * сразу и требует причину. Объект — выбранный в шапке админки.
 */
export function DevicesCard() {
  return <RequireSite>{(site) => <DevicesBody siteId={site.id} />}</RequireSite>;
}

function DevicesBody({ siteId }: { siteId: string }) {
  const gates = useGates(siteId);
  const accounts = useApi<{ items: GateAccountView[] }>(`/sites/${siteId}/gate-accounts`);
  const mutate = useMutate();
  const toast = useToast();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const [failure, setFailure] = useState<ErrorView | null>(null);
  const [revoking, setRevoking] = useState<GateDeviceView | null>(null);

  async function enroll(account: GateAccountView) {
    setEnrolling(account.id);
    setFailure(null);
    try {
      const data = await mutate<EnrollmentCreated>(
        `/gate-accounts/${account.id}/enrollments`,
        'POST',
        {},
      );
      setEnrollment({ gateName: account.gateName, data });
    } catch (e) {
      setFailure(errorView(e));
    } finally {
      setEnrolling(null);
    }
  }

  if (accounts.error) {
    return <LoadError error={accounts.error} retry={() => void accounts.refetch()} />;
  }
  if (accounts.isLoading || gates.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Загрузка…
      </p>
    );
  }
  const items = accounts.data?.items ?? [];
  if (items.length === 0) {
    const noGates = (gates.items?.length ?? 0) === 0;
    return (
      <Section
        title="Устройства КПП"
        description="Устройство поста привязывается к учётке КПП — одной на каждый КПП, без личных PIN."
      >
        <Empty
          title={noGates ? 'Сначала добавьте КПП' : 'У КПП объекта нет учёток поста'}
          hint={
            noGates
              ? 'Учётка поста создаётся вместе с КПП, а устройства привязываются уже к ней.'
              : 'Учётка поста создаётся вместе с КПП. Если её нет, пересоздайте КПП или сообщите администратору платформы.'
          }
          action={
            <Button asChild>
              <Link to="/admin/gates">
                <DoorOpen aria-hidden /> Перейти к КПП
              </Link>
            </Button>
          }
        />
      </Section>
    );
  }

  return (
    <>
      <ErrorAlert error={failure} className="mb-4" />
      {enrollment ? (
        <EnrollmentPanel enrollment={enrollment} onDone={() => setEnrollment(null)} />
      ) : null}
      {items.map((account) => {
        const disabled = account.status !== 'active';
        return (
          <Section
            key={account.id}
            title={account.gateName}
            description={
              disabled
                ? 'Учётка КПП отключена — привязать новое устройство нельзя.'
                : `Учётка поста с ролью «${account.roleName}». Код привязки одноразовый, действует 10 минут.`
            }
            actions={
              <Button
                size="sm"
                disabled={disabled || enrolling === account.id}
                title={disabled ? 'Учётка КПП отключена' : undefined}
                onClick={() => void enroll(account)}
              >
                {enrolling === account.id ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <Smartphone aria-hidden />
                )}
                Привязать устройство
              </Button>
            }
          >
            {account.devices.length === 0 ? (
              <Empty
                title="Устройств пока нет"
                hint="Нажмите «Привязать устройство», введите код на компьютере или планшете поста или отсканируйте QR."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Устройство</TH>
                    <TH>Привязано</TH>
                    <TH>На связи</TH>
                    <TH>Статус</TH>
                    <TH className="w-px" />
                  </TR>
                </THead>
                <TBody>
                  {account.devices.map((d) => (
                    <TR key={d.id}>
                      <TD className="font-medium">{d.name}</TD>
                      <TD>
                        <SiteTime value={d.enrolledAt} />
                      </TD>
                      <TD>
                        {d.lastSeenAt ? (
                          <SiteTime value={d.lastSeenAt} />
                        ) : (
                          <span className="text-muted-foreground">ещё не выходило на связь</span>
                        )}
                      </TD>
                      <TD>
                        {d.revokedAt ? (
                          <div className="flex flex-col items-start gap-1">
                            <Badge tone="danger">{`отозвано: ${d.revokeReason ?? 'причина не указана'}`}</Badge>
                            <span className="text-xs text-muted-foreground">
                              <SiteTime value={d.revokedAt} />
                            </span>
                          </div>
                        ) : (
                          <Badge tone="success">работает</Badge>
                        )}
                      </TD>
                      <TD>
                        <div className="flex justify-end">
                          {d.revokedAt ? null : (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Отозвать устройство «${d.name}»`}
                              onClick={() => setRevoking(d)}
                            >
                              Отозвать
                            </Button>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Section>
        );
      })}

      <ReasonDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Отозвать устройство «${revoking?.name ?? ''}»?`}
        description="Устройство сразу потеряет доступ: пост на нём вернётся на экран привязки. Вернуть устройство можно только новой привязкой."
        confirmLabel="Отозвать"
        destructive
        onConfirm={async (reason) => {
          if (!revoking) return;
          await mutate(`/gate-devices/${revoking.id}/revoke`, 'POST', { reason });
          toast('Устройство отозвано');
        }}
      />
    </>
  );
}

function EnrollmentPanel({ enrollment, onDone }: { enrollment: Enrollment; onDone: () => void }) {
  const { data } = enrollment;
  return (
    <Alert tone="info" title={`Привязка устройства: ${enrollment.gateName}`} className="mb-5">
      <div className="space-y-3">
        <p>
          На устройстве поста откройте приложение поста и введите код или отсканируйте QR. Код
          одноразовый, действует до <SiteTime value={data.expiresAt} />; после «Готово» его не
          показать снова.
        </p>
        <p
          data-testid="enrollment-code"
          className="font-mono text-3xl font-semibold tracking-widest"
        >
          {data.code}
        </p>
        <div
          className="qr w-44 rounded-md bg-white p-2 [&_svg]:h-auto [&_svg]:w-full"
          // SVG строит uqr из адреса привязки локально; внешних данных в нём нет.
          dangerouslySetInnerHTML={{ __html: renderSVG(data.enrollUrl) }}
        />
        <p className="break-all text-sm">
          <a
            href={data.enrollUrl}
            data-testid="enrollment-link"
            className="text-primary underline-offset-4 hover:underline"
          >
            {data.enrollUrl}
          </a>
        </p>
        <Button onClick={onDone}>Готово</Button>
      </div>
    </Alert>
  );
}
