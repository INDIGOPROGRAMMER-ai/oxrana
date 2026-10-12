import { CheckCircle2, OctagonAlert } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';

interface ToastItem {
  readonly id: number;
  readonly text: string;
  readonly tone: 'success' | 'danger';
}

const ToastContext = createContext<(text: string, tone?: ToastItem['tone']) => void>(
  () => undefined,
);

/** Короткие уведомления. «Сохранено» показывают только после успешного ответа сервера. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const show = useCallback((text: string, tone: ToastItem['tone'] = 'success') => {
    const id = nextId.current++;
    setItems((list) => [...list, { id, text, tone }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'danger' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm shadow-lg"
          >
            {t.tone === 'success' ? (
              <CheckCircle2 aria-hidden className="size-4 text-success" />
            ) : (
              <OctagonAlert aria-hidden className="size-4 text-destructive" />
            )}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
