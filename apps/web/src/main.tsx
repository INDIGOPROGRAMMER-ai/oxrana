import { ThemeProvider, ToastProvider, UiProvider } from '@oxrana/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterLink } from './lib/router-link';
import { createAppRouter } from './router';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('В index.html нет элемента #root');

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 } },
});
const router = createAppRouter();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <UiProvider link={RouterLink}>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </UiProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
