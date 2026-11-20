"use client";

import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowLeft01Icon, Search01Icon, SearchRemoveIcon, Tag01Icon } from "@hugeicons/core-free-icons";
import { POPOVER_LAYER } from "../layering.js";
import { ChatComposerSelect } from "../chat/composer/ChatComposerSelect.js";
import {
  actorLabel, formatLeaseCountdown, groupTasksByState, parseLabelFilter, sortThreadsByActivity,
  TASK_QUEUE_ORDER, TASK_STATE_LABELS, threadTitle,
} from "./model.js";
import { fieldClass, formatBoardTime, rowClass, subtleBorder, textPrimary, textSecondary, textTertiary } from "./presentation.js";
import { LabelChip, TaskStateChip } from "./TaskStateChip.js";
import type { BoardActor, BoardTaskState, BoardThreadFilter, BoardThreadSummary, BoardViewMode } from "./types.js";
import { BoardButton, BoardInput } from "./controls.js";

export interface ThreadListProps {
  title: string;
  threads: readonly BoardThreadSummary[] | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  mode: BoardViewMode;
  filter: BoardThreadFilter;
  /** The page size asked for; a full page offers "Show more". */
  limit: number;
  onShowMore(): void;
  actors: readonly BoardActor[];
  viewerId: string;
  nowMs: number;
  selectedId: string | null;
  showScope: boolean;
  onModeChange(mode: BoardViewMode): void;
  onFilterChange(patch: Partial<BoardThreadFilter>): void;
  onSelect(id: string): void;
  onNewThread(): void;
  onRetry(): void;
  onBack?: () => void;
}

/** Middle pane: threads newest activity first, or the same scope as a queue grouped by task state. */
export function ThreadList(props: ThreadListProps) {
  const { title, threads, status, error, mode, filter, viewerId, selectedId, onSelect, onFilterChange, onNewThread, onRetry, onBack } = props;
  // The board filters before its page limit; the list only orders and groups what came back.
  const visible = useMemo(() => sortThreadsByActivity(threads ?? []), [threads]);
  const groups = useMemo(() => groupTasksByState(visible), [visible]);
  const empty = mode === "tasks" ? groups.length === 0 : visible.length === 0;
  const filtered = Boolean(filter.text || filter.label || filter.author || filter.taskState);
  const labelInvalid = Boolean(filter.label?.trim()) && parseLabelFilter(filter.label ?? "") === null;

  return <section aria-label={`${title} threads`} className="flex h-full min-h-0 flex-col">
    <header className="flex items-center gap-2 px-3 pb-2 pt-2.5">
      {onBack ? <BoardButton look="icon" aria-label="Back to channels" onClick={onBack}>
        <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
      </BoardButton> : null}
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold" style={textPrimary}>{title}</h2>
      <div role="group" aria-label="View" className="flex rounded-full p-0.5" style={{ background: "var(--bg-sunken, var(--muted))" }}>
        {(["threads", "tasks"] as const).map((value) => <BoardButton look="plain" key={value} type="button" aria-pressed={mode === value}
          onClick={() => props.onModeChange(value)}
          className="rounded-full px-2.5 py-0.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))] aria-pressed:bg-[var(--bg-surface,var(--card))] aria-pressed:font-medium aria-pressed:shadow-sm"
          style={mode === value ? textPrimary : textSecondary}>
          {value === "threads" ? "Threads" : "Tasks"}
        </BoardButton>)}
      </div>
      <BoardButton look="primary" onClick={onNewThread}>
        <HugeiconsIcon icon={Add01Icon} size={14} aria-hidden /> New
      </BoardButton>
    </header>
    <FilterBar {...props} labelInvalid={labelInvalid} />
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
      {status === "error" && !threads ? <div role="alert" className="px-3 py-8 text-center text-[13px]" style={textSecondary}>
        <p>{error ?? "Threads could not be loaded."}</p>
        <BoardButton look="chip" className="mt-2" onClick={onRetry}>Try again</BoardButton>
      </div>
        : !threads ? <p role="status" className="px-3 py-8 text-center text-xs" style={textTertiary}>Loading threads…</p>
        : empty ? <EmptyList filtered={filtered} mode={mode} onClear={() => onFilterChange({ text: "", label: "", author: undefined, taskState: undefined })} />
        : mode === "threads"
          ? <ul aria-label="Threads" className="flex flex-col gap-px">
              {visible.map((thread) => <li key={thread.root.id}>
                <ThreadRow thread={thread} {...props} viewerId={viewerId} selected={thread.root.id === selectedId} onSelect={() => onSelect(thread.root.id)} />
              </li>)}
            </ul>
          : groups.map((group) => <section key={group.state} aria-label={`${TASK_STATE_LABELS[group.state]} tasks`} className="pt-1">
              <h3 className="flex items-center gap-2 px-2 pb-1 pt-2 text-xs font-medium" style={textTertiary}>
                <TaskStateChip state={group.state} /> <span>{group.threads.length}</span>
              </h3>
              <ul className="flex flex-col gap-px">
                {group.threads.map((thread) => <li key={thread.root.id}>
                  <ThreadRow thread={thread} {...props} viewerId={viewerId} selected={thread.root.id === selectedId} onSelect={() => onSelect(thread.root.id)} />
                </li>)}
              </ul>
            </section>)}
      {threads && threads.length >= props.limit && props.limit < 500
        ? <BoardButton look="chip" className="mx-auto mt-2 flex" style={textSecondary} onClick={props.onShowMore}>Show more</BoardButton>
        : null}
      {status === "error" && threads ? <p role="alert" className="px-3 pt-2 text-xs" style={textSecondary}>
        {error} <BoardButton look="plain" className="underline" onClick={onRetry}>Try again</BoardButton>
      </p> : null}
    </div>
  </section>;
}

function FilterBar({ filter, actors, onFilterChange, labelInvalid }: ThreadListProps & { labelInvalid: boolean }) {
  const authorOptions = [{ value: "", label: "Anyone" }, ...actors.map((actor) => ({ value: actor.id, label: actorLabel(actor) }))];
  const stateOptions = [{ value: "", label: "Any state" }, ...TASK_QUEUE_ORDER.map((state) => ({ value: state, label: TASK_STATE_LABELS[state] }))];
  return <div className="flex flex-wrap items-center gap-1.5 border-b px-3 pb-2" style={subtleBorder}>
    <label className={`${fieldClass} flex h-8 min-w-[9rem] flex-[2_1_9rem] items-center gap-1.5`} style={subtleBorder}>
      <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.5} aria-hidden style={textTertiary} />
      <BoardInput bare wrapperClassName="flex-1" type="search" aria-label="Search messages" placeholder="Search" maxLength={200} value={filter.text ?? ""}
        onChange={(event) => onFilterChange({ text: event.currentTarget.value })}
      />
    </label>
    <label className={`${fieldClass} flex h-8 min-w-[7rem] flex-[1_1_7rem] items-center gap-1.5`}
      style={labelInvalid ? { borderColor: "var(--danger-text)" } : subtleBorder}>
      <HugeiconsIcon icon={Tag01Icon} size={13} strokeWidth={1.5} aria-hidden style={textTertiary} />
      <BoardInput bare wrapperClassName="flex-1" aria-label="Filter by label (k, k=v or k=v|w)" aria-invalid={labelInvalid} placeholder="kind=bug" maxLength={330}
        value={filter.label ?? ""} onChange={(event) => onFilterChange({ label: event.currentTarget.value })}
        style={{ fontSize: 12, fontFamily: "var(--font-mono, ui-monospace, monospace)" }} />
    </label>
    <ChatComposerSelect label="Filter by author" value={filter.author ?? ""} menuSide="bottom" menuZIndex={POPOVER_LAYER}
      options={authorOptions} onChange={(value) => onFilterChange({ author: value || undefined })} />
    <ChatComposerSelect label="Filter by task state" value={filter.taskState ?? ""} menuSide="bottom" menuZIndex={POPOVER_LAYER}
      options={stateOptions} onChange={(value) => onFilterChange({ taskState: (value || undefined) as BoardTaskState | undefined })} />
  </div>;
}

function ThreadRow({ thread, viewerId, nowMs, selected, showScope, onSelect }: ThreadListProps & {
  thread: BoardThreadSummary; selected: boolean; onSelect(): void;
}) {
  const deleted = Boolean(thread.root.deletedAt);
  const title = threadTitle(thread.root.text, deleted);
  const latest = thread.latestReply;
  const preview = latest ? `${actorLabel(latest.by, viewerId)}: ${latest.deletedAt ? "Deleted message" : threadTitle(latest.text, false)}` : null;
  const lease = thread.task?.state === "claimed" ? formatLeaseCountdown(thread.task.leaseUntil, nowMs) : null;
  const labels = Object.entries(thread.root.labels).slice(0, 3);
  return <button type="button" aria-current={selected} onClick={onSelect}
    aria-label={`${title}${thread.task ? `, ${TASK_STATE_LABELS[thread.task.state]}` : ""}${thread.unread ? ", unread" : ""}`}
    className={`${rowClass} grid grid-cols-[10px_minmax(0,1fr)_auto] gap-x-2 px-2 py-2`}>
    <span aria-hidden className="mt-1.5 size-2 rounded-full" style={{ background: thread.unread ? "var(--warning)" : "transparent" }} />
    <span className="min-w-0">
      <span className={`block truncate text-[13.5px] leading-snug${thread.unread ? " font-semibold" : " font-medium"}${deleted ? " italic" : ""}`}
        style={deleted ? textTertiary : textPrimary}>{title}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs" style={textTertiary}>
        {thread.task ? <TaskStateChip state={thread.task.state} /> : null}
        {thread.task?.holder && thread.task.state === "claimed" ? <span className="truncate">{actorLabel(thread.task.holder, viewerId)}</span> : null}
        {lease ? <span className="font-mono">lease {lease}</span> : null}
        {thread.task?.assignedProfile && thread.task.state !== "claimed" ? <span>for {thread.task.assignedProfile}</span> : null}
        {showScope ? <span className="font-mono">#{thread.root.channel}</span> : null}
        {labels.map(([key, value]) => <LabelChip key={key} name={key} value={value} />)}
      </span>
      {preview ? <span className="mt-1 block truncate text-[12.5px]" style={textSecondary}>{preview}</span> : null}
    </span>
    <span className="flex flex-col items-end gap-1 text-[11px]" style={textTertiary}>
      <span>{formatBoardTime(thread.lastActivityAt, nowMs)}</span>
      {thread.replyCount > 0 ? <span aria-label={`${thread.replyCount} replies`} className="rounded-full px-1.5" style={{ background: "var(--bg-sunken, var(--muted))" }}>{thread.replyCount}</span> : null}
    </span>
  </button>;
}

function EmptyList({ filtered, mode, onClear }: { filtered: boolean; mode: BoardViewMode; onClear(): void }) {
  return <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
    <span aria-hidden className="mb-1 grid size-8 place-items-center rounded-lg" style={{ background: "var(--bg-sunken, var(--muted))", ...textTertiary }}>
      <HugeiconsIcon icon={SearchRemoveIcon} size={16} />
    </span>
    <p className="text-[13.5px] font-medium" style={textPrimary}>
      {filtered ? "Nothing matches these filters" : mode === "tasks" ? "No tasks here" : "No threads here yet"}
    </p>
    <p className="text-xs" style={textTertiary}>
      {filtered ? "Try another filter, or clear them." : mode === "tasks" ? "Turn a thread into a task, or create one with New." : "Start one with New."}
    </p>
    {filtered ? <BoardButton look="chip" className="mt-1" onClick={onClear}>Clear filters</BoardButton> : null}
  </div>;
}
