"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import { rollUpTaskAgentStatus, sortTasksForList, type TaskListColumn, type TaskListSort } from "./board-model.js";
import { actorName, formatRelative } from "./board-format.js";
import { ActorAvatar, AgentStatusBadge, LabelChip, PriorityIcon, PullRequestBadge, StatusIcon } from "./board-primitives.js";
import { focusRing, tone } from "./board-style.js";
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL, type BoardMember, type ProjectTask } from "./types.js";

const COLUMNS: ReadonlyArray<{ id: TaskListColumn | null; label: string; className: string }> = [
  { id: "key", label: "Key", className: "w-[88px]" },
  { id: "title", label: "Title", className: "" },
  { id: "status", label: "Status", className: "w-[128px]" },
  { id: "priority", label: "Priority", className: "w-[104px]" },
  { id: null, label: "Assignee", className: "w-[140px]" },
  { id: null, label: "Work", className: "w-[150px]" },
  { id: "updated", label: "Updated", className: "w-[84px]" },
];

/** The same tasks as the board, as a sortable table. */
export function BoardList({ tasks, members, nowMs, onOpenTask }: {
  tasks: readonly ProjectTask[]; members: readonly BoardMember[]; nowMs: number; onOpenTask(task: ProjectTask): void;
}) {
  const [sort, setSort] = useState<TaskListSort>({ column: "status", direction: "asc" });
  const rows = useMemo(() => sortTasksForList(tasks, sort), [tasks, sort]);
  const toggle = (column: TaskListColumn) => setSort((current) => current.column === column
    ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
    : { column, direction: column === "updated" || column === "priority" ? "desc" : "asc" });

  return <div className="min-h-0 flex-1 overflow-auto px-5 pb-4" data-slot="project-board-list">
    <table className="w-full min-w-[820px] table-fixed border-separate border-spacing-0 text-[13px]">
      <thead>
        <tr>
          {COLUMNS.map((column) => {
            const active = column.id !== null && sort.column === column.id;
            return <th key={column.label} scope="col" aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
              className={`sticky top-0 border-b px-2 py-2 text-left text-[12px] font-medium ${column.className}`}
              style={{ ...tone.border, ...tone.muted, background: "var(--bg-app, var(--background))" }}>
              {column.id ? <button type="button" onClick={() => toggle(column.id!)} className={`-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-[var(--text-primary)] ${focusRing}`}>
                {column.label}
                {active ? (sort.direction === "asc" ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />) : null}
              </button> : column.label}
            </th>;
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((task) => {
          const agent = rollUpTaskAgentStatus(task);
          const key = task.key;
          return <tr key={task.id} className="group hover:bg-[var(--bg-hover)]" data-task-id={task.id}>
            <td className="border-b px-2 py-2 font-mono text-[12px]" style={{ ...tone.border, ...tone.muted }}>{key}</td>
            <td className="border-b px-2 py-1.5" style={tone.border}>
              <button type="button" onClick={() => onOpenTask(task)} className={`flex w-full min-w-0 items-center gap-2 rounded text-left ${focusRing}`}>
                <span className="min-w-[8rem] flex-1 truncate font-medium" style={tone.primary} title={task.title}>{task.title}</span>
                {task.labels.length > 0 ? <span className="flex min-w-0 shrink gap-1 overflow-hidden">{task.labels.slice(0, 2).map((label) => <LabelChip key={label} name={label} />)}</span> : null}
              </button>
            </td>
            <td className="border-b px-2 py-2" style={tone.border}>
              <span className="flex items-center gap-1.5" style={tone.secondary}><StatusIcon status={task.status} />{TASK_STATUS_LABEL[task.status]}</span>
            </td>
            <td className="border-b px-2 py-2" style={tone.border}>
              <span className="flex items-center gap-1.5" style={tone.secondary}><PriorityIcon priority={task.priority} />{task.priority === "none" ? "—" : TASK_PRIORITY_LABEL[task.priority]}</span>
            </td>
            <td className="border-b px-2 py-2" style={tone.border}>
              <span className="flex min-w-0 items-center gap-1.5" style={tone.secondary}>
                <ActorAvatar members={members} actor={task.assignee} size={18} />
                <span className="truncate">{task.assignee ? actorName(members, task.assignee) : "Unassigned"}</span>
              </span>
            </td>
            <td className="border-b px-2 py-2" style={tone.border}>
              <span className="flex items-center gap-1">
                {agent && agent !== "idle" ? <AgentStatusBadge status={agent} /> : null}
                {task.pullRequest ? <PullRequestBadge pr={task.pullRequest} /> : null}
              </span>
            </td>
            <td className="border-b px-2 py-2 text-[12px]" style={{ ...tone.border, ...tone.muted }}>{formatRelative(task.updatedAt, nowMs)}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
