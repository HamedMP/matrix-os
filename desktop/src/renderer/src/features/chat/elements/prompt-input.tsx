import { ArrowUp, CircleStop } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

// AI-Elements-style PromptInput: a card with a growing textarea and a
// submit/stop control. Decorative action buttons were removed — every
// rendered control must have a working handler.
export function PromptInput({
  value,
  onChange,
  onSubmit,
  onAbort,
  busy,
  autoFocus,
  disabled = false,
  maxLength,
  placeholder = "Do anything",
  ariaLabel,
  footer,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  busy: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  maxLength?: number;
  placeholder?: string;
  ariaLabel?: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  return (
    <div
      className="prompt-card flex flex-col overflow-hidden rounded-2xl border"
      style={{ background: "var(--bg-surface)" }}
    >
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        disabled={disabled}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        rows={1}
        className="w-full resize-none bg-transparent px-4 pt-3.5 text-md outline-none disabled:opacity-60"
        style={{ color: "var(--text-primary)", maxHeight: 220 }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5">
        <div className="flex items-center gap-1.5">
          {busy && onAbort ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={onAbort}
              className="flex h-8 w-8 items-center justify-center rounded-full"
              style={{ background: "var(--danger-muted)", color: "var(--danger)" }}
            >
              <CircleStop size={16} />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={disabled || value.trim().length === 0}
              onClick={onSubmit}
              className="flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40"
              style={{ background: value.trim().length ? "var(--accent)" : "var(--bg-active)", color: value.trim().length ? "var(--text-on-accent)" : "var(--text-tertiary)" }}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      {footer ? (
        <div className="flex items-center gap-3 border-t px-3 py-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
          {footer}
        </div>
      ) : null}
    </div>
  );
}
