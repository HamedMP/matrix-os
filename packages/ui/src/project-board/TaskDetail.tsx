"use client";

import { FocusScope } from "@radix-ui/react-focus-scope";
import { Archive, ArchiveRestore, Link2, MessageSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { chipButtonClass, focusRing, tone } from "./board-style.js";
import type { ProjectBoardClient, UpdateTaskInput } from "./client.js";
import { DescriptionEditor, TitleEditor } from "./TaskTextEditors.js";
import { TaskDetailRail } from "./TaskDetailRail.js";
import { TaskSessionPane, TaskSessionTabs, type TaskDetailTab } from "./TaskSessions.js";
import { CommentComposer, TaskTimeline } from "./TaskTimeline.js";
import { useTaskDetail } from "./use-task-detail.js";
import type { UpdateResult } from "./use-project-board.js";
import type { AttachableSession, BoardMember, BoardSettings, ProjectTask, TaskGitSummary, TaskSession, TaskStatus } from "./types.js";

export interface TaskDetailProps {
  client: ProjectBoardClient;
  task: ProjectTask;
  allTasks: readonly ProjectTask[];
  members: readonly BoardMember[];
  settings: BoardSettings | null;
  boardLabels: readonly string[];
  nowMs: number;
  onClose(): void;
  onOpenTask(task: ProjectTask): void;
  onUpdate(task: ProjectTask, input: UpdateTaskInput, options?: { resolvesConflict?: boolean }): Promise<UpdateResult>;
  onStatusChange(task: ProjectTask, status: TaskStatus): void;
  run<T>(action: () => Promise<T>, failure: string): Promise<T | null>;
  onOpenSession?: (session: TaskSession) => void;
  /** Opens the task's chat; the sheet's header offers it when given. */
  onOpenChat?: (task: ProjectTask) => void;
}

/**
 * Task detail as a sheet over the board: the board stays mounted underneath, so
 * it keeps its scroll position. Escape or a click on the scrim closes it. Focus
 * stays in the sheet while it is open and goes back to the opener on close; the
 * sheet's portalled pickers run their own Radix focus scopes, which pause this one.
 */
export function TaskDetail({ client, task, allTasks, members, settings, boardLabels, nowMs, onClose, onOpenTask, onUpdate, onStatusChange, run, onOpenSession, onOpenChat }: TaskDetailProps) {
  const sheet = useRef<HTMLDivElement>(null);
  const focusedTaskId = useRef(task.id);
  const [tab, setTab] = useState<TaskDetailTab>("details");
  const [busy, setBusy] = useState(false);
  const [git, setGit] = useState<{ taskId: string; summary: TaskGitSummary } | null>(null);
  const detail = useTaskDetail(client, task.id);
  const key = task.key;
  const session = tab === "details" ? undefined : task.sessions.find((candidate) => candidate.ref === tab);

  // The focus scope focuses the sheet on open; opening a blocker or subtask in place moves focus back to the top.
  useEffect(() => {
    if (focusedTaskId.current === task.id) return;
    focusedTaskId.current = task.id;
    sheet.current?.focus();
  }, [task.id]);
  useEffect(() => {
    let live = true;
    client.getGitSummary(task.id).then((summary) => { if (live) setGit({ taskId: task.id, summary }); }, (error: unknown) => {
      console.warn("[project-board] git summary could not be loaded", error instanceof Error ? error.name : typeof error);
    });
    return () => { live = false; };
  }, [client, task.id, task.branch, task.revision]);

  const withBusy = async <T,>(action: () => Promise<T>, failure: string) => {
    setBusy(true);
    try {
      return await run(action, failure);
    } finally {
      setBusy(false);
    }
  };
  const startTerminal = async () => {
    const started = await withBusy(() => client.startWork(task.id, { kind: "terminal" }), "Couldn't start the terminal. Try again.");
    if (started?.session) setTab(started.session.ref);
  };
  const attach = async (attachable: AttachableSession) => {
    const attached = await withBusy(() => client.attachSession(task.id, attachable), "Couldn't attach it. Try again.");
    if (attached) setTab(attached.ref);
  };
  const loadAttachable = useCallback(() => client.listAttachableSessions(), [client]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Menus portal outside the sheet and close themselves; only Escape from inside the sheet closes it.
    if (event.key !== "Escape" || event.defaultPrevented || !sheet.current?.contains(event.target as Node)) return;
    event.preventDefault();
    onClose();
  };

  return <div className="absolute inset-0 flex justify-end" style={{ zIndex: 1 }} data-slot="task-detail-layer">
    <button type="button" aria-label="Close task" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default"
      style={{ background: "rgba(0, 0, 0, 0.3)" }} />
    {/* Focuses the sheet rather than its first button once the trap is listening, and on unmount returns focus to the opener. */}
    <FocusScope asChild trapped loop onMountAutoFocus={(event) => { event.preventDefault(); sheet.current?.focus(); }}>
    {/* react-doctor-disable-next-line react-doctor/prefer-html-dialog -- the sheet stays inside the Chats window; a modal <dialog> would cover the whole OS view */}
    <div ref={sheet} role="dialog" aria-modal="true" aria-label={`${key}: ${task.title}`} tabIndex={-1} onKeyDown={onKeyDown}
      className="relative flex h-full w-[min(980px,calc(100%-32px))] flex-col overflow-hidden rounded-l-[24px] border-l outline-none"
      style={{ ...tone.border, background: "var(--bg-app, var(--background))", boxShadow: "8px 0 24px rgba(0,0,0,0.12)" }}>
      <header className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-4">
        <span className="font-mono text-[12.5px]" style={tone.muted}>{key}</span>
        {task.externalLink ? <a href={task.externalLink.url} target="_blank" rel="noreferrer noopener"
          className={`inline-flex items-center gap-1 rounded-md px-1 font-mono text-[12.5px] hover:bg-[var(--bg-hover)] ${focusRing}`} style={tone.muted}>
          <Link2 size={11} aria-hidden />{task.externalLink.key}
        </a> : null}
        {task.archivedAt ? <span className="rounded-md px-1.5 text-[11px]" style={{ background: "var(--bg-sunken, var(--muted))", ...tone.secondary }}>Archived</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {onOpenChat && task.chatId ? <button type="button" className={chipButtonClass} style={tone.secondary} onClick={() => onOpenChat(task)}>
            <MessageSquare size={13} aria-hidden />Open chat
          </button> : null}
          <button type="button" className={chipButtonClass} style={tone.secondary} disabled={busy}
            onClick={() => void withBusy(() => client.archiveTask(task.id, task.archivedAt === null), "Couldn't archive the task. Try again.")}>
            {task.archivedAt ? <><ArchiveRestore size={13} aria-hidden />Restore</> : <><Archive size={13} aria-hidden />Archive</>}
          </button>
          <button type="button" aria-label="Close task" onClick={onClose} className={`grid size-8 place-items-center rounded-lg hover:bg-[var(--bg-hover)] ${focusRing}`} style={tone.secondary}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      <TitleEditor key={task.id} task={task} onSave={(title, base) => onUpdate(base, { title }, { resolvesConflict: true })} />
      <TaskSessionTabs task={task} tab={session ? tab : "details"} onTabChange={setTab} onStartTerminal={() => void startTerminal()}
        loadAttachable={loadAttachable} onAttach={(attachable) => void attach(attachable)} busy={busy} />
      {session ? <TaskSessionPane session={session} onOpen={onOpenSession} /> : <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] overflow-hidden max-[720px]:grid-cols-1 max-[720px]:overflow-y-auto">
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          <DescriptionEditor key={task.id} task={task} onSave={(description, base) => onUpdate(base, { description }, { resolvesConflict: true })} />
          <h3 className="mb-1 mt-6 text-[12px] font-medium" style={tone.muted}>Activity</h3>
          <TaskTimeline entries={detail.timeline} status={detail.status} members={members} nowMs={nowMs} onRetry={detail.retry} />
          {/* Keyed: opening a blocker or subtask in this sheet must not carry a draft over to it. */}
          <CommentComposer key={task.id} members={members} onSubmit={async (body) => Boolean(await run(() => client.addComment(task.id, body), "Couldn't post the comment. Try again."))} />
        </div>
        <div className="min-h-0 overflow-y-auto border-l px-3 py-4 max-[720px]:border-l-0 max-[720px]:border-t" style={tone.border}>
          <TaskDetailRail task={task} allTasks={allTasks} members={members} boardLabels={boardLabels}
            git={git?.taskId === task.id ? git.summary : null} linearConnected={settings?.linearConnected ?? false} busy={busy}
            onUpdate={(input) => void onUpdate(task, input)} onStatusChange={(status) => onStatusChange(task, status)} onOpenTask={onOpenTask}
            onCreatePullRequest={() => void withBusy(() => client.createPullRequest(task.id), "Couldn't open the pull request. Try again.")} />
        </div>
      </div>}
    </div>
    </FocusScope>
  </div>;
}
