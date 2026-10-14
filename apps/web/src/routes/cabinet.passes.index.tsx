import { PASS_STATUSES, type PassStatus } from '@oxrana/contracts';
import { Button, PageHeader } from '@oxrana/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { PassList } from '../components/cabinet/pass-list';
import { RepeatDay } from '../components/cabinet/repeat-day';
import { useMe } from '../lib/data';

export const Route = createFileRoute('/cabinet/passes/')({
  validateSearch: (search: Record<string, unknown>): { status?: PassStatus; pass?: string } => ({
    ...(typeof search.status === 'string' &&
    (PASS_STATUSES as readonly string[]).includes(search.status)
      ? { status: search.status as PassStatus }
      : {}),
    // пропуск, который открыло уведомление (колокольчик)
    ...(typeof search.pass === 'string' ? { pass: search.pass } : {}),
  }),
  component: PassesPage,
});

const CREATE = ['pass.create.single', 'pass.create.multi', 'pass.create.permanent'] as const;

function PassesPage() {
  const { status, pass } = Route.useSearch();
  const { can } = useMe();
  const canCreate = CREATE.some((p) => can(p));
  return (
    <div>
      <PageHeader
        title="Пропуска"
        actions={
          canCreate ? (
            <>
              <RepeatDay />
              <Button asChild>
                <Link to="/cabinet/passes/new">
                  <Plus aria-hidden /> Пропуск
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />
      <PassList key={status ?? 'all'} initialStatus={status} openId={pass} />
    </div>
  );
}
