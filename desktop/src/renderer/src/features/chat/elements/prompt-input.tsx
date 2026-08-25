import { ArrowUp, CircleStop } from "lucide-react";
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
  inlineLeadingContext,
  inlineTrailingContext,
  canSubmit,
  focusRequestId,
  onTextareaKeyDown,
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
  // Structured prompt references share the editable text flow so they read as
  // context, rather than as a detached attachment header.
  inlineLeadingContext?: ReactNode;
  inlineTrailingContext?: ReactNode;
  canSubmit?: boolean;
  // Left side of the bottom row: compact pickers (provider, mode) rendered
  // Codex-style next to the send/stop control. Purely presentational slot.
  controls?: ReactNode;
  // Compact, real actions or status placed immediately before Send/Stop.
  trailingControls?: ReactNode;
  // Bumping this id focuses the textarea (type-to-start, ⌘J, chip seeds).
  focusRequestId?: number;
  onTextareaKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean | void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const submissionReady = canSubmit ?? value.trim().length > 0;
  const submitEnabled = !disabled && submissionReady;
  const hasInlineContext = Boolean(inlineLeadingContext || inlineTrailingContext);

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
      style={{ background: "var(--bg-surface)" }}
    >
      {attachments}
      <div
        data-slot="prompt-input-content"
        className="flex min-h-10 flex-wrap items-center gap-1.5 px-4 pt-3.5"
      >
        {inlineLeadingContext}
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
          className={`${hasInlineContext ? "min-w-32 flex-none" : "w-full"} resize-none bg-transparent p-0 text-md outline-none disabled:opacity-60`}
          style={{
            color: "var(--text-primary)",
            maxHeight: 220,
            maxWidth: "100%",
            width: hasInlineContext
              ? `${Math.min(Math.max(value.length + 1, 8), 48)}ch`
              : "100%",
          }}
          onKeyDown={(e) => {
            if (onTextareaKeyDown?.(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (submitEnabled) onSubmit();
            }
          }}
        />
        {inlineTrailingContext}
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {controls}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
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
