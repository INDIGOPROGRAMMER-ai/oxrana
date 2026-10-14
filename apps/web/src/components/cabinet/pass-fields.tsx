import type { CabinetContext, PassView } from '@oxrana/contracts';
import { SiteTime } from '@oxrana/ui';
import type { ReactNode } from 'react';
import { PASS_TYPE_LABEL } from '../../lib/pass-text';

const name = (list: readonly { id: string; name: string }[] | undefined, id: string | null) =>
  id ? (list?.find((x) => x.id === id)?.name ?? '—') : null;

/**
 * Все поля пропуска списком «название — значение» (карточка пропуска в кабинете и карточка
 * согласования в админке): пустые поля не показываются, время — в поясе объекта с подписью.
 */
export function PassFields({ pass, ctx }: { pass: PassView; ctx: CabinetContext | undefined }) {
  const rows: [string, ReactNode][] = [
    ['Вид пропуска', PASS_TYPE_LABEL[pass.passType]],
    ...(pass.participant === 'vehicle'
      ? ([
          ['Тип транспорта', name(ctx?.categories, pass.categoryId)],
          ['Марка', pass.brand],
          ['Водитель', [pass.driverName, pass.driverPhone].filter(Boolean).join(', ') || null],
        ] as [string, ReactNode][])
      : ([['Документ', pass.personDocument]] as [string, ReactNode][])),
    ['Действует с', <SiteTime key="f" value={pass.validFrom} />],
    ['Действует по', pass.validTo ? <SiteTime key="t" value={pass.validTo} /> : 'без окончания'],
    ...(pass.windowFrom
      ? ([
          ['Окно прибытия, с', <SiteTime key="wf" value={pass.windowFrom} />],
          ['Окно прибытия, по', <SiteTime key="wt" value={pass.windowTo} />],
        ] as [string, ReactNode][])
      : []),
    [
      'Док',
      pass.dockId ? `Док ${ctx?.docks.find((d) => d.id === pass.dockId)?.number ?? '—'}` : null,
    ],
    ['Место назначения', name(ctx?.zones, pass.destinationZoneId)],
    ['Цель визита', name(ctx?.purposes, pass.purposeId)],
    ['Комментарий', pass.comment],
  ];
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows
        .filter(([, v]) => v !== null && v !== '' && v !== undefined)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}
