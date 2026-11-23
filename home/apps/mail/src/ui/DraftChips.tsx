/**
 * Drafts the composer is not showing: other open drafts, and closed drafts the
 * store still holds because their last save has not reached the provider. Each
 * chip opens its draft again, so closing the composer never strands one.
 */
import { AlertCircle, PenLine } from "lucide-react";
import type { DraftState, MailState } from "../model";
import { useMailUi } from "./context";

function chipTitle(draft: DraftState): string {
  const subject = draft.draft.subject.replace(/\s+/g, " ").trim();
  if (subject) return subject.length > 60 ? `${subject.slice(0, 59)}…` : subject;
  const to = draft.draft.to[0]?.address;
  return to ? `To ${to}` : "(no subject)";
}

function chipStatus(draft: DraftState): string | null {
  if (draft.sending) return "Sending…";
  if (draft.saving) return "Saving…";
  if (draft.error) return "Not saved";
  return draft.revision > draft.savedRevision ? "Unsaved" : null;
}

/** The drafts a chip is shown for, oldest first. */
export function backgroundDrafts(state: MailState): DraftState[] {
  return Object.values(state.drafts).filter((draft) => !(draft.open && draft.localId === state.activeDraftId));
}

export function DraftChips({ state }: { state: MailState }) {
  const { store } = useMailUi();
  const drafts = backgroundDrafts(state);
  if (drafts.length === 0) return null;
  return (
    <div className="mail-draft-chips" role="group" aria-label="Drafts" data-mail-keys="off">
      {drafts.map((draft) => {
        const title = chipTitle(draft);
        const status = chipStatus(draft);
        return (
          <button
            key={draft.localId}
            type="button"
            className={draft.error ? "mail-draft-chip is-error" : "mail-draft-chip"}
            aria-label={`Open draft: ${title}${status ? ` (${status})` : ""}`}
            title="Open this draft"
            onClick={() => store.openDraft(draft.localId)}
          >
            {draft.error ? <AlertCircle size={13} aria-hidden="true" /> : <PenLine size={13} aria-hidden="true" />}
            <span className="mail-draft-chip__title">{title}</span>
            {status && <span className="mail-draft-chip__status">{status}</span>}
          </button>
        );
      })}
    </div>
  );
}
