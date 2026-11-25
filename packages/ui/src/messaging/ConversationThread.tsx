import type { KeyboardEvent } from "react";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { MESSAGING_BRIDGE_MESSAGE_BODY_MAX, type MessagingBridgeConversation } from "@matrix-os/contracts/messaging-bridge";
import { Badge } from "../Badge.js";
import { Button } from "../Button.js";
import { formatMessageTime, networkLabel, threadBubbleView, type PendingSend, type ThreadEntry } from "./bridge-view.js";
import { chatAppsStyles as s } from "./chat-apps-styles.js";

export interface ThreadViewState {
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  hasOlder: boolean;
}

export interface ConversationThreadProps {
  conversation: MessagingBridgeConversation;
  entries: ThreadEntry[];
  view: ThreadViewState;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onRetry: (pending: PendingSend) => void;
  onBack: () => void;
  onLoadOlder: () => void;
  onReload: () => void;
}

const DELIVERY_COPY = { sending: "Sending…", sent: "Sent", failed: "Failed" } as const;

export function ConversationThread(props: ConversationThreadProps) {
  const { conversation, entries, view, draft } = props;
  const canSend = draft.trim().length > 0 && draft.length <= MESSAGING_BRIDGE_MESSAGE_BODY_MAX;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) props.onSend();
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ ...s.row, justifyContent: "flex-start" }}>
        <Button variant="ghost" size="sm" onClick={props.onBack} aria-label="Back to conversations">
          <ArrowLeft size={16} aria-hidden="true" /> Back
        </Button>
        <h4 style={{ margin: 0, fontSize: "0.9375rem", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {conversation.displayName}
        </h4>
        <Badge>{networkLabel(conversation.network)}</Badge>
      </div>
      <div
        role="log"
        aria-label={`Messages with ${conversation.displayName}`}
        aria-busy={view.loading}
        style={{ ...s.card, height: 360, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column-reverse", gap: 8 }}
      >
        {[...entries].reverse().map((entry) => <ThreadBubble key={entry.key} entry={entry} onRetry={props.onRetry} />)}
        {entries.length === 0 && view.loading ? <p role="status" style={{ ...s.muted, margin: "auto" }}>Loading messages…</p> : null}
        {entries.length === 0 && !view.loading && !view.error ? (
          <div style={{ ...s.empty, margin: "auto" }}>
            <MessageSquare size={20} aria-hidden="true" />
            <p style={{ ...s.body, fontWeight: 600 }}>No messages yet</p>
            <p style={s.muted}>Send a message below to start the conversation.</p>
          </div>
        ) : null}
        {view.error ? (
          <div role="alert" style={s.alert}>
            <span>{view.error}</span>
            <Button variant="secondary" size="sm" onClick={props.onReload}>Try again</Button>
          </div>
        ) : null}
        {view.hasOlder ? (
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Button variant="ghost" size="sm" onClick={props.onLoadOlder} disabled={view.loadingOlder}>
              {view.loadingOlder ? "Loading…" : "Load older messages"}
            </Button>
          </div>
        ) : null}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) props.onSend();
        }}
        style={{ display: "flex", gap: 8, alignItems: "flex-end" }}
      >
        <label htmlFor="chat-app-composer" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Message {conversation.displayName}
        </label>
        <textarea
          id="chat-app-composer"
          value={draft}
          maxLength={MESSAGING_BRIDGE_MESSAGE_BODY_MAX}
          rows={2}
          placeholder={`Message on ${networkLabel(conversation.network)}`}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          style={s.textarea}
        />
        <Button type="submit" disabled={!canSend}>Send</Button>
      </form>
    </div>
  );
}

const OUTGOING_BUBBLE = { side: "flex-end", background: "var(--matrix-primary)", color: "var(--matrix-primary-fg)" } as const;
const INCOMING_BUBBLE = { side: "flex-start", background: "var(--matrix-muted, var(--muted))", color: "var(--matrix-fg, var(--foreground))" } as const;

function ThreadBubble({ entry, onRetry }: { entry: ThreadEntry; onRetry: (pending: PendingSend) => void }) {
  const bubble = threadBubbleView(entry);
  const look = bubble.outgoing ? OUTGOING_BUBBLE : INCOMING_BUBBLE;
  const retry = bubble.retry;
  return (
    <div
      data-direction={bubble.outgoing ? "outgoing" : "incoming"}
      style={{ alignSelf: look.side, maxWidth: "80%", display: "flex", flexDirection: "column", alignItems: look.side, gap: 2 }}
    >
      {bubble.sender ? <span style={s.muted}>{bubble.sender}</span> : null}
      <p
        style={{
          ...s.body,
          padding: "8px 12px",
          borderRadius: "var(--matrix-radius-lg, 12px)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          background: look.background,
          color: look.color,
          fontStyle: bubble.placeholder ? "italic" : undefined,
        }}
      >
        {bubble.body}
      </p>
      <span style={{ ...s.muted, fontSize: "0.75rem", display: "flex", gap: 6, alignItems: "center" }}>
        {formatMessageTime(bubble.time)}
        {bubble.delivery ? <span>{DELIVERY_COPY[bubble.delivery]}</span> : null}
        {retry ? (
          <Button variant="ghost" size="sm" onClick={() => onRetry(retry)} style={{ padding: "2px 6px" }}>Retry</Button>
        ) : null}
      </span>
    </div>
  );
}
