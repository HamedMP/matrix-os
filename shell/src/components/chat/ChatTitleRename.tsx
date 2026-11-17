"use client";

import { Ellipsis } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveCanonicalChatAttention, ChatContextMenu, OverflowingChatTitle, ChatImportSourceIcon, chatStartTitle, compactChatStartLabel } from "@matrix-os/ui";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

export interface RenameableConversation {
  canonicalRecord?: import("@matrix-os/ui").ChatNavigationRecord;
  readState?: import("@matrix-os/contracts").CanonicalChatReadState;
  id: string;
  title?: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
}

export function ChatTitleEditor({ title, pending, onCommit, onCancel }: {
  title: string;
  pending: boolean;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const committedRef = useRef(false);
  useEffect(() => {
    if (!pending) committedRef.current = false;
  }, [pending]);
  const commit = () => {
    if (committedRef.current || pending) return;
    const next = value.trim();
    if (!next || next === title) {
      onCancel();
      return;
    }
    committedRef.current = true;
    onCommit(next);
  };
  return (
    <input
      autoFocus
      aria-label={`Rename ${title}`}
      className="min-w-0 w-full rounded border border-primary/45 bg-background px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none focus:ring-2 focus:ring-primary/30"
      disabled={pending}
      maxLength={160}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          committedRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

export function RenameableConversationRow({
  conversation,
  active,
  mobile,
  editing,
  renamePending,
  onToggleRead,
  onSelect,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onArchive,
  onPin, moveItems, projectName,
  nowMs,
}: {
  conversation: RenameableConversation;
  active: boolean;
  mobile: boolean;
  editing: boolean;
  renamePending: boolean;
  onToggleRead?: () => void;
  onSelect: () => void;
  onRenameStart?: () => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onPin?(): void;
  moveItems?: {label:string;onSelect():void}[];
  projectName?: string;
  /** When set, the row shows how long ago the Chat started, as in Project lists. */
  nowMs?: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const selectTimerRef = useRef<number | null>(null);
  const renameTimerRef = useRef<number | null>(null);
  const deleteTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (selectTimerRef.current !== null) window.clearTimeout(selectTimerRef.current);
    if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
    if (deleteTimerRef.current !== null) window.clearTimeout(deleteTimerRef.current);
  }, []);
  const title = conversation.title || conversation.preview || "New chat";
  const attention = conversation.canonicalRecord ? resolveCanonicalChatAttention(conversation.canonicalRecord) : "idle";
  const statusLabel = attention === "approval_required" ? "Approve before sending" : attention === "input_required" ? "Waiting for your reply" : attention === "running" ? "Working…" : attention === "failed" ? "Needs attention" : undefined;
  const startedAt = conversation.canonicalRecord?.chat.createdAt;
  const row = editing ? (
    <div className={`flex w-full items-center px-2.5 ${mobile ? "py-3" : "py-1.5"}`}>
      <ChatTitleEditor title={title} pending={renamePending} onCommit={onRenameCommit} onCancel={onRenameCancel} />
    </div>
  ) : (
    <button
      type="button"
      aria-label={title}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (!onRenameStart || event.detail === 0) {
          onSelect();
          return;
        }
        if (selectTimerRef.current !== null) window.clearTimeout(selectTimerRef.current);
        selectTimerRef.current = window.setTimeout(() => {
          selectTimerRef.current = null;
          onSelect();
        }, 250);
      }}
      onDoubleClick={onRenameStart ? (event) => {
        event.preventDefault();
        if (selectTimerRef.current !== null) window.clearTimeout(selectTimerRef.current);
        selectTimerRef.current = null;
        onRenameStart();
      } : undefined}
      className={`matrix-web-chat-row group flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors ${mobile ? "py-3" : "py-2"} ${
        active ? "bg-accent/50 text-foreground" : "text-foreground/70 hover:bg-accent/30 hover:text-foreground"
      }`}
    >
      {statusLabel ? <span aria-label={`${statusLabel} for ${title}`} className="size-1.5 shrink-0 rounded-full" style={{background:attention === "running" ? "var(--matrix-success, var(--success))" : "var(--matrix-warning, var(--warning))"}}/> : null}
      {conversation.canonicalRecord?.importSource ? <ChatImportSourceIcon harness={conversation.canonicalRecord.importSource.harness}/> : null}
      <span className="matrix-web-chat-title flex min-w-0 flex-1 flex-col"><span className={conversation.readState?.unread ? "flex min-w-0 font-semibold" : "flex min-w-0"}><OverflowingChatTitle title={title}/></span>{statusLabel ? <span className="truncate text-[11px] leading-[14px] text-muted-foreground">{projectName ? `${projectName} · ` : ""}{statusLabel}</span> : null}</span>
      {nowMs !== undefined && startedAt ? <time dateTime={startedAt} title={chatStartTitle(startedAt)} className="matrix-web-chat-row-started">{compactChatStartLabel(startedAt, nowMs)}</time> : null}
      {conversation.readState?.unread ? <span aria-label={`Unread ${title}`} className="size-2 shrink-0 rounded-full bg-primary" /> : null}
    </button>
  );
  if (editing) return row;
  return (
    <div data-chat-title-row className="matrix-web-chat-row-item" data-current={active} data-menu-open={menuOpen}>
    <ChatContextMenu hint={conversation.canonicalRecord?.activeRun ? "Stop the chat first to move, archive or delete it." : undefined} dropdownTrigger={<button type="button" className="matrix-web-chat-row-more" aria-label={`Actions for ${title}`}><Ellipsis aria-hidden="true" size={15} strokeWidth={1.5}/></button>} onDropdownOpenChange={setMenuOpen} chatId={conversation.id} zIndex={SHELL_Z_INDEX.popover} items={[...(onPin ? [{label:conversation.canonicalRecord?.chat.userState?.pinned ? "Unpin" : "Pin",onSelect:onPin}] : []), ...(onRenameStart ? [{
        label: "Rename", onSelect: () => {
          if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
          renameTimerRef.current = window.setTimeout(() => {
            renameTimerRef.current = null;
            onRenameStart();
          }, 0);
        },
    }] : []), ...(moveItems ? [{label:"Move to project",disabled:Boolean(conversation.canonicalRecord?.activeRun),children:moveItems}] : []), ...(onToggleRead ? [{ label: conversation.readState?.unread ? "Mark as read" : "Mark as unread", onSelect: onToggleRead }] : []), ...(onArchive ? [{
        label: "Archive", disabled: Boolean(conversation.canonicalRecord?.activeRun), onSelect: onArchive,
    }] : []), ...(onDelete ? [{
        // Open after the menu closes so the dialog receives focus.
        label: "Delete", danger: true, disabled: Boolean(conversation.canonicalRecord?.activeRun), onSelect: () => {
          if (deleteTimerRef.current !== null) window.clearTimeout(deleteTimerRef.current);
          deleteTimerRef.current = window.setTimeout(() => {
            deleteTimerRef.current = null;
            onDelete();
          }, 0);
        },
    }] : [])]}>{row}</ChatContextMenu>
    </div>
  );
}
