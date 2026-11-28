/**
 * The composer's footer: validation messages, Cancel, and the primary action.
 * With guests the primary action is Send invite (or Send update), which only
 * opens a confirmation naming every recipient; the store is called from that
 * confirmation. Without guests it saves and notifies no one.
 */
import { useState } from "react";
import { ConfirmSend } from "../../../_shared/office-ui";
import type { CalendarStore } from "../model";
import type { DraftState } from "../model/drafts";
import { inviteRecipients } from "./composer-helpers";
import { issueText } from "./composerOptions";
import { formatEventWhen } from "./format";

export interface ComposerFooterProps {
  store: CalendarStore;
  draftState: DraftState;
  /** The grid's zone, for the confirmation's time text of all-day drafts. */
  viewZone: string;
  attempted: boolean;
  onAttempt(): void;
}

/** What the primary button says and whether it may act. */
function primaryAction(draftState: DraftState): { label: string; sendsInvites: boolean; blocked: boolean } {
  const sendsInvites = inviteRecipients(draftState).length > 0;
  const editing = draftState.mode === "edit";
  return {
    label: sendsInvites ? (editing ? "Send update" : "Send invite") : "Save",
    sendsInvites,
    blocked: !draftState.draft.title.trim() || draftState.issues.length > 0,
  };
}

export function ComposerFooter({ store, draftState, viewZone, attempted, onAttempt }: ComposerFooterProps) {
  const [confirming, setConfirming] = useState(false);
  const { draft } = draftState;
  const saving = draftState.status === "saving";
  const action = primaryAction(draftState);
  const messages = [...(attempted ? draftState.issues.map(issueText) : []), ...(draftState.error ? [draftState.error] : [])];

  function onPrimary() {
    onAttempt();
    if (action.blocked || saving) return;
    if (action.sendsInvites) setConfirming(true);
    else void store.saveDraft({ sendInvites: false });
  }

  return (
    <div className="cal-composer__foot">
      {messages.length > 0 && (
        <ul className="cal-composer__errors" role="alert">
          {messages.map((text) => <li key={text}>{text}</li>)}
        </ul>
      )}
      <div className="cal-composer__actions">
        <button type="button" className="oui-button" onClick={() => store.closeDraft()} disabled={saving}>Cancel</button>
        <button type="button" className="oui-button oui-button--primary" onClick={onPrimary} disabled={saving} aria-busy={saving || undefined}>
          {saving ? "Saving…" : action.label}
        </button>
      </div>
      <ConfirmSend
        open={confirming}
        kind="invite"
        title={draftState.mode === "edit" ? "Send the updated invitation?" : "Send this invitation?"}
        confirmLabel={action.label}
        recipients={inviteRecipients(draftState)}
        summary={`${draft.title.trim()} · ${formatEventWhen(draft, draft.allDay ? viewZone : draft.timeZone)}`}
        busy={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await store.saveDraft({ sendInvites: true });
          setConfirming(false);
        }}
      />
    </div>
  );
}
