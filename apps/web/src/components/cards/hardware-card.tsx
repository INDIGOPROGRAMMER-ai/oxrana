import { Badge, Section, Table, TBody, TD, TH, THead, TR } from '@oxrana/ui';
import { type HardwareDeviceView, useHardwareDevices } from '../../lib/data';
import { Empty, LoadError, RequireSite } from '../common';

const KIND_LABEL: Record<HardwareDeviceView['kind'], string> = {
  lpr_camera: 'камера номеров',
  barrier: 'шлагбаум',
  qr_scanner: 'QR-сканер',
  acs_controller: 'СКУД',
  post_pc: 'компьютер поста',
};
const STATUS: Record<
  HardwareDeviceView['status'],
  { text: string; tone: 'success' | 'danger' | 'neutral' }
> = {
  online: { text: 'на связи', tone: 'success' },
  offline: { text: 'нет связи', tone: 'danger' },
  unknown: { text: 'неизвестно', tone: 'neutral' },
};

/**
 * Реестр оборудования КПП (ADR-008): камеры номеров, шлагбаумы, QR-сканеры, СКУД. В MVP реестр
 * пуст — оборудование подключается только через агент КПП (этап 14); ядро и пост марок не знают.
 */
export function HardwareCard() {
  return <RequireSite>{(site) => <Body siteId={site.id} />}</RequireSite>;
}

function Body({ siteId }: { siteId: string }) {
  const devices = useHardwareDevices(siteId);
  if (devices.error)
    return <LoadError error={devices.error} retry={() => void devices.refetch()} />;
  const items = devices.items ?? [];
  return (
    <Section title="Оборудование КПП" description="Камеры номеров, шлагбаумы, сканеры и СКУД.">
      {devices.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка…
        </p>
      ) : items.length === 0 ? (
        <Empty
          title="Оборудования пока нет"
          hint={
            <>
              Оборудование подключается через <strong>агент КПП</strong> — небольшую программу на
              компьютере у ворот, которая связывает устройства с системой (ADR-008). Агент появится
              на следующих этапах; сейчас пост работает без камер и шлагбаумов: охранник сам
              нажимает «Впустить», а шлагбаум открывает вручную. Когда агент будет подключён,
              устройства появятся здесь со статусом «на связи / нет связи» и кнопкой «Проверить».
            </>
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Устройство</TH>
              <TH>КПП</TH>
              <TH>Вид</TH>
              <TH>Статус</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((d) => (
              <TR key={d.id}>
                <TD className="font-medium">{d.name}</TD>
                <TD>{d.gateName}</TD>
                <TD>{KIND_LABEL[d.kind] ?? d.kind}</TD>
                <TD>
                  <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].text}</Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Section>
  );
}
