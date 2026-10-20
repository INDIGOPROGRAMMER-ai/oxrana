import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';

/** Карточку открыли щелчком в этой вкладке: закрытие возвращает на шаг назад, а не добавляет запись. */
let pushedByClick = false;

type Search = Record<string, unknown>;

/**
 * Открытая карточка пропуска — в адресе (`?pass=<id>`, 7b.3): ссылку можно отправить, «Назад» в
 * браузере закрывает карточку. Работает на любой странице, чей маршрут пропускает параметр `pass`
 * в `validateSearch`; остальные параметры адреса (вкладка, фильтр) сохраняются.
 */
export function usePassCardLink() {
  const router = useRouter();
  const navigate = useNavigate();
  const raw = useRouterState({ select: (s) => (s.location.search as Search).pass });
  const passId = typeof raw === 'string' && raw !== '' ? raw : null;

  // карточка закрыта «Назад» или ссылкой — признак щелчка больше не действует
  useEffect(() => {
    if (passId === null) pushedByClick = false;
  }, [passId]);

  const open = useCallback(
    (id: string) => {
      pushedByClick = true;
      void navigate({
        to: '.',
        search: ((prev: Search) => ({ ...prev, pass: id })) as never,
      });
    },
    [navigate],
  );

  const close = useCallback(() => {
    if (pushedByClick) {
      pushedByClick = false;
      router.history.back();
      return;
    }
    void navigate({
      to: '.',
      replace: true,
      search: (({ pass: _pass, ...rest }: Search) => rest) as never,
    });
  }, [navigate, router]);

  return { passId, open, close };
}
