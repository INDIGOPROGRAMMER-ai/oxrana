import { type SandboxCheck, SandboxCheckSchema } from '@oxrana/contracts';
import { PageHeader } from '@oxrana/ui';
import { createFileRoute } from '@tanstack/react-router';
import { SandboxCard } from '../components/cards/sandbox-card';

/** Запрос из примера мастера приходит в адресе: `?req=<JSON>`; битый — просто пустая форма. */
function parseRequest(value: unknown): SandboxCheck | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = SandboxCheckSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute('/admin/sandbox')({
  validateSearch: (search: Record<string, unknown>): { req?: string } =>
    typeof search.req === 'string' ? { req: search.req } : {},
  component: SandboxPage,
});

function SandboxPage() {
  const { req } = Route.useSearch();
  const initial = parseRequest(req);
  return (
    <>
      <PageHeader
        title="Песочница правил"
        description="Проверьте, что скажет система охраннику, не трогая настоящие данные. Тот же движок, что на посту."
      />
      <SandboxCard key={req ?? 'empty'} initial={initial} />
    </>
  );
}
