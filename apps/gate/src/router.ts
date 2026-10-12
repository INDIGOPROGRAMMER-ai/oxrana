import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/** Путь, под которым собрано приложение (`GATE_BASE` при сборке): `/` или, например, `/gate/`. */
const basepath = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

/** Маршрутизатор приложения. `history` подменяется в тестах (memory history). */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, basepath, ...(history ? { history } : {}) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
