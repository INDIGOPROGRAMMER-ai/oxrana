import { PageHeader, Skeleton } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useCabinet } from '../components/cabinet/cabinet-context';
import { PassBatch } from '../components/cabinet/pass-batch';

export const Route = createFileRoute('/cabinet/passes/batch')({
  component: BatchPage,
});

function BatchPage() {
  const { ctx } = useCabinet();
  return (
    <div>
      <PageHeader
        title="Несколько пропусков"
        description="Вставьте таблицу из Excel или письма — перед созданием вы увидите, какие строки пройдут, а какие нет и почему."
      />
      {ctx ? (
        // ключ — компания: при переключении компании вставленное не уходит чужому арендатору
        <PassBatch key={ctx.tenant.id} />
      ) : (
        <div role="status" aria-label="Загрузка" className="space-y-3">
          <Skeleton className="h-32 w-full" />
        </div>
      )}
    </div>
  );
}
