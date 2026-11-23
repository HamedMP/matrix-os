/**
 * The composer's content: recipients, subject, the rich-text body with
 * tracked changes, the quoted original, attachments and the actions.
 *
 * Sending happens only in `requestSend`, called from the Send button or the
 * Ctrl/Cmd+Enter shortcut. Pending tracked changes are never sent silently:
 * the owner reviews them, accepts them all and sends, or cancels.
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Paperclip, Send, Trash2, X } from "lucide-react";
import { ReviewBar, TextField } from "../../../../_shared/office-ui";
import { draftIssues, type DraftIssue } from "../../../../_shared/office-accounts/types/mail";
import { agentErrorMessage, isMailAgentError } from "../../agent/errors";
import { collectKnownAddresses } from "../../compose/address-book";
import { assistantBodyHtml } from "../../compose/assistant";
import { formatBytes } from "../../compose/attachments";
import { sendComposedDraft } from "../../compose/send-flow";
import { SEND_BLOCK_TEXT, isExplicitSend, planSend, type SendTrigger } from "../../compose/send-plan";
import { forget } from "../../compose/sessions";
import { createSignatureStore, signatureHtml } from "../../compose/signature";
import { composeDraft } from "../../model";
import { MailUiContext } from "../context";
import { AttachmentPicker } from "./AttachmentPicker";
import { DiscardDialog, SendWarningDialog } from "./ComposeDialogs";
import type { ComposerProps } from "./composer-props";
import { FormatBar } from "./FormatBar";
import { RecipientField } from "./RecipientField";
import { RichEditor, type RichEditorHandle } from "./RichEditor";
import { SignatureButton } from "./SignatureButton";
import { useComposeBody } from "./use-compose-body";
import { useRecipients, type RecipientKind } from "./use-recipients";

const ISSUE_TEXT: Readonly<Record<DraftIssue, string>> = Object.freeze({
  no_recipients: "Add at least one recipient.",
  invalid_address: "One of the addresses is not valid.",
  too_many_recipients: "There are too many recipients.",
  subject_too_long: "The subject is too long.",
  too_many_attachments: "There are too many attachments.",
  too_large: "This message is too large to send. Remove an attachment or shorten the text.",
});

/** Text without whitespace and dashes, to tell a body that holds only the signature. */
const bare = (text: string) => text.replace(/[\s-]+/g, "");

const SEND_FAILED = "The message could not be sent. Your draft is kept.";
const RECIPIENT_LABELS: Readonly<Record<RecipientKind, string>> = { to: "To", cc: "Cc", bcc: "Bcc" };

export interface ComposeFormProps extends ComposerProps {
  popped: boolean;
  onTogglePop(): void;
}

export function titleFor(kind: ComposerProps["draft"]["kind"]): string {
  return kind === "new" ? "New message" : kind === "forward" ? "Forward" : kind === "replyAll" ? "Reply all" : "Reply";
}

export function ComposeForm(props: ComposeFormProps) {
  const { store, state, draft, entries, onClose, popped, onTogglePop, proposals, now = Date.now } = props;
  const ui = useContext(MailUiContext);
  const bridge = props.bridge;
  const ai = props.ai ?? null;
  const id = draft.localId;
  const account = entries.find((entry) => entry.account.id === draft.accountId)?.account;
  const ownerName = account?.displayName || account?.address || "You";

  const body = useComposeBody({ store, draft, ownerName, now, proposals });
  const recipients = useRecipients(store, id);
  const editor = useRef<RichEditorHandle>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const pendingTrigger = useRef<SendTrigger | null>(null);
  const aiAbort = useRef<AbortController | null>(null);

  const [signatures] = useState(() => createSignatureStore(bridge));
  const [showCopies, setShowCopies] = useState(draft.draft.cc.length > 0 || draft.draft.bcc.length > 0);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const ownAddresses = useMemo(() => entries.map((entry) => entry.account.address), [entries]);
  const book = useMemo(() => collectKnownAddresses(state.threads, ownAddresses), [state.threads, ownAddresses]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      aiAbort.current?.abort();
    };
  }, []);

  // A fresh draft gets the account's signature once.
  useEffect(() => {
    let live = true;
    void signatures.load().then(() => {
      const latest = store.getSnapshot().drafts[id];
      const text = signatures.get(draft.accountId);
      if (!live || !latest || latest.revision !== 0 || latest.draft.bodyHtml || !text) return;
      body.appendHtml(signatureHtml(text));
    });
    return () => {
      live = false;
    };
    // Runs once per draft; `body` is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatures, store, id, draft.accountId]);

  const changes = body.changes;
  const index = changes.length ? Math.min(Math.max(reviewIndex, 0), changes.length - 1) : -1;
  const current = index >= 0 ? changes[index] : null;
  const composed = composeDraft(draft);
  const busy = draft.sending || sendBusy;

  const doSend = async (trigger: SendTrigger) => {
    setSendBusy(true);
    setNotice(null);
    const outcome = await sendComposedDraft(store, id, trigger);
    if (outcome === "sent") {
      forget(id);
      ui?.notify("Message sent", "success");
      return;
    }
    if (!mounted.current) return;
    setSendBusy(false);
    const after = store.getSnapshot().drafts[id];
    if (outcome === "failed" && !after?.error) setNotice(SEND_FAILED);
  };

  const requestSend = (trigger: SendTrigger) => {
    if (!isExplicitSend(trigger)) return;
    const invalidCount = recipients.flush();
    const latest = store.getSnapshot().drafts[id];
    if (!latest) return;
    const plan = planSend({
      pendingChanges: changes.length,
      invalidRecipients: invalidCount,
      recipientCount: latest.draft.to.length + latest.draft.cc.length + latest.draft.bcc.length,
      issues: draftIssues(composeDraft(latest), { forSend: true }),
      sending: latest.sending || sendBusy,
      attaching,
    });
    if (plan.kind === "blocked") {
      setNotice(SEND_BLOCK_TEXT[plan.reason]);
      return;
    }
    if (plan.kind === "review") {
      pendingTrigger.current = trigger;
      setWarnOpen(true);
      return;
    }
    void doSend(trigger);
  };

  const runAssistant = async (instruction: string) => {
    if (!ai) return;
    aiAbort.current?.abort();
    const controller = new AbortController();
    aiAbort.current = controller;
    setAiBusy(true);
    setAiError(null);
    try {
      const html = await assistantBodyHtml(ai, {
        kind: draft.kind, subject: draft.draft.subject, bodyText: body.finalText, quoteText: draft.quote?.text ?? null, instruction,
      }, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      body.propose(html);
      setReviewIndex(0);
    } catch (failure: unknown) {
      if (!mounted.current) return;
      if (!(isMailAgentError(failure) && failure.code === "cancelled")) setAiError(agentErrorMessage(failure, "ai_failed"));
    } finally {
      if (mounted.current) setAiBusy(false);
    }
  };

  const close = () => {
    const latest = store.getSnapshot().drafts[id];
    const pristine = latest && latest.kind === "new" && !latest.draft.id && !latest.draft.subject.trim()
      && latest.draft.to.length + latest.draft.cc.length + latest.draft.bcc.length === 0 && latest.draft.attachments.length === 0
      && body.changes.length === 0
      && (bare(body.finalText) === "" || bare(body.finalText) === bare(signatures.get(latest.accountId)));
    if (pristine) {
      forget(id);
      void store.discardDraft(id);
      return;
    }
    onClose();
  };

  const title = titleFor(draft.kind);
  const field = (kind: RecipientKind, autoFocus = false) => (
    <RecipientField
      key={kind}
      label={RECIPIENT_LABELS[kind]}
      addresses={draft.draft[kind]}
      invalid={recipients.invalid[kind]}
      text={recipients.text[kind]}
      book={book}
      autoFocus={autoFocus}
      onText={(text) => recipients.setText(kind, text)}
      onCommit={(text, all) => recipients.commit(kind, text, all)}
      onAdd={(address) => recipients.add(kind, address)}
      onRemove={(address) => recipients.remove(kind, address)}
      onRemoveInvalid={(entry) => recipients.removeInvalid(kind, entry)}
    />
  );

  return (
    <section className={popped ? "mail-compose mail-compose--popped" : "mail-compose"} aria-label={title} data-mail-keys="off">
      <header className="mail-compose__header">
        <h2 className="mail-compose__title">{title}</h2>
        <button type="button" className="oui-icon-button" aria-label={popped ? "Dock composer" : "Pop out composer"} title={popped ? "Dock" : "Pop out"} onClick={onTogglePop}>
          {popped ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button type="button" className="oui-icon-button" aria-label="Close draft" title="Close (the draft is kept)" onClick={close}><X size={15} /></button>
      </header>
      <div className="mail-compose__scroll">
        <div className="mail-compose__from">
          <span className="mail-compose__label">From</span>
          <span className="mail-compose__from-address">{account?.address ?? ""}</span>
          <SignatureButton accountId={draft.accountId} signatures={signatures} onInsert={(text) => body.appendHtml(signatureHtml(text))} />
        </div>
        <div className="mail-compose__recipient-row">
          {field("to", draft.kind === "new" || draft.kind === "forward")}
          {!showCopies && <button type="button" className="oui-button oui-button--ghost mail-compose__copies" onClick={() => setShowCopies(true)}>Cc Bcc</button>}
        </div>
        {showCopies && field("cc")}
        {showCopies && field("bcc")}
        <TextField label="Subject" value={draft.draft.subject} onChange={(subject) => store.editDraft(id, { subject })} maxLength={255} />
        <FormatBar
          editor={editor}
          suggesting={body.suggesting}
          onSuggesting={body.setSuggesting}
          linkOpen={linkOpen}
          onLinkOpen={setLinkOpen}
          assistant={ai ? { busy: aiBusy, writing: !body.finalText.trim(), onRun: (text) => void runAssistant(text), onCancel: () => aiAbort.current?.abort() } : null}
        />
        {aiError && <p className="mail-compose__error" role="alert">{aiError}</p>}
        {changes.length > 0 && (
          <div ref={reviewRef} className="mail-compose__review">
            <ReviewBar
              total={changes.length}
              index={index}
              onPrevious={() => setReviewIndex(Math.max(0, index - 1))}
              onNext={() => setReviewIndex(Math.min(changes.length - 1, index + 1))}
              onAccept={() => current && body.accept([current.id])}
              onReject={() => current && body.reject([current.id])}
              onAcceptAll={() => body.accept("all")}
              onRejectAll={() => body.reject("all")}
              busy={busy}
              detail={current ? `${current.kind === "insert" || current.kind === "moveTo" ? "Inserted" : "Deleted"} by ${current.author}` : undefined}
            />
          </div>
        )}
        <RichEditor
          ref={editor}
          label="Message"
          markup={body.markup}
          renderKey={body.renderKey}
          onInput={body.onUserInput}
          onUndo={body.undo}
          onRedo={body.redo}
          onSendShortcut={() => requestSend({ kind: "shortcut" })}
          onLinkShortcut={() => setLinkOpen(true)}
          currentChangeId={current?.id ?? null}
          disabled={busy}
        />
        {draft.quote && (
          <div className="mail-compose__quote-wrap">
            <button type="button" className="oui-button oui-button--ghost mail-compose__quote-toggle" aria-expanded={quoteOpen} onClick={() => setQuoteOpen((open) => !open)}>
              {quoteOpen ? "Hide quoted text" : "Show quoted text"}
            </button>
            {quoteOpen && <pre className="mail-compose__quote" aria-label="Quoted message">{draft.quote.text}</pre>}
          </div>
        )}
        {draft.draft.attachments.length > 0 && (
          <ul className="mail-compose__attachments" aria-label="Attachments">
            {draft.draft.attachments.map((attachment, position) => (
              <li key={`${position}-${attachment.name}`} className="mail-compose__attachment">
                <Paperclip size={13} aria-hidden="true" />
                <span className="mail-compose__attachment-name">{attachment.name}</span>
                <span className="mail-compose__attachment-size">{formatBytes(attachment.size)}</span>
                <button
                  type="button"
                  className="mail-compose__chip-remove"
                  aria-label={`Remove attachment ${attachment.name}`}
                  onClick={() => store.editDraft(id, { attachments: draft.draft.attachments.filter((_, i) => i !== position) })}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {(draft.issues.length > 0 || draft.error || notice) && (
        <ul className="mail-compose__issues" role="alert">
          {draft.issues.map((issue) => <li key={issue}>{ISSUE_TEXT[issue]}</li>)}
          {draft.error && <li>{draft.error.message || SEND_FAILED}</li>}
          {notice && <li>{notice}</li>}
        </ul>
      )}
      <footer className="mail-compose__footer">
        <span className="mail-compose__status" aria-live="polite">
          {busy ? "Sending…" : attaching ? "Attaching…" : draft.saving ? "Saving…" : draft.savedAt ? "Draft saved" : ""}
        </span>
        <button
          type="button"
          className="oui-button oui-button--ghost"
          disabled={!bridge?.files || busy}
          title={bridge?.files ? "Attach a file" : "File access is not available here"}
          onClick={() => setPickerOpen(true)}
        >
          <Paperclip size={14} aria-hidden="true" /> Attach
        </button>
        <button type="button" className="oui-button oui-button--ghost" disabled={busy} onClick={() => setDiscardOpen(true)}>
          <Trash2 size={14} aria-hidden="true" /> Discard
        </button>
        <button type="button" className="oui-button oui-button--primary" disabled={busy} onClick={() => requestSend({ kind: "click" })}>
          <Send size={14} aria-hidden="true" /> Send
        </button>
      </footer>
      {bridge?.files && (
        <AttachmentPicker
          open={pickerOpen}
          files={bridge.files}
          draft={composed}
          onClose={() => setPickerOpen(false)}
          onBusy={setAttaching}
          onAttach={(attachment) => {
            const latest = store.getSnapshot().drafts[id];
            if (latest) store.editDraft(id, { attachments: [...latest.draft.attachments, attachment] });
          }}
        />
      )}
      <SendWarningDialog
        open={warnOpen}
        pending={changes.length}
        busy={busy}
        onCancel={() => setWarnOpen(false)}
        onReview={() => {
          setWarnOpen(false);
          setReviewIndex(0);
          requestAnimationFrame(() => reviewRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
        }}
        onAcceptAllAndSend={() => {
          setWarnOpen(false);
          body.accept("all");
          void doSend(pendingTrigger.current ?? { kind: "click" });
        }}
      />
      <DiscardDialog
        open={discardOpen}
        onCancel={() => setDiscardOpen(false)}
        onDiscard={() => {
          setDiscardOpen(false);
          forget(id);
          void store.discardDraft(id);
        }}
      />
    </section>
  );
}
