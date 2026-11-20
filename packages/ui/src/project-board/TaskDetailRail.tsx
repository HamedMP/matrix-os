"use client";

import { ExternalLink, GitBranch, GitPullRequestCreate, Link2, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { DatePicker } from "../date-picker/DatePicker.js";
import { fromDateKey, toDateKey } from "../date-picker/date-key.js";
import { BoardPicker, type BoardPickerOption } from "./BoardPicker.js";
import { actorName, pullRequestDescription } from "./board-format.js";
import { ActorAvatar, LabelChip, PriorityIcon, PullRequestBadge, StatusIcon } from "./board-primitives.js";
import { focusRing, secondaryButtonClass, tone } from "./board-style.js";
import type { UpdateTaskInput } from "./client.js";
import {
  TASK_PRIORITIES, TASK_PRIORITY_LABEL, TASK_STATUSES, TASK_STATUS_LABEL,
  type ActorRef, type BoardMember, type ProjectTask, type TaskGitSummary, type TaskPriority, type TaskStatus,
} from "./types.js";

const fieldTrigger = `flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-[var(--bg-hover)] aria-expanded:bg-[var(--bg-hover)] ${focusRing}`;

/** A due date means the end of the working day, in the viewer's time zone. */
function dueAtFromKey(key: string | null): string | null {
  const date = fromDateKey(key);
  if (!date) return null;
  date.setHours(17, 0, 0, 0);
  return date.toISOString();
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-1 py-0.5">
    <span className="pt-2 text-[12px] font-medium" style={tone.muted}>{label}</span>
    <div className="min-w-0">{children}</div>
  </div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="border-t pt-3" style={tone.border}>
    <h3 className="mb-1 px-0.5 text-[12px] font-medium" style={tone.muted}>{title}</h3>
    {children}
  </section>;
}

export function TaskDetailRail({ task, allTasks, members, boardLabels, git, linearConnected,
  onUpdate, onStatusChange, onOpenTask, onCreatePullRequest, busy }: {
  task: ProjectTask;
  allTasks: readonly ProjectTask[];
  members: readonly BoardMember[];
  boardLabels: readonly string[];
  git: TaskGitSummary | null;
  linearConnected: boolean;
  onUpdate(input: UpdateTaskInput): void;
  onStatusChange(status: TaskStatus): void;
  onOpenTask(task: ProjectTask): void;
  onCreatePullRequest(): void;
  busy: boolean;
}) {
  const others = allTasks.filter((candidate) => candidate.id !== task.id);
  const taskOption = (candidate: ProjectTask): BoardPickerOption => ({
    value: candidate.id, label: `${candidate.key} ${candidate.title}`, icon: <StatusIcon status={candidate.status} />,
  });
  const byId = Object.fromEntries(allTasks.map((candidate) => [candidate.id, candidate]));
  const parent = task.parentTaskId ? byId[task.parentTaskId] : undefined;
  const subtasks = allTasks.filter((candidate) => candidate.parentTaskId === task.id);
  const blockers = task.blockedBy.map((id) => byId[id]).filter((candidate): candidate is ProjectTask => Boolean(candidate));
  const labelOptions = [...boardLabels, ...task.labels].filter((label, index, all) => all.indexOf(label) === index).sort().map((label) => ({ value: label, label }));
  const assigneeOptions: BoardPickerOption[] = [
    { value: "", label: "Unassigned", icon: <ActorAvatar members={members} actor={null} size={16} /> },
    ...members.map((member) => ({ value: member.actor, label: member.name, keywords: member.handle, icon: <ActorAvatar members={members} actor={member.actor} size={16} /> })),
  ];

  return <aside aria-label="Task properties" className="flex flex-col gap-3 text-[13px]" style={tone.primary}>
    <div>
      <Field label="Status">
        <BoardPicker label="Status" value={task.status} onChange={(value) => onStatusChange(value as TaskStatus)} triggerClassName={fieldTrigger}
          options={TASK_STATUSES.map((status) => ({ value: status, label: TASK_STATUS_LABEL[status], icon: <StatusIcon status={status} /> }))}
          trigger={<><StatusIcon status={task.status} />{TASK_STATUS_LABEL[task.status]}</>} />
      </Field>
      <Field label="Priority">
        <BoardPicker label="Priority" value={task.priority} onChange={(value) => onUpdate({ priority: value as TaskPriority })} triggerClassName={fieldTrigger}
          options={[...TASK_PRIORITIES].reverse().map((priority) => ({ value: priority, label: TASK_PRIORITY_LABEL[priority], icon: <PriorityIcon priority={priority} /> }))}
          trigger={<><PriorityIcon priority={task.priority} />{TASK_PRIORITY_LABEL[task.priority]}</>} />
      </Field>
      <Field label="Assignee">
        <BoardPicker label="Assignee" value={task.assignee ?? ""} onChange={(value) => onUpdate({ assignee: (value || null) as ActorRef | null })} triggerClassName={fieldTrigger}
          options={assigneeOptions}
          trigger={<><ActorAvatar members={members} actor={task.assignee} size={18} /><span className="truncate">{task.assignee ? actorName(members, task.assignee) : "Unassigned"}</span></>} />
      </Field>
      <Field label="Labels">
        <div className="flex flex-wrap items-center gap-1 py-1.5 pl-2">
          {task.labels.map((label) => <LabelChip key={label} name={label} onRemove={() => onUpdate({ labels: task.labels.filter((item) => item !== label) })} />)}
          <BoardPicker multiple label="Labels" value={task.labels} options={labelOptions} onChange={(labels) => onUpdate({ labels })}
            onCreate={(label) => { if (!task.labels.includes(label)) onUpdate({ labels: [...task.labels, label] }); }}
            triggerClassName={`grid size-5 place-items-center rounded-md hover:bg-[var(--bg-hover)] ${focusRing}`}
            trigger={<Plus size={12} aria-label="Edit labels" />} />
        </div>
      </Field>
      <Field label="Due date">
        <DatePicker label="Due date" value={task.dueAt ? toDateKey(new Date(task.dueAt)) : null} triggerClassName={fieldTrigger}
          onChange={(key) => onUpdate({ dueAt: dueAtFromKey(key) })} />
      </Field>
    </div>

    <Section title="Relations">
      <Field label="Parent">
        <BoardPicker label="Parent task" value={task.parentTaskId ?? ""} triggerClassName={fieldTrigger}
          options={[{ value: "", label: "No parent" }, ...others.filter((candidate) => candidate.parentTaskId !== task.id).map(taskOption)]}
          onChange={(value) => onUpdate({ parentTaskId: value || null })}
          trigger={parent ? <><StatusIcon status={parent.status} /><span className="truncate">{parent.title}</span></> : <span style={tone.muted}>None</span>} />
      </Field>
      <Field label="Blocked by">
        <div className="flex flex-col">
          {blockers.map((blocker) => <TaskLink key={blocker.id} task={blocker} onOpen={onOpenTask} />)}
          <BoardPicker multiple label="Blocked by" value={task.blockedBy} options={others.map(taskOption)} triggerClassName={fieldTrigger}
            onChange={(blockedBy) => onUpdate({ blockedBy })}
            trigger={<span style={tone.muted}>{blockers.length ? "Edit blockers" : "None"}</span>} />
        </div>
      </Field>
      {subtasks.length > 0 ? <Field label="Subtasks">
        <div className="flex flex-col">{subtasks.map((subtask) => <TaskLink key={subtask.id} task={subtask} onOpen={onOpenTask} />)}</div>
      </Field> : null}
    </Section>

    <Section title="Code">
      <Field label="Branch">
        {task.branch ? <span className="flex min-w-0 items-center gap-1.5 px-2 py-2 font-mono text-[12px]" title={task.branch}>
          <GitBranch size={12} aria-hidden className="shrink-0" /><span className="truncate">{task.branch}</span>
        </span> : <span className="block px-2 py-2" style={tone.muted}>Created when work starts</span>}
        {git?.branch ? <span className="block px-2 pb-1 text-[12px]" style={tone.muted}>
          {git.ahead} ahead · {git.behind} behind · {git.changedFiles} files changed{git.dirty ? " · uncommitted changes" : ""}
        </span> : null}
      </Field>
      <Field label="Pull request">
        {task.pullRequest ? <a href={task.pullRequest.url} target="_blank" rel="noreferrer noopener" title={pullRequestDescription(task.pullRequest)}
          className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-hover)] ${focusRing}`}>
          <PullRequestBadge pr={task.pullRequest} />
          <span className="truncate text-[12px]" style={tone.secondary}>{pullRequestDescription(task.pullRequest).split(" · ").slice(1).join(" · ")}</span>
          <ExternalLink size={12} aria-hidden className="ml-auto shrink-0" style={tone.muted} />
        </a> : <div className="px-2 py-1">
          <button type="button" className={secondaryButtonClass} disabled={!task.branch || busy} onClick={onCreatePullRequest}
            title={task.branch ? "Push the branch and open a pull request" : "Start a chat or terminal first so the task has a branch"}>
            <GitPullRequestCreate size={13} aria-hidden />Create pull request
          </button>
        </div>}
      </Field>
      {git?.prStatus === "unavailable" ? <p className="px-2 text-[12px]" style={tone.muted}>Connect GitHub on this computer to see pull request status.</p> : null}
    </Section>

    <Section title="Linear">
      {task.externalLink ? <a href={task.externalLink.url} target="_blank" rel="noreferrer noopener"
        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-hover)] ${focusRing}`}>
        <Link2 size={13} aria-hidden /><span className="font-mono text-[12.5px]">{task.externalLink.key}</span>
        <span className="text-[12px]" style={tone.muted}>Synced</span>
        <ExternalLink size={12} aria-hidden className="ml-auto" style={tone.muted} />
      </a> : <div className="px-2 py-1">
        <button type="button" className={secondaryButtonClass} disabled title={linearConnected ? "Coming with Linear sync" : "Connect Linear in Integrations first"}>
          <Link2 size={13} aria-hidden />Send to Linear
        </button>
      </div>}
    </Section>
  </aside>;
}

function TaskLink({ task, onOpen }: { task: ProjectTask; onOpen(task: ProjectTask): void }) {
  return <button type="button" onClick={() => onOpen(task)} className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--bg-hover)] ${focusRing}`}>
    <StatusIcon status={task.status} />
    <span className="shrink-0 font-mono text-[11.5px]" style={tone.muted}>{task.key}</span>
    <span className="truncate text-[13px]">{task.title}</span>
  </button>;
}
