import type { BatchResult } from '@oxrana/contracts';
import { api, type ErrorView, errorView } from '@oxrana/ui';
import { useEffect, useRef, useState } from 'react';

export type PreviewStatus = 'idle' | 'checking' | 'ready' | 'failed';

export interface AutoPreview<R = BatchResult> {
  readonly status: PreviewStatus;
  /** Ответ сервера на проверку без сохранения (`dryRun`). */
  readonly result: R | null;
  readonly error: ErrorView | null;
}

/**
 * Проверка пакета сервером **сама, при вводе**, с задержкой (этап 6b): человеку не нужна отдельная
 * кнопка «Проверить» — одна кнопка «Сохранить N», доступная, когда проверка прошла. `body` — тело
 * запроса без `dryRun`; `null` — вводить пока нечего (проверка не идёт). Устаревший ответ (ввод
 * успел измениться) отбрасывается.
 */
export function useAutoPreview<R = BatchResult>(options: {
  path: string;
  body: Record<string, unknown> | null;
  /** Метод пакетного маршрута: добавление — `POST`, массовая правка — `PATCH`. */
  method?: 'POST' | 'PATCH';
  delayMs?: number;
}): AutoPreview<R> {
  const { path, body, delayMs = 400, method = 'POST' } = options;
  const key = body === null ? null : JSON.stringify(body);
  const [state, setState] = useState<{ key: string | null; preview: AutoPreview<R> }>({
    key: null,
    preview: { status: 'idle', result: null, error: null },
  });
  const latest = useRef(0);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => {
    if (key === null) return;
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      api<R>(path, {
        method,
        body: { ...(bodyRef.current ?? {}), dryRun: true },
      })
        .then((result) => {
          if (ticket === latest.current) {
            setState({ key, preview: { status: 'ready', result, error: null } });
          }
        })
        .catch((raw: unknown) => {
          if (ticket === latest.current) {
            setState({ key, preview: { status: 'failed', result: null, error: errorView(raw) } });
          }
        });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [key, path, delayMs, method]);

  if (key === null) return { status: 'idle', result: null, error: null };
  // ответ относится к другому вводу — проверка ещё идёт
  if (state.key !== key) return { status: 'checking', result: null, error: null };
  return state.preview;
}
