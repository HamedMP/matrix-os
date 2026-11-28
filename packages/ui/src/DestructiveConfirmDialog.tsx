// The app's destructive confirm (ENG-521, after Electron Desktop's archive
// "Delete … forever?" design): a short title on one line, one body line, a
// bordered Cancel and a solid destructive action, and a key hint. Built on the
// shared Dialog, so Esc and a backdrop click cancel, Tab stays inside, and focus
// goes back where it was when it closes. The action has focus, so Enter confirms.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";

export interface DestructiveConfirmDialogProps {
  open: boolean;
  /** One line; longer text is cut with an ellipsis and kept whole in the tooltip. */
  title: string;
  body: ReactNode;
  /** The action's label ("End terminal", "Delete forever"). */
  confirmLabel: string;
  /** The verb the key hint names for Enter ("End", "Delete"). */
  confirmVerb?: string;
  onConfirm(): void;
  onCancel(): void;
  busy?: boolean;
  error?: string | null;
}

const BUTTON_STYLE: React.CSSProperties = {
  fontFamily: "inherit", height: 36, padding: "0 14px", borderRadius: 8, fontSize: 14, lineHeight: "20px", fontWeight: 500,
};

export function DestructiveConfirmDialog({
  open, title, body, confirmLabel, confirmVerb, onConfirm, onCancel, busy = false, error = null,
}: DestructiveConfirmDialogProps) {
  const verb = confirmVerb ?? confirmLabel.split(" ")[0] ?? confirmLabel;
  const titleId = useId();
  const bodyId = useId();
  // Focus goes back to what had it (the terminal pane) once the confirm closes, either way.
  const returnTo = useRef<HTMLElement | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The action takes focus so Enter confirms; read after what had focus is kept.
    actionRef.current?.focus();
    return () => {
      const target = returnTo.current;
      returnTo.current = null;
      if (target?.isConnected) target.focus();
    };
  }, [open]);
  return (
    <Dialog open={open} onClose={() => { if (!busy) onCancel(); }} role="alertdialog" aria-label={title}
      aria-labelledby={titleId} aria-describedby={bodyId}
      style={{ width: 420, maxWidth: "90vw", padding: 0 }}>
      {open ? (
        <div style={{ padding: "24px 24px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 id={titleId} title={title} style={{
            fontFamily: "inherit", fontSize: 14, fontWeight: 600, lineHeight: "20px", margin: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{title}</h2>
          <p id={bodyId} style={{ margin: 0, fontSize: 13, lineHeight: "18px", color: "var(--matrix-muted-fg, var(--text-secondary))" }}>{body}</p>
          {error ? <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger-text, var(--matrix-destructive))" }}>{error}</p> : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 16 }}>
            <Button variant="secondary" size="sm" style={BUTTON_STYLE} disabled={busy} onClick={onCancel}>Cancel</Button>
            <Button ref={actionRef} variant="destructive" size="sm" style={BUTTON_STYLE} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
          </div>
          <footer aria-hidden="true" style={{
            display: "flex", justifyContent: "flex-end", gap: 12, paddingTop: 4,
            fontSize: 11, lineHeight: "16px", color: "var(--matrix-muted-fg, var(--text-tertiary))",
          }}>
            <span>↵ {verb}</span><span>esc Cancel</span>
          </footer>
        </div>
      ) : null}
    </Dialog>
  );
}
