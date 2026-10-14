import type { PassView } from '@oxrana/contracts';
import { Badge } from '@oxrana/ui';
import { statusView } from '../../lib/pass-text';
import { useCabinet } from './cabinet-context';

/** Статус пропуска и пояснения под ним: причина отказа, что изменил согласующий. */
export function PassStatus({ pass }: { pass: PassView }) {
  const { ctx, serverNow } = useCabinet();
  if (!ctx) return null;
  const view = statusView(pass, ctx, serverNow());
  return (
    <div className="flex flex-col items-start gap-1" data-testid="pass-status">
      <Badge tone={view.tone}>{view.label}</Badge>
      {view.details.map((line) => (
        <span key={line} className="text-xs text-muted-foreground" data-testid="pass-status-detail">
          {line}
        </span>
      ))}
    </div>
  );
}
