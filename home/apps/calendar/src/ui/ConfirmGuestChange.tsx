/**
 * Asks before a moved, resized or deleted event notifies its guests. The
 * owner picks: notify the named guests, change without notifying, or cancel.
 */
import { useRef } from "react";
import { Dialog } from "../../../_shared/office-ui";

export interface GuestChange {
  kind: "move" | "delete";
  eventTitle: string;
  recipients: string[];
}

export interface ConfirmGuestChangeProps {
  change: GuestChange | null;
  onNotify(): void;
  onSilent(): void;
  onCancel(): void;
}

const MAX_SHOWN = 20;

export function ConfirmGuestChange({ change, onNotify, onSilent, onCancel }: ConfirmGuestChangeProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleting = change?.kind === "delete";
  const shown = change?.recipients.slice(0, MAX_SHOWN) ?? [];
  const hidden = (change?.recipients.length ?? 0) - shown.length;
  return (
    <Dialog
      open={change !== null}
      onClose={onCancel}
      role="alertdialog"
      size="sm"
      title={deleting ? "Cancel this event for its guests?" : "Tell guests about the new time?"}
      initialFocusRef={cancelRef}
      dismissOnBackdrop={false}
      showClose={false}
      footer={
        <>
          <button ref={cancelRef} type="button" className="oui-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="oui-button" onClick={onSilent}>{deleting ? "Delete without notifying" : "Save without notifying"}</button>
          <button type="button" className={`oui-button ${deleting ? "oui-button--danger" : "oui-button--primary"}`} onClick={onNotify}>
            {deleting ? "Delete and notify" : "Send update"}
          </button>
        </>
      }
    >
      {change && (
        <>
          <p className="oui-confirm__summary">{change.eventTitle || "(No title)"}</p>
          <div className="oui-confirm__recipients">
            <span className="oui-confirm__label">Guests</span>
            <ul>
              {shown.map((address) => <li key={address}>{address}</li>)}
              {hidden > 0 && <li>and {hidden} more</li>}
            </ul>
          </div>
        </>
      )}
    </Dialog>
  );
}
