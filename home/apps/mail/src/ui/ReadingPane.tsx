/**
 * The reading pane: the open conversation with its actions. Earlier messages
 * start collapsed and the latest is expanded. Replying opens a draft in the
 * composer; nothing here sends mail.
 */
import { useState } from "react";
import { AlertCircle, Archive, Flag, FlagOff, Forward, Mail, MailOpen, Reply, ReplyAll, Trash2, X } from "lucide-react";
import { EmptyState, Skeleton, Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../../../_shared/office-ui";
import type { MailThread } from "../../../_shared/office-accounts/types/mail";
import type { DraftKind, MailState, ThreadKey } from "../model";
import { useMailUi } from "./context";
import { MessageCard } from "./MessageCard";

function Conversation({ thread, threadKey, flagged }: { thread: MailThread; threadKey: ThreadKey; flagged: boolean }) {
  const { store, entries } = useMailUi();
  const provider = entries.find((entry) => entry.account.id === thread.accountId)?.provider;
  const latest = thread.messages[thread.messages.length - 1];
  const [expanded, setExpanded] = useState<readonly string[]>(() => (latest ? [latest.id] : []));
  const keys = [threadKey];
  const respond = (kind: Exclude<DraftKind, "new">) => void store.respond(kind, { key: threadKey, messageId: latest?.id });
  const toggle = (id: string) => setExpanded((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const subject = thread.subject.trim() || "(no subject)";

  return (
    <div className="mail-reading">
      <Toolbar label="Conversation actions" className="mail-reading__toolbar">
        <ToolbarGroup label="Respond">
          <ToolbarButton label="Reply" icon={<Reply size={15} />} shortcut="R" onClick={() => respond("reply")} />
          <ToolbarButton label="Reply all" icon={<ReplyAll size={15} />} shortcut="A" onClick={() => respond("replyAll")} />
          <ToolbarButton label="Forward" icon={<Forward size={15} />} shortcut="F" onClick={() => respond("forward")} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Triage">
          <ToolbarButton label="Archive" icon={<Archive size={15} />} shortcut="E" onClick={() => void store.archive(keys)} />
          <ToolbarButton label="Move to trash" icon={<Trash2 size={15} />} shortcut="#" onClick={() => void store.trash(keys)} />
          <ToolbarButton
            label={flagged ? "Unflag" : "Flag"}
            icon={flagged ? <FlagOff size={15} /> : <Flag size={15} />}
            pressed={flagged}
            shortcut="S"
            onClick={() => void store.setFlag(!flagged, keys)}
          />
          <ToolbarButton label="Mark as unread" icon={<MailOpen size={15} />} shortcut="Shift+U" onClick={() => void store.markRead(false, keys)} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarButton label="Close conversation" icon={<X size={15} />} shortcut="Esc" onClick={() => store.closeThread()} />
      </Toolbar>
      <div className="mail-reading__scroll">
        <h2 className="mail-reading__subject">{subject}</h2>
        <div className="mail-reading__messages">
          {thread.messages.map((message) => (
            <MessageCard
              key={message.id}
              message={message}
              provider={provider}
              expanded={expanded.includes(message.id)}
              onToggle={() => toggle(message.id)}
            />
          ))}
        </div>
        <div className="mail-reading__respond">
          <button type="button" className="oui-button" onClick={() => respond("reply")}><Reply size={14} aria-hidden="true" /> Reply</button>
          <button type="button" className="oui-button" onClick={() => respond("replyAll")}><ReplyAll size={14} aria-hidden="true" /> Reply all</button>
          <button type="button" className="oui-button" onClick={() => respond("forward")}><Forward size={14} aria-hidden="true" /> Forward</button>
        </div>
      </div>
    </div>
  );
}

function ReadingSkeleton() {
  return (
    <div className="mail-reading mail-reading--loading" aria-busy="true" aria-label="Loading conversation">
      <div className="mail-reading__scroll">
        <Skeleton width="55%" height={20} />
        <div className="mail-reading__skeleton-card"><Skeleton lines={2} /><Skeleton lines={6} /></div>
      </div>
    </div>
  );
}

export function ReadingPane({ state }: { state: MailState }) {
  const { store } = useMailUi();
  const open = state.openThread;
  if (!open) {
    const count = state.selection.keys.length;
    return (
      <div className="mail-reading mail-reading--empty">
        <EmptyState
          icon={<Mail />}
          headline={count > 0 ? `${count} selected` : "No conversation open"}
          description={count > 0 ? "Use the actions above the list, or drag the conversations onto a folder." : "Choose a conversation to read it here. Press ? for keyboard shortcuts."}
        />
      </div>
    );
  }
  if (open.thread) {
    return (
      <div className="mail-reading-wrap">
        {open.error && (
          <div className="mail-pane-error" role="alert">
            <AlertCircle size={14} aria-hidden="true" />
            <span>{open.error.message} Showing the saved copy.</span>
            <button type="button" className="oui-button oui-button--ghost" onClick={() => void store.openThread(open.key)}>Retry</button>
          </div>
        )}
        <Conversation key={open.key} thread={open.thread} threadKey={open.key} flagged={state.threads[open.key]?.flagged ?? false} />
      </div>
    );
  }
  if (open.status === "error") {
    return (
      <div className="mail-reading mail-reading--empty" role="alert">
        <EmptyState
          icon={<AlertCircle />}
          headline="This conversation could not be opened"
          description={open.error?.message}
          action={{ label: "Try again", onClick: () => void store.openThread(open.key) }}
          secondaryAction={{ label: "Close", onClick: () => store.closeThread() }}
        />
      </div>
    );
  }
  return <ReadingSkeleton />;
}
