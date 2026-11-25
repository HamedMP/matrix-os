/**
 * The composer's confirmations: unresolved tracked changes at Send, and
 * discarding a draft.
 */
import { useRef } from "react";
import { Dialog } from "../../../../_shared/office-ui";
import { unresolvedWarning } from "../../compose/send-plan";

export interface SendWarningDialogProps {
  open: boolean;
  pending: number;
  busy: boolean;
  onReview(): void;
  onAcceptAllAndSend(): void;
  onCancel(): void;
}

export function SendWarningDialog({ open, pending, busy, onReview, onAcceptAllAndSend, onCancel }: SendWarningDialogProps) {
  const reviewRef = useRef<HTMLButtonElement>(null);
  const text = unresolvedWarning(pending);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      size="sm"
      title={text.title}
      description={text.description}
      initialFocusRef={reviewRef}
      dismissOnBackdrop={false}
      footer={(
        <>
          <button type="button" className="oui-button oui-button--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="oui-button" ref={reviewRef} onClick={onReview} disabled={busy}>Review</button>
          <button type="button" className="oui-button oui-button--primary" onClick={onAcceptAllAndSend} disabled={busy}>Accept all and send</button>
        </>
      )}
    />
  );
}

export interface DiscardDialogProps {
  open: boolean;
  onDiscard(): void;
  onCancel(): void;
}

export function DiscardDialog({ open, onDiscard, onCancel }: DiscardDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      size="sm"
      title="Discard this draft?"
      description="The draft is deleted from your mailbox too. This cannot be undone."
      initialFocusRef={cancelRef}
      footer={(
        <>
          <button type="button" className="oui-button oui-button--ghost" ref={cancelRef} onClick={onCancel}>Keep editing</button>
          <button type="button" className="oui-button oui-button--danger" onClick={onDiscard}>Discard</button>
        </>
      )}
    />
  );
}
