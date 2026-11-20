"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowLeft01Icon, Cancel01Icon, CheckListIcon } from "@hugeicons/core-free-icons";
import type { MessageBoardClient } from "./client.js";
import { BoardComposer } from "./BoardComposer.js";
import { MessageItem } from "./MessageItem.js";
import { isReservedLabelKey, parseLabelInput, threadTitle } from "./model.js";
import { actionButtonClass, chipClass, fieldClass, iconButtonClass, subtleBorder, textPrimary, textSecondary, textTertiary } from "./presentation.js";
import { TaskPanel } from "./TaskPanel.js";
import { LabelChip, TaskStateChip } from "./TaskStateChip.js";
import type { BoardActor, BoardMessage, BoardThread } from "./types.js";
import type { MutationResult, Resource } from "./use-message-board.js";

export interface ThreadViewProps {
  thread: Resource<BoardThread>;
  viewerId: string;
  actors: readonly BoardActor[];
  nowMs: number;
  mutate(work: (client: MessageBoardClient, board: string) => Promise<unknown>): Promise<MutationResult>;
  onOpenThread(id: string): void;
  onBack?: () => void;
  onClose?: () => void;
  onRetry(): void;
}

/** Right pane: the root, its labels and task, the replies, and a reply composer. */
export function ThreadView({ thread, viewerId, actors, nowMs, mutate, onOpenThread, onBack, onClose, onRetry }: ThreadViewProps) {
  const data = thread.data;
  const end = useRef<HTMLDivElement>(null);
  const replyCount = data?.replies.length ?? 0;
  const rootId = data?.root.id;
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [rootId, replyCount]);

  if (!data) {
    return <div className="grid h-full place-items-center px-6 text-center text-[13px]" style={textTertiary}>
      {thread.status === "error"
        ? <div role="alert"><p>{thread.error}</p><button type="button" className={`${chipClass} mt-2`} onClick={onRetry}>Try again</button></div>
        : <p role="status">Loading thread…</p>}
    </div>;
  }

  const { root, replies, task, needs } = data;
  const profiles = [...new Set(actors.flatMap((actor) => (actor.profile ? [actor.profile] : [])))].sort();
  const messageHandlers = (message: BoardMessage) => ({
    onReact: (emoji: string, on: boolean) => mutate((client, board) => client.react(board, message.id, emoji, on)),
    onEdit: (text: string) => mutate((client, board) => client.edit(board, message.id, text, message.revision)),
    onDelete: () => mutate((client, board) => client.remove(board, message.id)),
  });

  return <section aria-label="Thread" className="flex h-full min-h-0 flex-col">
    <header className="flex items-start gap-2 border-b px-3 pb-2 pt-2.5" style={subtleBorder}>
      {onBack ? <button type="button" aria-label="Back to threads" className={iconButtonClass} onClick={onBack}>
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
      </button> : null}
      <div className="min-w-0 flex-1">
        <h2 className={`truncate text-[15px] font-semibold${root.deletedAt ? " italic" : ""}`} style={root.deletedAt ? textTertiary : textPrimary}>
          {threadTitle(root.text, Boolean(root.deletedAt))}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs" style={textTertiary}>
          <span className="font-mono">#{root.channel}</span>
          {task ? <TaskStateChip state={task.state} /> : null}
          <span>{replies.length} {replies.length === 1 ? "reply" : "replies"}</span>
        </p>
        <LabelEditor labels={root.labels} onChange={(patch) => mutate((client, board) => client.label(board, root.id, patch))} />
      </div>
      {onClose ? <button type="button" aria-label="Close thread" className={iconButtonClass} onClick={onClose}>
        <HugeiconsIcon icon={Cancel01Icon} size={15} aria-hidden style={textTertiary} />
      </button> : null}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-2">
      {task
        ? <TaskPanel taskId={root.id} task={task} needs={needs} viewerId={viewerId} profiles={profiles} nowMs={nowMs} mutate={mutate} onOpenThread={onOpenThread} />
        : !root.deletedAt ? <div className="mx-3 mb-2">
            <button type="button" className={actionButtonClass} style={{ ...subtleBorder, ...textSecondary }}
              onClick={() => void mutate((client, board) => client.createTask(board, root.id))}>
              <HugeiconsIcon icon={CheckListIcon} size={14} aria-hidden /> Make this a task
            </button>
          </div> : null}
      <div className="px-1">
        <MessageItem message={root} viewerId={viewerId} actors={actors} nowMs={nowMs} isRoot {...messageHandlers(root)} />
      </div>
      {replies.length > 0 ? <div className="mx-3 my-1 border-t" style={subtleBorder} /> : null}
      <ol aria-label="Replies" className="px-1">
        {replies.map((reply) => <li key={reply.id}>
          <MessageItem message={reply} viewerId={viewerId} actors={actors} nowMs={nowMs} {...messageHandlers(reply)} />
        </li>)}
      </ol>
      <div ref={end} />
    </div>
    <div className="border-t px-3 pb-3 pt-2" style={subtleBorder}>
      <BoardComposer key={root.id} label="Reply" placeholder="Reply… use @ to mention" submitLabel="Reply" actors={actors} viewerId={viewerId}
        onSubmit={(text) => mutate((client, board) => client.reply(board, root.id, { text }))} />
    </div>
  </section>;
}

function LabelEditor({ labels, onChange }: {
  labels: Readonly<Record<string, string>>;
  onChange(patch: { set?: Record<string, string>; unset?: string[] }): Promise<MutationResult>;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const entries = Object.entries(labels);
  const submit = async () => {
    const parsed = parseLabelInput(value);
    if (!parsed.ok) {
      setError(parsed.reason === "reserved" ? "board. and matrix. labels are set by Matrix OS." : "Use key=value, lowercase key.");
      return;
    }
    const result = await onChange({ set: { [parsed.key]: parsed.value } });
    if (result.ok) { setValue(""); setAdding(false); setError(null); } else setError(result.error);
  };
  return <div className="mt-1.5 flex flex-wrap items-center gap-1">
    {entries.map(([key, label]) => <LabelChip key={key} name={key} value={label}
      onRemove={isReservedLabelKey(key) ? undefined : () => void onChange({ unset: [key] })} />)}
    {adding
      ? <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input autoFocus aria-label="New label (key=value)" placeholder="key=value" value={value} maxLength={330}
            onChange={(event) => { setValue(event.currentTarget.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setAdding(false); setError(null); } }}
            className={`${fieldClass} h-6 w-36 font-mono text-[11px]`} style={{ ...subtleBorder, ...textPrimary }} />
        </form>
      : <button type="button" aria-label="Add label" onClick={() => setAdding(true)}
          className="inline-flex h-5 items-center gap-0.5 rounded-md px-1 text-[11px] outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]" style={textTertiary}>
          <HugeiconsIcon icon={Add01Icon} size={11} aria-hidden /> Label
        </button>}
    {error ? <span role="alert" className="w-full text-[11px]" style={{ color: "var(--danger-text)" }}>{error}</span> : null}
  </div>;
}
