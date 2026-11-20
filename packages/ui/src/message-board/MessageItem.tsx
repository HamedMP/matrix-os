"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Edit02Icon, Robot01Icon, SmileIcon, UserIcon, WorkflowSquare03Icon, AiBeautifyIcon, Notification03Icon } from "@hugeicons/core-free-icons";
import { POPOVER_LAYER } from "../layering.js";
import { BoardComposer } from "./BoardComposer.js";
import { BoardMarkdown } from "./BoardMarkdown.js";
import { actorLabel } from "./model.js";
import { formatBoardTime, subtleBorder, textPrimary, textSecondary, textTertiary } from "./presentation.js";
import { BoardButton } from "./controls.js";
import type { BoardActor, BoardActorKind, BoardMessage } from "./types.js";
import type { MutationResult } from "./use-message-board.js";

const QUICK_REACTIONS = ["👍", "👀", "🎉", "✅", "❤️", "🚀"] as const;

const KIND_ICON = { user: UserIcon, agent: Robot01Icon, bot: AiBeautifyIcon, watcher: WorkflowSquare03Icon, system: Notification03Icon } as const satisfies Record<BoardActorKind, unknown>;
const KIND_LABEL: Record<BoardActorKind, string | null> = { user: null, agent: "Agent", bot: "Bot", watcher: "Watcher", system: "System" };

export interface MessageItemProps {
  message: BoardMessage;
  viewerId: string;
  actors: readonly BoardActor[];
  nowMs: number;
  isRoot?: boolean;
  onReact(emoji: string, on: boolean): Promise<MutationResult>;
  /** `revision` is the one the editor opened on, so a newer edit elsewhere is a conflict, not overwritten. */
  onEdit(text: string, revision: number): Promise<MutationResult>;
  onDelete(): Promise<MutationResult>;
}

export function MessageItem({ message, viewerId, actors, nowMs, isRoot, onReact, onEdit, onDelete }: MessageItemProps) {
  // The revision the editor opened on; null while not editing.
  const [editRevision, setEditRevision] = useState<number | null>(null);
  const editing = editRevision !== null;
  const setEditing = (open: boolean) => setEditRevision(open ? message.revision : null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = message.by.id === viewerId;
  const deleted = Boolean(message.deletedAt);
  const kindLabel = KIND_LABEL[message.by.kind];

  const run = async (work: () => Promise<MutationResult>) => {
    setError(null);
    const result = await work();
    if (!result.ok) setError(result.error);
    return result;
  };

  return <article aria-label={`${actorLabel(message.by, viewerId)}, ${formatBoardTime(message.createdAt, nowMs)}`}
    className={`group/message relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 rounded-lg px-2 py-2${isRoot ? "" : " hover:bg-[var(--bg-hover,rgba(0,0,0,0.03))]"}`}>
    <span aria-hidden className="mt-0.5 grid size-7 place-items-center rounded-full" style={{ background: "var(--bg-sunken, var(--muted))", ...textSecondary }}>
      <HugeiconsIcon icon={KIND_ICON[message.by.kind]} size={14} strokeWidth={1.75} />
    </span>
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[13px] font-semibold" style={textPrimary}>{actorLabel(message.by, viewerId)}</span>
        {kindLabel ? <span className="rounded px-1 text-[10.5px] font-medium" style={{ ...textTertiary, border: "1px solid var(--border-subtle, var(--border))" }}>{kindLabel}</span> : null}
        <time dateTime={message.createdAt} className="text-xs" style={textTertiary}>{formatBoardTime(message.createdAt, nowMs)}</time>
        {message.editedAt && !deleted ? <span className="text-xs" style={textTertiary}>(edited)</span> : null}
      </div>
      {deleted ? <p className="mt-0.5 text-[13px] italic" style={textTertiary}>This message was deleted.</p>
        : editing ? <div className="mt-1">
            <BoardComposer label="Edit message" placeholder="Edit message" submitLabel="Save" actors={actors} viewerId={viewerId}
              initialText={message.text} autoFocus onCancel={() => setEditing(false)}
              onSubmit={async (text) => { const result = await onEdit(text, editRevision ?? message.revision); if (result.ok) setEditing(false); return result; }} />
          </div>
        : <div className="mt-0.5"><BoardMarkdown text={message.text} /></div>}
      {!deleted && !editing ? <Reactions message={message} viewerId={viewerId} actors={actors} onToggle={(emoji, on) => void run(() => onReact(emoji, on))} /> : null}
      {confirmDelete ? <div role="group" aria-label="Confirm delete" className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px]" style={subtleBorder}>
        <span style={textSecondary}>Delete this message? Replies stay in place.</span>
        <BoardButton look="plain" autoFocus className="rounded-md px-2 py-0.5 font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]" style={{ color: "var(--danger-text)" }}
          onClick={async () => { await run(onDelete); setConfirmDelete(false); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setConfirmDelete(false); } }}>Delete</BoardButton>
        <BoardButton look="plain" className="rounded-md px-2 py-0.5 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]" style={textSecondary} onClick={() => setConfirmDelete(false)}>Cancel</BoardButton>
      </div> : null}
      {error ? <p role="alert" className="pt-1 text-xs" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
    </div>
    {own && !deleted && !editing && !confirmDelete ? <div className="absolute right-1.5 top-1.5 flex gap-0.5 rounded-lg border opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100"
      style={{ ...subtleBorder, background: "var(--bg-surface, var(--card))" }}>
      <BoardButton look="icon" aria-label="Edit message" onClick={() => setEditing(true)}>
        <HugeiconsIcon icon={Edit02Icon} size={14} aria-hidden style={textSecondary} />
      </BoardButton>
      <BoardButton look="icon" aria-label="Delete message" onClick={() => setConfirmDelete(true)}>
        <HugeiconsIcon icon={Delete02Icon} size={14} aria-hidden style={{ color: "var(--danger-text)" }} />
      </BoardButton>
    </div> : null}
  </article>;
}

function Reactions({ message, viewerId, actors, onToggle }: {
  message: BoardMessage; viewerId: string; actors: readonly BoardActor[]; onToggle(emoji: string, on: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const nameOf = (id: string) => (id === viewerId ? "You" : actors.find((actor) => actor.id === id)?.profile ?? actors.find((actor) => actor.id === id)?.name ?? id);
  return <div className="mt-1 flex flex-wrap items-center gap-1">
    {message.reactions.map((reaction) => {
      const mine = reaction.actors.includes(viewerId);
      return <BoardButton look="plain" key={reaction.emoji} type="button" aria-pressed={mine} title={reaction.actors.map(nameOf).join(", ")}
        aria-label={`${reaction.emoji} ${reaction.actors.length}, ${mine ? "remove your reaction" : "react"}`}
        onClick={() => onToggle(reaction.emoji, !mine)}
        className="inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))] aria-pressed:border-[var(--composer-focus,var(--primary,currentColor))]"
        style={{ ...subtleBorder, ...textSecondary }}>
        <span aria-hidden>{reaction.emoji}</span>{reaction.actors.length}
      </BoardButton>;
    })}
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <BoardButton look="icon" aria-label="Add reaction"
          className="size-6 opacity-60 group-hover/message:opacity-100" style={textTertiary}>
          <HugeiconsIcon icon={SmileIcon} size={14} aria-hidden />
        </BoardButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} aria-label="Reactions"
          className="flex gap-0.5 rounded-xl border p-1 shadow-lg" style={{ zIndex: POPOVER_LAYER, borderColor: "var(--border-default, var(--border))", background: "var(--bg-overlay, var(--popover))" }}>
          {QUICK_REACTIONS.map((emoji) => {
            const mine = message.reactions.some((reaction) => reaction.emoji === emoji && reaction.actors.includes(viewerId));
            return <BoardButton look="plain" key={emoji} type="button" aria-label={`React with ${emoji}`} aria-pressed={mine}
              className="grid size-8 place-items-center rounded-lg text-base outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))] aria-pressed:bg-[var(--bg-selected,var(--bg-hover))]"
              onClick={() => { onToggle(emoji, !mine); setOpen(false); }}>{emoji}</BoardButton>;
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>;
}
