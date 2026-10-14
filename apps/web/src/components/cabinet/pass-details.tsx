import type { PassHistoryEntrySchema, PassView } from '@oxrana/contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SiteTime,
  Skeleton,
} from '@oxrana/ui';
import type { z } from 'zod';
import { useApi } from '../../lib/data';
import { passTitle } from '../../lib/pass-text';
import { useCabinet } from './cabinet-context';
import { PassFields } from './pass-fields';
import { PassStatus } from './status-badge';

type HistoryEntry = z.infer<typeof PassHistoryEntrySchema>;

const ACTION: Record<string, string> = {
  create: 'Оформлен',
  update: 'Изменён',
  approve: 'Одобрен',
  reject: 'Отклонён',
  cancel: 'Отменён',
  approval_escalated: 'Передан дальше: не рассмотрен вовремя',
  check_in: 'Въезд',
  check_out: 'Выезд',
};

/** Карточка пропуска: все поля, статус согласования и история «кто и когда». */
export function PassDetails({ pass, onClose }: { pass: PassView | null; onClose: () => void }) {
  const { ctx } = useCabinet();
  const history = useApi<{ items: HistoryEntry[] }>(pass ? `/passes/${pass.id}/history` : null);
  return (
    <Dialog open={pass !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {pass ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono">{passTitle(pass)}</DialogTitle>
              <DialogDescription>Подробности пропуска и история изменений.</DialogDescription>
            </DialogHeader>
            <PassStatus pass={pass} />
            <PassFields pass={pass} ctx={ctx} />
            <section aria-label="История" className="space-y-1">
              <h3 className="text-sm font-medium">История</h3>
              {history.isLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <ul className="space-y-1 text-sm">
                  {(history.data?.items ?? []).map((h) => (
                    <li key={`${h.at}-${h.action}`} className="text-muted-foreground">
                      <SiteTime value={h.at} /> · {ACTION[h.action] ?? h.action}
                      {h.actorName ? `, ${h.actorName}` : ''}
                      {h.reason ? ` — ${h.reason}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
