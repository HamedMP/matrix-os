/**
 * A plain composer used when the full composer module is not part of the
 * build. It edits the active draft through the store; mail is sent only from
 * its Send button.
 */
import { useState } from "react";
import { Send, Trash2, X } from "lucide-react";
import { TextField } from "../../../_shared/office-ui";
import { formatMailAddress, type DraftIssue, type MailAddress } from "../../../_shared/office-accounts/types/mail";
import { parseAddressList } from "../../../_shared/office-accounts/mail/addresses";
import { textToHtml } from "../html";
import type { ComposerSlotProps } from "./slots";

const ISSUE_TEXT: Readonly<Record<DraftIssue, string>> = Object.freeze({
  no_recipients: "Add at least one recipient.",
  invalid_address: "One of the addresses is not valid.",
  too_many_recipients: "There are too many recipients.",
  subject_too_long: "The subject is too long.",
  too_many_attachments: "There are too many attachments.",
  too_large: "This message is too large to send.",
});

const formatList = (list: readonly MailAddress[]) => list.map(formatMailAddress).join(", ");

export function FallbackComposer({ store, draft, onClose }: ComposerSlotProps) {
  const id = draft.localId;
  const [to, setTo] = useState(() => formatList(draft.draft.to));
  const [cc, setCc] = useState(() => formatList(draft.draft.cc));
  const title = draft.kind === "new" ? "New message" : draft.kind === "forward" ? "Forward" : "Reply";

  const editBody = (text: string) => store.editDraft(id, { bodyText: text, bodyHtml: textToHtml(text).html });

  return (
    <section className="mail-composer" aria-label={title} data-mail-keys="off">
      <header className="mail-composer__header">
        <h2 className="mail-composer__title">{title}</h2>
        <button type="button" className="oui-icon-button" aria-label="Close draft" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="mail-composer__fields">
        <TextField label="To" value={to} onChange={setTo} inputProps={{ onBlur: () => store.editDraft(id, { to: parseAddressList(to) }) }} />
        <TextField label="Cc" value={cc} onChange={setCc} inputProps={{ onBlur: () => store.editDraft(id, { cc: parseAddressList(cc) }) }} />
        <TextField label="Subject" value={draft.draft.subject} onChange={(subject) => store.editDraft(id, { subject })} />
        <TextField label="Message" multiline rows={10} value={draft.draft.bodyText} onChange={editBody} />
        {draft.quote && <pre className="mail-composer__quote" aria-label="Quoted message">{draft.quote.text}</pre>}
      </div>
      {(draft.issues.length > 0 || draft.error) && (
        <ul className="mail-composer__issues" role="alert">
          {draft.issues.map((issue) => <li key={issue}>{ISSUE_TEXT[issue]}</li>)}
          {draft.error && <li>{draft.error.message}</li>}
        </ul>
      )}
      <footer className="mail-composer__footer">
        <span className="mail-composer__status" aria-live="polite">
          {draft.sending ? "Sending…" : draft.saving ? "Saving…" : draft.savedAt ? "Draft saved" : ""}
        </span>
        <button type="button" className="oui-button oui-button--ghost" onClick={() => void store.discardDraft(id)}>
          <Trash2 size={14} aria-hidden="true" /> Discard
        </button>
        <button
          type="button"
          className="oui-button oui-button--primary"
          disabled={draft.sending}
          onClick={() => {
            store.editDraft(id, { to: parseAddressList(to), cc: parseAddressList(cc) });
            void store.sendDraft(id);
          }}
        >
          <Send size={14} aria-hidden="true" /> Send
        </button>
      </footer>
    </section>
  );
}
