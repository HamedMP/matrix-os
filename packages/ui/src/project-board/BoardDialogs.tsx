"use client";

import { useState, type CSSProperties } from "react";
import { ClipboardList, Download, Plus } from "lucide-react";
import { Dialog } from "../Dialog.js";
import { BoardPicker } from "./BoardPicker.js";
import { ActorAvatar, PriorityIcon, StatusIcon } from "./board-primitives.js";
import { focusOnMount, primaryButtonClass, secondaryButtonClass, tone } from "./board-style.js";
import type { CreateTaskInput } from "./client.js";
import {
  BOARD_COLUMN_STATUSES, TASK_PRIORITIES, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL,
  type ActorRef, type BoardMember, type TaskPriority, type TaskStatus,
} from "./types.js";

const boardDialogStyle: CSSProperties = {
  background: "var(--bg-overlay, var(--popover, var(--matrix-card)))", color: "var(--text-primary, var(--foreground))",
  borderRadius: 20, padding: 20, border: "1px solid var(--border-subtle, var(--border))",
};

const fieldClass = "w-full rounded-[14px] border bg-[var(--bg-sunken,var(--muted))] px-3 py-2 text-[15px] outline-none focus:border-[var(--text-primary,var(--foreground))]";

/** New task with the common fields; everything else is edited on the task itself. */
export function NewTaskDialog({ open, onClose, members, labels, defaultStatus = "backlog", onCreate }: {
  open: boolean;
  onClose(): void;
  members: readonly BoardMember[];
  labels: readonly string[];
  defaultStatus?: TaskStatus;
  onCreate(input: Omit<CreateTaskInput, "clientRequestId">): Promise<boolean>;
}) {
  return <Dialog open={open} onClose={onClose} aria-label="New task" style={{ ...boardDialogStyle, maxWidth: 560 }}>
    {open ? <NewTaskForm onClose={onClose} members={members} labels={labels} defaultStatus={defaultStatus} onCreate={onCreate} /> : null}
  </Dialog>;
}

function NewTaskForm({ onClose, members, labels, defaultStatus, onCreate }: {
  onClose(): void; members: readonly BoardMember[]; labels: readonly string[]; defaultStatus: TaskStatus;
  onCreate(input: Omit<CreateTaskInput, "clientRequestId">): Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>(defaultStatus);
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [assignee, setAssignee] = useState<ActorRef | "">("");
  const [chosenLabels, setChosenLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const knownLabels = [...labels, ...chosenLabels].filter((label, index, all) => all.indexOf(label) === index).sort();
  const assigneeName = members.find((member) => member.actor === assignee)?.name;

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    let created = false;
    try {
      created = await onCreate({ title: title.trim(), description, status, priority, assignee: assignee || null, labels: chosenLabels });
    } finally {
      setBusy(false);
    }
    if (!created) return;
    if (createMore) { setTitle(""); setDescription(""); } else onClose();
  };

  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="flex flex-col gap-3">
    <h2 className="text-[17px] font-semibold leading-[25px]">New task</h2>
    <label className="flex flex-col gap-1 text-[12px] font-medium" style={tone.secondary}>
      Title
      <input required maxLength={300} value={title} onChange={(event) => setTitle(event.currentTarget.value)}
        placeholder="What needs doing?" className={fieldClass} style={{ ...tone.border, ...tone.primary }}
        ref={focusOnMount} />
    </label>
    <label className="flex flex-col gap-1 text-[12px] font-medium" style={tone.secondary}>
      Description
      <textarea rows={4} maxLength={20_000} value={description} onChange={(event) => setDescription(event.currentTarget.value)}
        placeholder="Markdown supported" className={`${fieldClass} resize-y text-[14px]`} style={{ ...tone.border, ...tone.primary }} />
    </label>
    <div className="flex flex-wrap items-center gap-1">
      <BoardPicker portal={false} label="Status" value={status} onChange={(value) => setStatus(value as TaskStatus)}
        options={BOARD_COLUMN_STATUSES.map((value) => ({ value, label: TASK_STATUS_LABEL[value], icon: <StatusIcon status={value} /> }))}
        trigger={<><StatusIcon status={status} />{TASK_STATUS_LABEL[status]}</>} />
      <BoardPicker portal={false} label="Priority" value={priority} onChange={(value) => setPriority(value as TaskPriority)}
        options={[...TASK_PRIORITIES].reverse().map((value) => ({ value, label: TASK_PRIORITY_LABEL[value], icon: <PriorityIcon priority={value} /> }))}
        trigger={<><PriorityIcon priority={priority} />{TASK_PRIORITY_LABEL[priority]}</>} />
      <BoardPicker portal={false} label="Assignee" value={assignee} onChange={(value) => setAssignee(value as ActorRef | "")}
        options={[{ value: "", label: "Unassigned" }, ...members.map((member) => ({ value: member.actor, label: member.name, keywords: member.handle }))]}
        trigger={<><ActorAvatar members={members} actor={assignee || null} size={16} />{assigneeName ?? "Unassigned"}</>} />
      <BoardPicker portal={false} multiple label="Labels" value={chosenLabels} onChange={setChosenLabels}
        options={knownLabels.map((label) => ({ value: label, label }))}
        onCreate={(label) => setChosenLabels((current) => current.includes(label) ? current : [...current, label])}
        trigger={<>{chosenLabels.length ? chosenLabels.join(", ") : "Labels"}</>} />
    </div>
    <div className="mt-2 flex items-center gap-2">
      <label className="mr-auto flex items-center gap-2 text-[13px]" style={tone.secondary}>
        <input type="checkbox" checked={createMore} onChange={(event) => setCreateMore(event.currentTarget.checked)} />
        Create another
      </label>
      <button type="button" className={secondaryButtonClass} onClick={onClose}>Cancel</button>
      <button type="submit" className={primaryButtonClass} disabled={!title.trim() || busy}>{busy ? "Creating…" : "Create task"}</button>
    </div>
  </form>;
}

/** Asked before closing a task while one of its agents is still working (spec 2699 section 3). */
export function CloseWhileWorkingDialog({ open, taskLabel, statusLabel, onCancel, onConfirm }: {
  open: boolean; taskLabel: string; statusLabel: string; onCancel(): void; onConfirm(): void;
}) {
  return <Dialog open={open} onClose={onCancel} aria-label="Agent still working" style={{ ...boardDialogStyle, maxWidth: 440 }}>
    <h2 className="text-[17px] font-semibold leading-[25px]">An agent is still working</h2>
    <p className="mt-2 text-[14px] leading-5" style={tone.secondary}>
      {taskLabel} has an agent mid-reply. Moving it to {statusLabel} keeps its chats, terminals and worktree; the agent keeps running.
    </p>
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" className={secondaryButtonClass} onClick={onCancel}>Keep it open</button>
      <button type="button" className={primaryButtonClass} onClick={onConfirm}>Move to {statusLabel}</button>
    </div>
  </Dialog>;
}

/** First-run board: what a task is, and the two ways to get some. */
/** `hasArchived`: every task is archived, so the copy points at the Show filter instead of saying the board is new. */
export function BoardEmptyState({ onNewTask, onImportLinear, hasArchived = false }: { onNewTask(): void; onImportLinear?: () => void; hasArchived?: boolean }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-16 text-center" data-testid="project-board-empty">
    <span aria-hidden="true" className="mb-2 grid size-10 place-items-center rounded-xl" style={{ background: "var(--bg-sunken, var(--muted))", ...tone.muted }}>
      <ClipboardList size={20} />
    </span>
    <h2 className="text-[17px] font-semibold" style={tone.primary}>{hasArchived ? "No open tasks" : "No tasks yet"}</h2>
    <p className="max-w-sm text-[13px] leading-[18px]" style={tone.secondary}>
      {hasArchived
        ? "Every task here is archived. Choose Show, then Archived tasks, to see them again."
        : "A task is one piece of work. Its chats, terminals, branch and pull request all open from its card."}
    </p>
    <div className="mt-4 flex gap-2">
      <button type="button" className={primaryButtonClass} onClick={onNewTask}><Plus size={14} aria-hidden />New task</button>
      {onImportLinear ? <button type="button" className={secondaryButtonClass} onClick={onImportLinear}><Download size={14} aria-hidden />Import from Linear</button> : null}
    </div>
  </div>;
}
