// Lean UI primitives on the token system. Hand-rolled (no heavy deps):
// consistent focus rings, light dismiss, Escape handling per the UX guide.
import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";

type ButtonVariant = "primary" | "ghost" | "danger" | "subtle";

const BUTTON_STYLES: Record<ButtonVariant, CSSProperties> = {
  primary: { background: "var(--accent)", color: "var(--text-on-accent)" },
  ghost: { background: "transparent", color: "var(--text-secondary)" },
  subtle: { background: "var(--bg-hover)", color: "var(--text-primary)" },
  danger: { background: "var(--danger-muted)", color: "var(--danger)" },
};

export function Button({
  variant = "subtle",
  className = "",
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={`no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-100 hover:brightness-110 disabled:opacity-50 ${className}`}
      style={{ ...BUTTON_STYLES[variant], ...style }}
      {...props}
    />
  );
}

export function IconButton({
  label,
  className = "",
  active = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`no-drag inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-100 ${className}`}
      style={{
        color: active ? "var(--accent)" : "var(--text-tertiary)",
        background: active ? "var(--accent-muted)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
      {...props}
    />
  );
}

export function Dialog({
  open,
  onClose,
  children,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const onBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={onBackdrop}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className="fade-in rounded-xl border"
        style={{
          width,
          background: "var(--bg-overlay)",
          borderColor: "var(--border-default)",
          boxShadow: "var(--shadow-3)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function ContextMenu({
  position,
  items,
  onClose,
}: {
  position: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    if (!position) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [position, onClose]);

  if (!position) return null;
  return (
    <div
      className="fade-in fixed z-50 min-w-[180px] rounded-lg border p-1"
      style={{
        left: Math.min(position.x, window.innerWidth - 200),
        top: Math.min(position.y, window.innerHeight - items.length * 30 - 16),
        background: "var(--bg-overlay)",
        borderColor: "var(--border-default)",
        boxShadow: "var(--shadow-2)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          disabled={item.disabled}
          className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-75 disabled:opacity-40"
          style={{ color: item.danger ? "var(--danger)" : "var(--text-primary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function StatusDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${pulse ? "status-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

export function EmptyState({
  icon,
  headline,
  description,
  action,
}: {
  icon: ReactNode;
  headline: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8">
      <div style={{ color: "var(--text-tertiary)" }}>{icon}</div>
      <h2 className="text-md font-semibold" style={{ color: "var(--text-primary)" }}>
        {headline}
      </h2>
      <p className="max-w-[320px] text-center text-sm" style={{ color: "var(--text-secondary)" }}>
        {description}
      </p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
