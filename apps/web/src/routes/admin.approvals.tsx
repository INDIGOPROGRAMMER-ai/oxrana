import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { ApprovalsView } from '../components/approvals/approvals-view';
import { RequireSite } from '../components/common';

export const Route = createFileRoute('/admin/approvals')({
  component: () => (
    <>
      <PageHeader
        title="Согласование"
        description="Заявки на пропуска, которые ждут решения: одобрить, отклонить с причиной или одобрить с изменениями."
      />
      <RequireSite>{() => <ApprovalsView />}</RequireSite>
    </>
  ),
});
