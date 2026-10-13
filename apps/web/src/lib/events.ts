import { DOMAIN_EVENT_PAYLOADS } from '@oxrana/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

const EVENT_TYPES = Object.keys(DOMAIN_EVENT_PAYLOADS);
/** Пачка событий (пакет на 20 пропусков) даёт одно обновление, а не двадцать. */
const DEBOUNCE_MS = 250;

/**
 * События объекта по SSE (ADR-004): любое доменное событие перечитывает данные экранов и подсказки
 * формы — без F5 на главной, в списке пропусков и в очереди согласований. В `payload` нет ПДн;
 * сервер сам отдаёт арендатору только события его компаний. Обрыв связи браузер переживает сам
 * (повтор с `Last-Event-ID`); отозванная сессия закрывает поток событием `revoked`.
 */
export function useSiteEvents(siteId: string | null): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  useEffect(() => {
    if (!siteId || typeof EventSource === 'undefined') return;
    setState('connecting');
    const source = new EventSource(`/api/sites/${siteId}/events`, { withCredentials: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void client.invalidateQueries({ queryKey: ['data'] });
        void client.invalidateQueries({ queryKey: ['hints'] });
      }, DEBOUNCE_MS);
    };
    source.onopen = () => setState('live');
    source.onerror = () => setState('reconnecting');
    for (const type of EVENT_TYPES) source.addEventListener(type, refresh);
    source.addEventListener('resync', refresh);
    source.addEventListener('revoked', () => {
      source.close();
      void client.invalidateQueries({ queryKey: ['me'] });
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [siteId, client]);
  return state;
}
