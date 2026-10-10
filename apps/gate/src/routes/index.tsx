import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>Пост охраны</h1>
      <p>Каркас приложения: экран поста появится на этапе 6.</p>
    </main>
  );
}
