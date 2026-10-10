import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>Платформа пропускного режима</h1>
      <p>Каркас приложения: кабинет арендатора и админка появятся на следующих этапах.</p>
    </main>
  );
}
