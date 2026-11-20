"use client";

import { Columns3, List, Plus, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { boardFilterIsActive, type AssigneeFilterValue, type BoardFilter } from "./board-model.js";
import { BoardPicker, type BoardPickerOption } from "./BoardPicker.js";
import { ActorAvatar, PriorityIcon, StatusIcon } from "./board-primitives.js";
import { chipButtonClass, focusRing, primaryButtonClass, tone } from "./board-style.js";
import {
  TASK_PRIORITIES, TASK_PRIORITY_LABEL, TASK_STATUSES, TASK_STATUS_LABEL,
  type BoardMember, type TaskPriority, type TaskStatus,
} from "./types.js";

export type BoardViewMode = "board" | "list";

const STATUS_OPTIONS: BoardPickerOption[] = TASK_STATUSES.map((status) => ({ value: status, label: TASK_STATUS_LABEL[status], icon: <StatusIcon status={status} /> }));
const PRIORITY_OPTIONS: BoardPickerOption[] = [...TASK_PRIORITIES].reverse().map((priority) => ({ value: priority, label: TASK_PRIORITY_LABEL[priority], icon: <PriorityIcon priority={priority} /> }));
const SHOW_OPTIONS: BoardPickerOption[] = [{ value: "canceled", label: "Canceled tasks" }, { value: "archived", label: "Archived tasks" }];

export function BoardToolbar({ view, onViewChange, filter, onFilterChange, labels, members, onNewTask, accessory }: {
  view: BoardViewMode;
  onViewChange(view: BoardViewMode): void;
  filter: BoardFilter;
  onFilterChange(filter: BoardFilter): void;
  labels: readonly string[];
  members: readonly BoardMember[];
  onNewTask(): void;
  /** Surface-provided extras. */
  accessory?: ReactNode;
}) {
  const update = (patch: Partial<BoardFilter>) => onFilterChange({ ...filter, ...patch });
  const assigneeOptions: BoardPickerOption[] = [
    { value: "unassigned", label: "Unassigned", icon: <ActorAvatar members={members} actor={null} size={16} /> },
    ...members.map((member) => ({ value: member.actor, label: member.name, keywords: member.handle, icon: <ActorAvatar members={members} actor={member.actor} size={16} /> })),
  ];
  const show = [...(filter.showCanceled ? ["canceled"] : []), ...(filter.showArchived ? ["archived"] : [])];
  return <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3" data-slot="project-board-toolbar">
    <div role="group" aria-label="Board layout" className="mr-1 flex rounded-[10px] p-0.5" style={{ background: "var(--bg-sunken, var(--muted))" }}>
      {([["board", "Board", Columns3], ["list", "List", List]] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={view === id}
        onClick={() => onViewChange(id)} title={`${label} layout`}
        className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] ${focusRing} aria-pressed:bg-[var(--bg-surface,var(--card))] aria-pressed:font-medium aria-pressed:shadow-sm`}
        style={tone.primary}>
        <Icon size={13} aria-hidden />{label}
      </button>)}
    </div>
    <label className="flex h-8 w-[200px] min-w-[140px] items-center gap-2 rounded-lg border px-2.5" style={tone.border}>
      <Search size={13} aria-hidden style={tone.muted} />
      <input type="search" aria-label="Search tasks" placeholder="Search tasks" maxLength={200} value={filter.search}
        onChange={(event) => update({ search: event.currentTarget.value })}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" style={tone.primary} />
    </label>
    <BoardPicker multiple label="Status" options={STATUS_OPTIONS} value={filter.statuses}
      onChange={(statuses) => update({ statuses: statuses as TaskStatus[] })} />
    <BoardPicker multiple label="Priority" options={PRIORITY_OPTIONS} value={filter.priorities}
      onChange={(priorities) => update({ priorities: priorities as TaskPriority[] })} />
    <BoardPicker multiple label="Label" options={labels.map((label) => ({ value: label, label }))} value={filter.labels}
      emptyText="No labels on this board yet" onChange={(next) => update({ labels: next })} />
    <BoardPicker multiple label="Assignee" options={assigneeOptions} value={filter.assignees}
      onChange={(assignees) => update({ assignees: assignees as AssigneeFilterValue[] })} />
    <BoardPicker multiple label="Show" options={SHOW_OPTIONS} value={show}
      onChange={(next) => update({ showCanceled: next.includes("canceled"), showArchived: next.includes("archived") })} />
    {boardFilterIsActive(filter) ? <button type="button" className={chipButtonClass} style={tone.secondary}
      onClick={() => onFilterChange({ ...filter, statuses: [], priorities: [], labels: [], assignees: [], search: "", showCanceled: false, showArchived: false })}>
      <X size={12} aria-hidden />Clear
    </button> : null}
    <div className="ml-auto flex items-center gap-2">
      {accessory}
      <button type="button" className={primaryButtonClass} onClick={onNewTask}><Plus size={14} aria-hidden />New task</button>
    </div>
  </div>;
}
