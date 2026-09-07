"use client";

import { useEffect, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export interface RenameableConversation {
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
  onSelect,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
}: {
  conversation: RenameableConversation;
  active: boolean;
  mobile: boolean;
  editing: boolean;
  renamePending: boolean;
  onSelect: () => void;
  onRenameStart?: () => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
}) {
  const selectTimerRef = useRef<number | null>(null);
  const renameTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (selectTimerRef.current !== null) window.clearTimeout(selectTimerRef.current);
    if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
  }, []);
  const title = conversation.title || conversation.preview || "New chat";
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
      className={`group flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors ${mobile ? "py-3" : "py-2"} ${
        active ? "bg-accent/50 text-foreground" : "text-foreground/70 hover:bg-accent/30 hover:text-foreground"
      }`}
    >
      <span className="flex-1 truncate">{title.slice(0, 40) + (title.length > 40 ? "..." : "")}</span>
    </button>
  );
  if (!onRenameStart || editing) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => {
          if (renameTimerRef.current !== null) window.clearTimeout(renameTimerRef.current);
          renameTimerRef.current = window.setTimeout(() => {
            renameTimerRef.current = null;
            onRenameStart();
          }, 0);
        }}>
          Rename
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
