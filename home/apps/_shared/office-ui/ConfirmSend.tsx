import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";

export interface ConfirmSendProps {
  open: boolean;
  onCancel: () => void;
  /** Performs the send. A returned promise keeps the dialog busy until it settles. */
  onConfirm: () => void | Promise<void>;
  /** "mail" (default) or "invite" picks the default title and button text. */
  kind?: "mail" | "invite";
  title?: string;
  recipients?: readonly string[];
  /** Subject, event title or other short description of what is sent. */
  summary?: ReactNode;
  confirmLabel?: string;
  /** External busy flag, combined with the internal one. */
  busy?: boolean;
  /** External error text. Keep it generic; never pass provider errors through. */
  error?: string | null;
}

const GENERIC_ERROR = "Could not send. Try again.";
const MAX_RECIPIENTS_SHOWN = 20;

/**
 * Explicit owner confirmation before anything leaves Matrix. Cancel is focused
 * first so Enter never sends by accident. The dialog's state (sending, the
 * last failure) lives only while it is open.
 */
export function ConfirmSend(props: ConfirmSendProps) {
  return props.open ? <OpenConfirmSend {...props} /> : null;
}

function OpenConfirmSend({
  onCancel,
  onConfirm,
  kind = "mail",
  title,
  recipients = [],
  summary,
  confirmLabel,
  busy = false,
  error = null,
}: ConfirmSendProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isBusy = busy || sending;
  const heading = title ?? (kind === "invite" ? "Send this invitation?" : "Send this email?");
  const action = confirmLabel ?? "Send";
  const shown = recipients.slice(0, MAX_RECIPIENTS_SHOWN);
  const hidden = recipients.length - shown.length;
  const message = error ?? failure;

  const confirm = async () => {
    if (isBusy) return;
    setFailure(null);
    setSending(true);
    try {
      await onConfirm();
    } catch (err: unknown) {
      console.error("[office-ui] send failed", err instanceof Error ? err.name : typeof err);
      if (mounted.current) setFailure(GENERIC_ERROR);
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!isBusy) onCancel();
      }}
      role="alertdialog"
      size="sm"
      title={heading}
      initialFocusRef={cancelRef}
      dismissOnBackdrop={false}
      showClose={false}
      footer={
        <>
          <button ref={cancelRef} type="button" className="oui-button" onClick={onCancel} disabled={isBusy}>Cancel</button>
          <button type="button" className="oui-button oui-button--primary" onClick={() => void confirm()} disabled={isBusy} aria-busy={isBusy || undefined}>
            {isBusy ? "Sending…" : action}
          </button>
        </>
      }
    >
      {summary && <p className="oui-confirm__summary">{summary}</p>}
      {shown.length > 0 && (
        <div className="oui-confirm__recipients">
          <span className="oui-confirm__label">{kind === "invite" ? "Guests" : "To"}</span>
          <ul>
            {shown.map((recipient) => <li key={recipient}>{recipient}</li>)}
            {hidden > 0 && <li>and {hidden} more</li>}
          </ul>
        </div>
      )}
      {message && <p role="alert" className="oui-confirm__error">{message}</p>}
    </Dialog>
  );
}
