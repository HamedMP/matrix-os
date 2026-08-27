import { ArrowUp, CircleStop } from "@renderer/lib/hugeicons";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

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
  controls,
  trailingControls,
  attachments,
  editor,
  canSubmit,
  focusRequestId,
  onTextareaKeyDown,
  layout = "default",
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
  attachments?: ReactNode;
  editor?: ReactNode;
  canSubmit?: boolean;
  // Left side of the bottom row: compact pickers (provider, mode) rendered
  // Codex-style next to the send/stop control. Purely presentational slot.
  controls?: ReactNode;
  // Compact, real actions or status placed immediately before Send/Stop.
  trailingControls?: ReactNode;
  // Bumping this id focuses the textarea (type-to-start, ⌘J, chip seeds).
  focusRequestId?: number;
  onTextareaKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean | void;
  layout?: "default" | "narrow";
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const submissionReady = canSubmit ?? value.trim().length > 0;
  const submitEnabled = !disabled && submissionReady;

  useEffect(() => {
    if (!focusRequestId || focusRequestId <= 0) return;
    ref.current?.focus();
  }, [focusRequestId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const contentHeight = el.scrollHeight;
    el.style.height = `${Math.min(contentHeight, 220)}px`;
    el.style.overflowY = contentHeight > 220 ? "auto" : "hidden";
  }, [value]);

  return (
    <div
      className="prompt-card flex flex-col rounded-[var(--radius-xl)] border"
      data-layout={layout}
      style={{ background: "var(--bg-surface)" }}
    >
      {attachments}
      {editor ?? (
        <div className="px-4 pt-3.5">
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
            className="w-full resize-none bg-transparent p-0 text-md outline-none disabled:opacity-60"
            style={{
              color: "var(--text-primary)",
              maxHeight: 220,
              maxWidth: "100%",
            }}
            onKeyDown={(e) => {
              if (onTextareaKeyDown?.(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (submitEnabled) onSubmit();
              }
            }}
          />
        </div>
      )}
      <div className={`flex gap-2 px-2.5 pb-2.5 ${layout === "narrow" ? "flex-col items-stretch" : "items-center justify-between"}`}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {controls}
        </div>
        <div className={`flex shrink-0 flex-wrap items-center gap-1.5 ${layout === "narrow" ? "justify-end" : ""}`}>
          {trailingControls}
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
              disabled={!submitEnabled}
              onClick={onSubmit}
              className="flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40"
              style={{ background: submitEnabled ? "var(--accent)" : "var(--bg-active)", color: submitEnabled ? "var(--text-on-accent)" : "var(--text-tertiary)" }}
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
