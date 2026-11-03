import { ArrowUp, CircleStop } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

// AI-Elements-style prompt card shared by Web and Electron Desktop Chat: a
// growing input with a toolbar row below it. Decorative action buttons are not
// rendered — every control must have a working handler. Colors read the
// `--composer-*` tokens first so a host whose `--accent` is a light hover
// tint (the Web shell) can still give Send its primary color.
export function ChatPromptInput({
  value,
  onChange,
  onSubmit,
  onAbort,
  busy,
  submitWhileBusy = false,
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
  sendLabel = "Send",
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  busy: boolean;
  submitWhileBusy?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  maxLength?: number;
  placeholder?: string;
  ariaLabel?: string;
  footer?: ReactNode;
  attachments?: ReactNode;
  editor?: ReactNode;
  canSubmit?: boolean;
  // Left side of the toolbar: attach and context controls.
  controls?: ReactNode;
  // Compact, real actions or pickers placed immediately before Send/Stop.
  trailingControls?: ReactNode;
  // Bumping this id focuses the textarea (type-to-start, ⌘J, chip seeds).
  focusRequestId?: number;
  onTextareaKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean | void;
  layout?: "default" | "narrow";
  sendLabel?: string;
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
      className="prompt-card relative z-[1] flex flex-col rounded-[var(--radius-xl)] border"
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
      <div data-slot="prompt-input-toolbar" className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {controls}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {trailingControls}
          {busy && onAbort && !(submitWhileBusy && submissionReady) ? (
            <ChatPromptStopButton onAbort={onAbort}/>
          ) : (
            <button
              type="button"
              aria-label={sendLabel}
              data-slot="prompt-input-send"
              disabled={!submitEnabled}
              onClick={onSubmit}
              className="flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40"
              style={{
                background: submitEnabled ? "var(--composer-send-bg, var(--accent))" : "var(--composer-idle-bg, var(--bg-active))",
                color: submitEnabled ? "var(--composer-send-fg, var(--text-on-accent))" : "var(--text-tertiary)",
              }}
            >
              <HugeiconsIcon icon={ArrowUp} size={16} strokeWidth={1.5} aria-hidden />
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

/** Shared Stop presentation, including identity-recovery states without a composer. */
export function ChatPromptStopButton({ onAbort }: { onAbort():void }) {
  return <button type="button" aria-label="Stop" onClick={onAbort}
    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
    style={{ background: "var(--composer-stop-bg, var(--danger-muted))", color: "var(--danger)" }}>
    <HugeiconsIcon icon={CircleStop} size={16} strokeWidth={1.5} aria-hidden />
  </button>;
}
