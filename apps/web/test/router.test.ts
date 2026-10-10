import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { createAppRouter } from '../src/router';

describe('маршрутизатор', () => {
  it('главная страница находит маршрут «/»', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));
    await router.load();
    expect(router.state.matches.map((m) => m.routeId)).toContain('/');
  });

  it('неизвестный адрес не находит ни одного прикладного маршрута', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/no-such-page'] }));
    await router.load();
    expect(router.state.matches.map((m) => m.routeId)).not.toContain('/');
  });
});
