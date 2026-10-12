import { Monitor, Moon, Sun } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Button } from './components/button';

export type ThemeChoice = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'oxrana.theme';

function readChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function apply(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

const ThemeContext = createContext<{ choice: ThemeChoice; set: (c: ThemeChoice) => void }>({
  choice: 'system',
  set: () => undefined,
});

/** Светлая и тёмная тема: выбор помнится в браузере (если он недоступен — тема по системе). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  useEffect(() => {
    apply(choice);
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);
  const set = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // хранилище недоступно — выбор действует до перезагрузки
    }
  }, []);
  return <ThemeContext.Provider value={{ choice, set }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const LABEL: Record<ThemeChoice, string> = {
  system: 'Тема: как в системе',
  light: 'Тема: светлая',
  dark: 'Тема: тёмная',
};

export function ThemeToggle() {
  const { choice, set } = useTheme();
  const Icon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor;
  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? 'system';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`${LABEL[choice]}. Нажмите, чтобы переключить`}
      title={LABEL[choice]}
      onClick={() => set(next)}
    >
      <Icon aria-hidden className="size-4" />
    </Button>
  );
}
