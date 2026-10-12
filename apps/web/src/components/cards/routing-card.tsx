import {
  Alert,
  Button,
  Section,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@oxrana/ui';
import { useState } from 'react';
import {
  type GateView,
  type RoutingRuleView,
  useCategories,
  useGates,
  useMutate,
  useRoutingRules,
  useZones,
} from '../../lib/data';
import { Empty, GuardPreview, LoadError, RequireSite } from '../common';

interface RowSpec {
  key: string;
  label: string;
  participant: 'vehicle' | 'pedestrian';
  categoryId: string | null;
  destinationZoneId: string | null;
}

/**
 * Карточка «Маршруты» (шаг 4): матрица «тип × КПП» и строки для пешеходов. Маршрут — отдельное
 * правило, не связанное с лимитами и местом назначения (CLAUDE.md п. 2). Если для типа ничего не
 * отмечено, машина пройдёт через любой КПП, который её пропускает (RULES_ENGINE §9).
 */
export function RoutingCard() {
  return <RequireSite>{(site) => <RoutingBody siteId={site.id} />}</RequireSite>;
}

function RoutingBody({ siteId }: { siteId: string }) {
  const gates = useGates(siteId);
  const categories = useCategories(siteId, false);
  const rules = useRoutingRules(siteId);
  const zones = useZones(siteId);
  const mutate = useMutate();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  // отметка меняется сразу, не дожидаясь ответа; при ошибке возвращается
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [extraZones, setExtraZones] = useState<string[]>([]);
  const [pickZone, setPickZone] = useState('');

  const failed = gates.error ?? categories.error ?? rules.error ?? zones.error;
  if (failed) return <LoadError error={failed} retry={() => void rules.refetch()} />;
  if (gates.isLoading || categories.isLoading || rules.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Загрузка…
      </p>
    );
  }

  const allGates = [...(gates.items ?? [])].sort((a, b) => a.sort - b.sort);
  const cats = categories.items ?? [];
  const siteRules = (rules.items ?? []).filter((r) => r.tenantId === null);
  const tenantRules = (rules.items ?? []).filter((r) => r.tenantId !== null);

  if (allGates.length === 0 || cats.length === 0) {
    return (
      <Empty
        title="Нечего связывать"
        hint={
          allGates.length === 0
            ? 'Сначала добавьте КПП (шаг 2).'
            : 'Сначала включите типы транспорта (шаг 3).'
        }
      />
    );
  }

  const findRule = (row: RowSpec, gateId: string): RoutingRuleView | undefined =>
    siteRules.find(
      (r) =>
        r.participant === row.participant &&
        r.categoryId === row.categoryId &&
        r.destinationZoneId === row.destinationZoneId &&
        r.gateId === gateId &&
        r.direction !== 'out',
    );

  async function toggle(row: RowSpec, gate: GateView) {
    const key = `${row.key}:${gate.id}`;
    setPending(key);
    setError(null);
    const existing = findRule(row, gate.id);
    setShown((m) => ({ ...m, [key]: !existing }));
    try {
      if (existing) {
        await mutate(`/routing-rules/${existing.id}?confirm=false`, 'DELETE');
      } else {
        await mutate(`/sites/${siteId}/routing-rules`, 'POST', {
          participant: row.participant,
          categoryId: row.categoryId,
          destinationZoneId: row.destinationZoneId,
          gateId: gate.id,
          direction: 'in',
        });
      }
      toast(existing ? 'Маршрут убран' : 'Маршрут добавлен');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить маршрут');
    } finally {
      setPending(null);
      setShown((m) => {
        const { [key]: _done, ...rest } = m;
        return rest;
      });
    }
  }

  const vehicleRows: RowSpec[] = cats.map((c) => ({
    key: `v-${c.id}`,
    label: c.name,
    participant: 'vehicle',
    categoryId: c.id,
    destinationZoneId: null,
  }));
  const zoneList = zones.items ?? [];
  const zoneIdsWithRules = new Set(
    siteRules
      .filter((r) => r.participant === 'pedestrian' && r.destinationZoneId)
      .map((r) => r.destinationZoneId as string),
  );
  const pedZoneIds = [...new Set([...zoneIdsWithRules, ...extraZones])];
  const pedestrianRows: RowSpec[] = [
    {
      key: 'p-any',
      label: 'Пешеход',
      participant: 'pedestrian',
      categoryId: null,
      destinationZoneId: null,
    },
    ...pedZoneIds.map((zoneId) => ({
      key: `p-${zoneId}`,
      label: `Пешеход → ${zoneList.find((z) => z.id === zoneId)?.name ?? 'зона'}`,
      participant: 'pedestrian' as const,
      categoryId: null,
      destinationZoneId: zoneId,
    })),
  ];

  const renderRow = (row: RowSpec) => (
    <TR key={row.key}>
      <TD className="font-medium">{row.label}</TD>
      {allGates.map((gate) => {
        const admitted =
          row.participant === 'vehicle'
            ? gate.admits !== 'pedestrians'
            : gate.admits !== 'vehicles';
        const reason = admitted
          ? undefined
          : row.participant === 'vehicle'
            ? `КПП «${gate.name}» пропускает только пешеходов`
            : `КПП «${gate.name}» пропускает только машины`;
        const checked = shown[`${row.key}:${gate.id}`] ?? findRule(row, gate.id) !== undefined;
        return (
          <TD key={gate.id} className="text-center">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)] disabled:cursor-not-allowed"
              aria-label={`${row.label} → ${gate.name}`}
              title={reason}
              checked={checked}
              disabled={!admitted || pending !== null}
              onChange={() => void toggle(row, gate)}
            />
          </TD>
        );
      })}
    </TR>
  );

  const head = (
    <THead>
      <TR>
        <TH>Кто</TH>
        {allGates.map((g) => (
          <TH key={g.id} className="text-center">
            {g.name}
          </TH>
        ))}
      </TR>
    </THead>
  );

  const unusedZones = zoneList.filter((z) => !pedZoneIds.includes(z.id));
  const assigned = (row: RowSpec) =>
    allGates.filter((g) => findRule(row, g.id) !== undefined).map((g) => g.name);

  return (
    <>
      <Section
        title="Машины: тип × КПП"
        description="Отметьте, через какие КПП может въезжать каждый тип. Если для типа не отмечено ничего — он проедет через любой КПП, который пропускает машины. Выезд — через любой КПП."
      >
        <Table>
          {head}
          <TBody>{vehicleRows.map(renderRow)}</TBody>
        </Table>
        {error ? (
          <Alert tone="danger" className="mt-3">
            {error}
          </Alert>
        ) : null}
      </Section>

      <Section
        title="Пешеходы"
        description="Если маршруты пешеходов не заданы, пешеход проходит через любой КПП, который пропускает пешеходов. Строка с местом назначения направляет, например, посетителей офиса на пост в здании."
      >
        <Table>
          {head}
          <TBody>{pedestrianRows.map(renderRow)}</TBody>
        </Table>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="ped-zone" className="text-sm">
            Пешеходы, идущие в…
          </label>
          <Select
            id="ped-zone"
            className="w-56"
            value={pickZone}
            disabled={unusedZones.length === 0}
            title={
              unusedZones.length === 0
                ? 'Нет зон без отдельной строки. Зоны добавляются в «Доки и зоны»'
                : undefined
            }
            onChange={(e) => setPickZone(e.target.value)}
          >
            <option value="">— выберите зону —</option>
            {unusedZones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={!pickZone}
            onClick={() => {
              setExtraZones((list) => [...list, pickZone]);
              setPickZone('');
            }}
          >
            Добавить строку
          </Button>
        </div>
      </Section>

      {tenantRules.length > 0 ? (
        <Alert tone="info">
          У арендаторов заведено собственных маршрутов: {tenantRules.length}. Они приоритетнее общей
          матрицы; редактор маршрутов арендатора появится позже.
        </Alert>
      ) : null}

      <GuardPreview title="Подсказки в форме пропуска и на посту">
        <ul className="list-disc space-y-0.5 pl-5">
          {vehicleRows.map((row) => {
            const names = assigned(row);
            return (
              <li key={row.key}>
                {row.label} →{' '}
                {names.length > 0 ? (
                  <strong>{names.join(', ')}</strong>
                ) : (
                  <span className="text-muted-foreground">любой КПП для машин</span>
                )}
                {names.length > 0 ? ` (на другом КПП: «не тот КПП, направьте на ${names[0]}»)` : ''}
              </li>
            );
          })}
        </ul>
      </GuardPreview>
    </>
  );
}
