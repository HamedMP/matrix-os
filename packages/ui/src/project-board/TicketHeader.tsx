"use client";

import { FileText, Plus, TerminalSquare } from "lucide-react";
import { BoardPicker, type BoardPickerOption } from "./BoardPicker.js";
import { actorName } from "./board-format.js";
import { ActorAvatar, LabelChip, PriorityIcon, StatusIcon } from "./board-primitives.js";
import { chipButtonClass, focusRing, tone } from "./board-style.js";
import type { UpdateTaskInput } from "./client.js";
import {
  TASK_PRIORITIES, TASK_PRIORITY_LABEL, TASK_STATUSES, TASK_STATUS_LABEL,
  type ActorRef, type BoardMember, type ProjectTask, type TaskPriority, type TaskStatus,
} from "./types.js";

const fieldTrigger = `flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] hover:bg-[var(--bg-hover)] aria-expanded:bg-[var(--bg-hover)] ${focusRing}`;

export interface TicketHeaderProps {
  task: ProjectTask;
  members: readonly BoardMember[];
  /** Labels used elsewhere on the board, offered in the label picker. */
  boardLabels?: readonly string[];
  busy?: boolean;
  onUpdate(input: UpdateTaskInput): void;
  onStatusChange(status: TaskStatus): void;
  /** Opens the description, comments, activity, relations, branch and pull request. */
  onOpenDetails(): void;
  onStartTerminal?: () => void;
}

/**
 * Every task is a chat: this bar sits above a project chat's conversation and
 * edits the chat's ticket in place. Web Desktop, Web Canvas and Electron
 * Desktop all render this component.
 */
export function TicketHeader({ task, members, boardLabels = [], busy = false, onUpdate, onStatusChange, onOpenDetails, onStartTerminal }: TicketHeaderProps) {
  const labelOptions = [...boardLabels, ...task.labels].filter((label, index, all) => all.indexOf(label) === index).sort().map((label) => ({ value: label, label }));
  const assigneeOptions: BoardPickerOption[] = [
    { value: "", label: "Unassigned", icon: <ActorAvatar members={members} actor={null} size={16} /> },
    ...members.map((member) => ({ value: member.actor, label: member.name, keywords: member.handle, icon: <ActorAvatar members={members} actor={member.actor} size={16} /> })),
  ];
  return <div role="group" aria-label={`Ticket ${task.key}`} data-slot="ticket-header"
    className="@container flex min-w-0 flex-wrap items-center gap-1 border-b px-3 py-1" style={{ ...tone.border, ...tone.primary }}>
    <span className="mr-1 font-mono text-[12px]" style={tone.muted}>{task.key}</span>
    <BoardPicker label="Status" value={task.status} onChange={(value) => onStatusChange(value as TaskStatus)} triggerClassName={fieldTrigger}
      options={TASK_STATUSES.map((status) => ({ value: status, label: TASK_STATUS_LABEL[status], icon: <StatusIcon status={status} /> }))}
      trigger={<><StatusIcon status={task.status} />{TASK_STATUS_LABEL[task.status]}</>} />
    <BoardPicker label="Priority" value={task.priority} onChange={(value) => onUpdate({ priority: value as TaskPriority })} triggerClassName={fieldTrigger}
      options={[...TASK_PRIORITIES].reverse().map((priority) => ({ value: priority, label: TASK_PRIORITY_LABEL[priority], icon: <PriorityIcon priority={priority} /> }))}
      trigger={<><PriorityIcon priority={task.priority} /><span className="hidden @md:inline">{TASK_PRIORITY_LABEL[task.priority]}</span></>} />
    <BoardPicker label="Assignee" value={task.assignee ?? ""} onChange={(value) => onUpdate({ assignee: (value || null) as ActorRef | null })} triggerClassName={fieldTrigger}
      options={assigneeOptions}
      trigger={<><ActorAvatar members={members} actor={task.assignee} size={16} /><span className="hidden truncate @md:inline">{task.assignee ? actorName(members, task.assignee) : "Unassigned"}</span></>} />
    <div className="flex min-w-0 items-center gap-1">
      {task.labels.map((label) => <LabelChip key={label} name={label} onRemove={() => onUpdate({ labels: task.labels.filter((item) => item !== label) })} />)}
      <BoardPicker multiple label="Labels" value={task.labels} options={labelOptions} onChange={(labels) => onUpdate({ labels })}
        onCreate={(label) => { if (!task.labels.includes(label)) onUpdate({ labels: [...task.labels, label] }); }}
        triggerClassName={`grid size-6 place-items-center rounded-md hover:bg-[var(--bg-hover)] ${focusRing}`}
        trigger={<Plus size={12} aria-label="Edit labels" />} />
    </div>
    <div className="ml-auto flex items-center gap-0.5">
      {onStartTerminal ? <button type="button" className={chipButtonClass} style={tone.secondary} disabled={busy} onClick={onStartTerminal} title="Start terminal">
        <TerminalSquare size={13} aria-hidden /><span className="hidden @lg:inline">Start terminal</span><span className="sr-only @lg:hidden">Start terminal</span>
      </button> : null}
      <button type="button" className={chipButtonClass} style={tone.secondary} onClick={onOpenDetails} title="Description, comments and activity">
        <FileText size={13} aria-hidden />Details
      </button>
    </div>
  </div>;
}
