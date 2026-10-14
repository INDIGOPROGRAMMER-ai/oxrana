import { useEffect, useRef, useState } from 'react';

/**
 * Значение с задержкой: подсказки формы не запрашиваются на каждую нажатую букву. Сравнение — по
 * содержимому (JSON), поэтому новый объект с теми же полями таймер не перезапускает.
 */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  const key = JSON.stringify(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(latest.current), delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs]);
  return debounced;
}
