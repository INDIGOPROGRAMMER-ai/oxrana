import type { CabinetContext, PassCardSchema, PassView } from '@oxrana/contracts';
import { SiteTime } from '@oxrana/ui';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { PASS_TYPE_LABEL } from '../../lib/pass-text';

const name = (list: readonly { id: string; name: string }[] | undefined, id: string | null) =>
  id ? (list?.find((x) => x.id === id)?.name ?? '—') : null;

/**
 * Все поля пропуска списком «название — значение» (карточка пропуска в кабинете и карточка
 * согласования в админке): пустые поля не показываются, время — в поясе объекта с подписью.
 */
export function PassFields({
  pass,
  ctx,
  names,
}: {
  pass: PassView;
  ctx: CabinetContext | undefined;
  /** Названия по ссылкам от сервера (карточка пропуска): без них — по справочникам контекста. */
  names?: z.infer<typeof PassCardSchema>['names'];
}) {
  const rows: [string, ReactNode][] = [
    ['Вид пропуска', PASS_TYPE_LABEL[pass.passType]],
    ...(pass.participant === 'vehicle'
      ? ([
          ['Тип транспорта', names ? names.category : name(ctx?.categories, pass.categoryId)],
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
      names
        ? names.dock
        : pass.dockId
          ? `Док ${ctx?.docks.find((d) => d.id === pass.dockId)?.number ?? '—'}`
          : null,
    ],
    ['Место назначения', names ? names.zone : name(ctx?.zones, pass.destinationZoneId)],
    ['Цель визита', names ? names.purpose : name(ctx?.purposes, pass.purposeId)],
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
