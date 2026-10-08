"use client";

import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { MessageSquarePlus, MoreHorizontal } from "lucide-react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { ChatContextMenu } from "../chat/ChatContextMenu.js";
import { BrainButton, BrainInput } from "./brain-controls.js";
import { brainAgo } from "./brain-format.js";
import { BRAIN_TONE } from "./brain-tone.js";
import type { useBrainThreads } from "./use-brain-threads.js";

/** Rename and delete over the normal Chat routes, through the surface's own chat client. */
export interface BrainChatRowActions {
  readonly rename: (record: CanonicalChatRecord, title: string) => Promise<void>;
  readonly remove: (chatId: string) => Promise<void>;
  /** Where the row menu sits above the surface's windows. */
  readonly zIndex?: number;
}

const TITLE_MAX_CHARS = 160;
const ROW = `flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm @2xl:min-h-9 ${BRAIN_TONE.hover} ${BRAIN_TONE.focus} aria-[current=true]:bg-[var(--bg-selected,var(--muted))] aria-[current=true]:font-medium`;
const MORE = `inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground @2xl:size-8 ${BRAIN_TONE.hover} ${BRAIN_TONE.focus}`;

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One past chat: open it, or rename or delete it from its menu (right click, or the More button). */
function BrainChatRow({ record, current, now, actions, onOpen, onRenamed, onDeleted }: {
  readonly record: CanonicalChatRecord; readonly current: boolean; readonly now: number;
  readonly actions: BrainChatRowActions | null; readonly onOpen: () => void;
  readonly onRenamed: (title: string) => void; readonly onDeleted: () => void;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const { title } = record.chat;
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
    else if (mode === "delete") confirmRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      rowRef.current?.focus();
    }
  }, [mode]);
  const back = () => {
    returnFocus.current = true;
    setFailed(null);
    setMode("view");
  };
  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (!actions || next === "" || next === title) return back();
    setBusy(true);
    actions.rename(record, next).then(
      () => { setBusy(false); onRenamed(next); back(); },
      (error: unknown) => {
        console.warn("[brain] chat rename failed", failureName(error));
        setBusy(false);
        setFailed("The chat could not be renamed. Try again.");
      },
    );
  };
  const remove = () => {
    if (!actions) return;
    setBusy(true);
    actions.remove(record.chat.id).then(
      () => { setBusy(false); onDeleted(); },
      (error: unknown) => {
        console.warn("[brain] chat delete failed", failureName(error));
        setBusy(false);
        setFailed("The chat could not be deleted. Try again.");
      },
    );
  };
  return (
    <li className="grid gap-1">
      {mode === "rename" ? (
        <form className="flex items-center gap-1" onSubmit={rename}>
          <BrainInput ref={inputRef} name="title" aria-label="Chat name" defaultValue={title} maxLength={TITLE_MAX_CHARS}
            required disabled={busy} className="h-8"
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); back(); } }} />
          <BrainButton size="sm" type="submit" disabled={busy}>Save</BrainButton>
          <BrainButton size="sm" variant="ghost" disabled={busy} onClick={back}>Cancel</BrainButton>
        </form>
      ) : mode === "delete" ? (
        <div role="group" aria-label={`Delete ${title}`} className={`grid gap-2 rounded-md border p-2 text-xs ${BRAIN_TONE.border}`}>
          <p>Delete this chat? It goes away on every device.</p>
          <div className="flex gap-1">
            <BrainButton ref={confirmRef} size="sm" variant="destructive" disabled={busy} onClick={remove}>Delete</BrainButton>
            <BrainButton size="sm" variant="ghost" disabled={busy} onClick={back}>Cancel</BrainButton>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-0.5">
          <ChatContextMenu chatId={record.chat.id} zIndex={actions?.zIndex}
            items={actions ? [
              { label: "Rename", onSelect: () => setMode("rename") },
              { label: "Delete", danger: true, onSelect: () => setMode("delete") },
            ] : []}
            dropdownTrigger={actions ? (
              <button type="button" aria-label={`More for ${title}`} className={MORE}>
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            ) : undefined}>
            <button ref={rowRef} type="button" className={ROW} aria-current={current} onClick={onOpen}>
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {brainAgo(record.chat.activityAt ?? record.chat.updatedAt, now)}
              </span>
            </button>
          </ChatContextMenu>
        </div>
      )}
      {failed && <p role="alert" className="px-1 text-xs">{failed}</p>}
    </li>
  );
}

/**
 * The past brain chats of a project and New chat. On narrow screens it folds behind the Chats button: opening it moves
 * focus to the open chat (or New chat), and Escape closes it.
 */
export function BrainChatList({
  id, shown, threads, items, chatId, projectName, actions, onOpen, onClose, onRenamed, onDeleted,
}: {
  readonly id: string; readonly shown: boolean; readonly threads: ReturnType<typeof useBrainThreads>;
  readonly items: readonly CanonicalChatRecord[]; readonly chatId: string | null; readonly projectName: string;
  readonly actions: BrainChatRowActions | null; readonly onOpen: (record: CanonicalChatRecord | null) => void;
  readonly onClose: () => void; readonly onRenamed: (chatId: string, title: string) => void;
  readonly onDeleted: (chatId: string) => void;
}) {
  const status = threads.first.state.status;
  const now = Date.now();
  const container = useRef<HTMLDivElement>(null);
  const newChat = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const node = container.current;
    if (!shown || node === null) return;
    (node.querySelector<HTMLElement>("[aria-current='true']") ?? newChat.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Escape in the rename field cancels the rename only.
      if (event.key !== "Escape" || event.target instanceof HTMLInputElement) return;
      event.stopPropagation();
      close();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [shown]);
  return (
    <div ref={container} id={id} className={`${shown ? "grid" : "hidden"} max-h-[50vh] content-start gap-2 overflow-auto border-b p-2 @2xl:grid @2xl:max-h-none @2xl:border-r @2xl:border-b-0 ${BRAIN_TONE.border}`}>
      <BrainButton ref={newChat} variant="outline" size="sm" className="justify-start" onClick={() => onOpen(null)}>
        <MessageSquarePlus className="size-4" aria-hidden="true" />
        New chat
      </BrainButton>
      {status === "error" && (
        <div role="alert" className="grid gap-2 p-1 text-xs">
          <p>Past chats could not be loaded.</p>
          <BrainButton size="sm" variant="outline" className="justify-self-start" onClick={threads.reload}>Try again</BrainButton>
        </div>
      )}
      {status === "ready" && items.length === 0 && (
        <p className="p-1 text-xs text-muted-foreground">No brain chats for {projectName} yet.</p>
      )}
      {items.length > 0 && (
        <ul aria-label="Past chats" className="grid gap-0.5">
          {items.map((record) => (
            <BrainChatRow key={record.chat.id} record={record} current={record.chat.id === chatId} now={now}
              actions={actions} onOpen={() => onOpen(record)}
              onRenamed={(title) => onRenamed(record.chat.id, title)}
              onDeleted={() => { onDeleted(record.chat.id); newChat.current?.focus(); }} />
          ))}
        </ul>
      )}
      {threads.nextCursor !== null && (
        <BrainButton size="sm" variant="ghost" className="justify-self-start" disabled={threads.loadingMore}
          onClick={threads.loadMore}>
          {threads.loadingMore ? "Loading..." : "Show more"}
        </BrainButton>
      )}
      {threads.moreError && <p role="alert" className="p-1 text-xs">More chats could not be loaded.</p>}
    </div>
  );
}
