import { useEffect, useState } from 'react';

/** Совпадает ли экран с медиазапросом; обновляется при повороте и изменении окна. */
export function useMedia(query: string, initial = true): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : initial,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Широкий экран (≥ 640 px, `sm` в Tailwind): фильтры в строке, а не в выезжающей панели. */
export const useWideScreen = (): boolean => useMedia('(min-width: 640px)');
