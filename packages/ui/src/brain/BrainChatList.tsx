"use client";

import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { MessageSquarePlus, MoreHorizontal } from "lucide-react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { ChatContextMenu } from "../chat/ChatContextMenu.js";
import { BrainButton, BrainInput } from "./brain-controls.js";
import { brainAgo } from "./brain-format.js";
import { BRAIN_TONE, BRAIN_TYPE } from "./brain-tone.js";
import { BrainAlertText } from "./brain-ui.js";
import type { useBrainThreads } from "./use-brain-threads.js";

/** Rename and delete over the normal Chat routes, through the surface's own chat client. */
export interface BrainChatRowActions {
  /** Sends `record`'s title version; may resolve to the renamed record. */
  readonly rename: (record: CanonicalChatRecord, title: string) => Promise<CanonicalChatRecord | void>;
  readonly remove: (chatId: string) => Promise<void>;
  /** Where the row menu sits above the surface's windows. */
  readonly zIndex?: number;
}

const TITLE_MAX_CHARS = 160;
/** A filled row (12 px corners) when it is the open chat; every row and its More button are 44 px touch targets. */
const ROW = `flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[12px] px-3 text-left ${BRAIN_TYPE.label} `
  + `${BRAIN_TONE.motion} ${BRAIN_TONE.hover} ${BRAIN_TONE.focus} aria-[current=true]:bg-[var(--brain-fill)] `
  + "aria-[current=true]:font-medium";
const MORE = `inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] ${BRAIN_TONE.secondary} `
  + `${BRAIN_TONE.motion} ${BRAIN_TONE.hover} ${BRAIN_TONE.focus}`;

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The chat after a rename the host answered with nothing: the title CAS moved its version on by one. */
function renamedTo(record: CanonicalChatRecord, title: string): CanonicalChatRecord {
  return { ...record, chat: { ...record.chat, title, titleVersion: (record.chat.titleVersion ?? 0) + 1 } };
}

/** Reads a chat again and keeps the server's record over the list; null when it is not listed or cannot be read. */
export type BrainChatReread = (record: CanonicalChatRecord) => Promise<CanonicalChatRecord | null>;

/** One past chat: open it, or rename or delete it from its menu (right click, or the More button). */
function BrainChatRow({ record, current, now, actions, onOpen, onRenamed, onReread, onDeleted }: {
  readonly record: CanonicalChatRecord; readonly current: boolean; readonly now: number;
  readonly actions: BrainChatRowActions | null; readonly onOpen: () => void;
  readonly onRenamed: (renamed: CanonicalChatRecord) => void; readonly onReread: BrainChatReread;
  readonly onDeleted: () => void;
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
      (renamed) => { setBusy(false); onRenamed(renamed ?? renamedTo(record, next)); back(); },
      (error: unknown) => {
        console.warn("[brain] chat rename failed", failureName(error));
        // A chat renamed elsewhere since the list was read refuses this title version: Save stays off until the chat
        // is read again, so a retry sends the version the server has now.
        void onReread(record).then((fresh) => {
          setBusy(false);
          // The rename landed after all (its answer was lost), or the chat was given this name elsewhere.
          if (fresh?.chat.title === next) return back();
          setFailed(fresh !== null && fresh.chat.titleVersion !== record.chat.titleVersion
            ? "The chat was renamed elsewhere. Save again to use this name."
            : "The chat could not be renamed. Try again.");
        });
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
        <form className="flex flex-wrap items-center gap-2" onSubmit={rename}>
          <BrainInput ref={inputRef} name="title" aria-label="Chat name" defaultValue={title} maxLength={TITLE_MAX_CHARS}
            required disabled={busy}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); back(); } }} />
          <BrainButton size="sm" type="submit" disabled={busy}>Save</BrainButton>
          <BrainButton size="sm" variant="ghost" disabled={busy} onClick={back}>Cancel</BrainButton>
        </form>
      ) : mode === "delete" ? (
        <div role="group" aria-label={`Delete ${title}`} className={`grid gap-2 p-3 ${BRAIN_TONE.fill} ${BRAIN_TYPE.label}`}>
          <p>Delete this chat? It goes away on every device.</p>
          <div className="flex flex-wrap gap-2">
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
              <span className={`shrink-0 ${BRAIN_TYPE.footnote} ${BRAIN_TONE.tertiary}`}>
                {brainAgo(record.chat.activityAt ?? record.chat.updatedAt, now)}
              </span>
            </button>
          </ChatContextMenu>
        </div>
      )}
      {failed && <BrainAlertText role="alert" className="px-1">{failed}</BrainAlertText>}
    </li>
  );
}

/**
 * The past brain chats of a project and New chat. On narrow screens it folds behind the Chats button: opening it moves
 * focus to the open chat (or New chat), and Escape closes it.
 */
export function BrainChatList({
  id, shown, threads, items, chatId, projectName, actions, onOpen, onClose, onRenamed, onReread, onDeleted,
}: {
  readonly id: string; readonly shown: boolean; readonly threads: ReturnType<typeof useBrainThreads>;
  readonly items: readonly CanonicalChatRecord[]; readonly chatId: string | null; readonly projectName: string;
  readonly actions: BrainChatRowActions | null; readonly onOpen: (record: CanonicalChatRecord | null) => void;
  readonly onClose: () => void; readonly onRenamed: (renamed: CanonicalChatRecord) => void;
  readonly onReread: BrainChatReread; readonly onDeleted: (chatId: string) => void;
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
        <div role="alert" className="grid gap-2 p-1">
          <BrainAlertText>Past chats could not be loaded.</BrainAlertText>
          <BrainButton size="sm" variant="outline" className="justify-self-start" onClick={threads.reload}>Try again</BrainButton>
        </div>
      )}
      {status === "ready" && items.length === 0 && (
        <p className={`p-1 ${BRAIN_TYPE.caption} ${BRAIN_TONE.secondary}`}>No brain chats for {projectName} yet.</p>
      )}
      {items.length > 0 && (
        <ul aria-label="Past chats" className="grid gap-0.5">
          {items.map((record) => (
            <BrainChatRow key={record.chat.id} record={record} current={record.chat.id === chatId} now={now}
              actions={actions} onOpen={() => onOpen(record)}
              onRenamed={onRenamed} onReread={onReread}
              onDeleted={() => {
                onDeleted(record.chat.id);
                // The row goes away; focus moves to New chat unless the viewer moved it out of the list meanwhile.
                const focused = document.activeElement;
                if (focused === null || focused === document.body || container.current?.contains(focused)) {
                  newChat.current?.focus();
                }
              }} />
          ))}
        </ul>
      )}
      {threads.nextCursor !== null && (
        <BrainButton size="sm" variant="ghost" className="justify-self-start" disabled={threads.loadingMore}
          onClick={threads.loadMore}>
          {threads.loadingMore ? "Loading..." : "Show more"}
        </BrainButton>
      )}
      {threads.moreError && <BrainAlertText role="alert" className="p-1">More chats could not be loaded.</BrainAlertText>}
    </div>
  );
}
