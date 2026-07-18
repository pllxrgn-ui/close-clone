import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, ReactNode } from 'react';
import { CloseIcon } from '../ui/icons.tsx';

interface ToastItem {
  id: string;
  message: string;
}

interface ToastContextValue {
  /** Show a transient status message. */
  toast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_TTL_MS = 4000;

/**
 * Minimal toast surface. Messages land in a polite live region (announced to
 * screen readers) and auto-dismiss after `ttl`. Deliberately tiny — used for
 * async feedback (sends, call logging, compliance blocks) across features.
 */
export function ToastProvider({
  children,
  ttl = DEFAULT_TTL_MS,
}: {
  children: ReactNode;
  ttl?: number;
}): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string) => {
      const id = crypto.randomUUID();
      setItems((prev) => [...prev, { id, message }]);
      if (ttl > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ttl),
        );
      }
    },
    [ttl, dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sb-toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className="sb-toast">
            <span className="sb-toast__msg">{item.message}</span>
            <button
              type="button"
              className="sb-iconbtn sb-iconbtn--sm sb-toast__close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(item.id)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
