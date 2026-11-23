import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "./internal";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: "info" | "success" | "warning" | "danger";
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay in ms (default 5000; 0 keeps it until dismissed). */
  durationMs?: number;
}

interface ToastEntry extends ToastOptions {
  id: string;
}

export interface ToastApi {
  show: (toast: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const MAX_TOASTS = 5;
const ToastContext = createContext<ToastApi | null>(null);

/** Hosts the toast stack (bounded to 5, oldest evicted) and provides useToast(). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);
  /** Ids on screen, oldest first; mirrors `toasts` so eviction happens outside the state updater. */
  const order = useRef<string[]>([]);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    order.current = order.current.filter((known) => known !== id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (toast: ToastOptions) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      const ids = [...order.current, id];
      for (const old of ids.slice(0, Math.max(0, ids.length - MAX_TOASTS))) {
        const timer = timers.current.get(old);
        if (timer) clearTimeout(timer);
        timers.current.delete(old);
      }
      order.current = ids.slice(-MAX_TOASTS);
      setToasts((current) => [...current, { ...toast, id }].slice(-MAX_TOASTS));
      const duration = toast.durationMs ?? 5000;
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export interface ToastHostProps {
  toasts: readonly ToastEntry[];
  onDismiss: (id: string) => void;
}

/** Presentational stack; ToastProvider renders it for you. */
export function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  return (
    <div className="oui-toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "danger" ? "alert" : "status"}
          className={cx("oui-toast", `oui-toast--${toast.tone ?? "info"}`)}
        >
          <div className="oui-toast__text">
            <strong className="oui-toast__title">{toast.title}</strong>
            {toast.description && <span className="oui-toast__description">{toast.description}</span>}
          </div>
          {toast.action && (
            <button
              type="button"
              className="oui-button oui-button--ghost"
              onClick={() => {
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" className="oui-icon-button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
