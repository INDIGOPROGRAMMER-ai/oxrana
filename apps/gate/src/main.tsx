import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppRouter } from './router';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('В index.html нет элемента #root');

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={createAppRouter()} />
  </StrictMode>,
);
