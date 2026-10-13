import { Alert, Button, PageHeader } from '@oxrana/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ListChecks, Plus, Table2, Truck } from 'lucide-react';
import { useCabinet } from '../components/cabinet/cabinet-context';
import { LimitWidgets, TodaySummary } from '../components/cabinet/limit-widgets';
import { LoadError } from '../components/common';
import { useMe } from '../lib/data';

export const Route = createFileRoute('/cabinet/')({
  component: CabinetHome,
});

const CREATE = ['pass.create.single', 'pass.create.multi', 'pass.create.permanent'] as const;

function CabinetHome() {
  const { can } = useMe();
  const { ctx, error, loading } = useCabinet();
  const canCreate = CREATE.some((p) => can(p));
  if (error) return <LoadError error={error} retry={() => window.location.reload()} />;
  const blocked = ctx && ctx.tenant.status !== 'active' && ctx.tenant.status !== 'blocked_entry';
  return (
    <div className="space-y-6">
      <PageHeader title="Главная" />
      {blocked ? (
        <Alert tone="danger" title="Новые пропуска сейчас оформить нельзя">
          Администратор объекта ограничил работу вашей компании. Обратитесь к нему, чтобы уточнить
          причину.
        </Alert>
      ) : null}
      {ctx?.tenant.status === 'blocked_entry' ? (
        <Alert tone="warning" title="Въезд вашей компании запрещён администратором объекта">
          Пропуска можно оформлять, но машины не пропустят, пока запрет не снимут.
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canCreate ? (
          <>
            <Button asChild size="lg">
              <Link to="/cabinet/passes/new">
                <Plus aria-hidden /> Пропуск
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/cabinet/passes/batch">
                <Plus aria-hidden /> Несколько
              </Link>
            </Button>
          </>
        ) : null}
        {can('pass.view') ? (
          <>
            <Button asChild size="lg" variant="outline">
              <Link to="/cabinet/fleet">
                <Truck aria-hidden /> Автопарк
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/cabinet/passes">
                <ListChecks aria-hidden /> Пропуска
              </Link>
            </Button>
          </>
        ) : null}
        {!canCreate && !can('pass.view') ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Table2 aria-hidden className="size-4" /> У вашей роли нет прав на пропуска — обратитесь
            к ответственному вашей компании.
          </p>
        ) : null}
      </div>
      {loading ? null : <LimitWidgets />}
      {can('pass.view') ? <TodaySummary /> : null}
    </div>
  );
}
