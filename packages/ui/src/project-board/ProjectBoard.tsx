"use client";

import { X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMinuteClock } from "../chat/use-minute-clock.js";
import { BoardColumns } from "./BoardColumns.js";
import { BoardEmptyState, CloseWhileWorkingDialog, NewTaskDialog } from "./BoardDialogs.js";
import { BoardList } from "./BoardList.js";
import { boardFilterIsActive, matchesBoardFilter, groupTasksByStatus, type BoardFilter } from "./board-model.js";
import { readBoardPreferences, writeBoardPreferences, type BoardPreferences, type PreferenceStorage } from "./board-preferences.js";
import { focusRing, tone } from "./board-style.js";
import { BoardToolbar } from "./BoardToolbar.js";
import type { ProjectBoardClient } from "./client.js";
import { TaskDetail } from "./TaskDetail.js";
import { BOARD_COLUMN_STATUSES, TASK_STATUS_LABEL, type ProjectTask, type TaskSession, type TaskStatus } from "./types.js";
import { useProjectBoard } from "./use-project-board.js";

const NOTICE_MS = 6000;

export interface ProjectBoardProps {
  client: ProjectBoardClient;
  /** Where layout and filters are remembered; omit to keep them for this mount only. */
  preferencesKey?: string;
  storage?: PreferenceStorage;
  /** Surface extras in the toolbar. */
  accessory?: ReactNode;
  /** Shown in the empty state when the owner has a Linear connection. */
  onImportLinear?: () => void;
  /** Opens a task's terminal in the surface's own Terminal; omitted, the open buttons are disabled. */
  onOpenSession?: (session: TaskSession) => void;
  /** Opens a task's chat (every task is a chat). Cards open it; omitted, cards open the task's details. */
  onOpenChat?: (task: ProjectTask) => void;
  /** A task whose details to show, for example from a chat's ticket header; a new id reopens them. */
  detailsTaskId?: string | null;
  active?: boolean;
}

interface PendingClose { taskId: string; status: TaskStatus; index: number }

/** A project's task board: kanban or list, filters, quick create, and the task detail sheet. */
export function ProjectBoard({ client, preferencesKey, storage, accessory, onImportLinear, onOpenSession, onOpenChat, detailsTaskId = null, active = true }: ProjectBoardProps) {
  const board = useProjectBoard(client, { includeArchived: true });
  const nowMs = useMinuteClock(active);
  const [preferences, setPreferences] = useState<BoardPreferences>(() => readBoardPreferences(preferencesKey ? storage : undefined, preferencesKey ?? ""));
  const [openTaskId, setOpenTaskId] = useState<string | null>(detailsTaskId);
  const [requestedDetails, setRequestedDetails] = useState(detailsTaskId);
  if (detailsTaskId !== requestedDetails) {
    setRequestedDetails(detailsTaskId);
    if (detailsTaskId) setOpenTaskId(detailsTaskId);
  }
  const openCard = (task: ProjectTask) => {
    if (onOpenChat && task.chatId) onOpenChat(task);
    else setOpenTaskId(task.id);
  };
  const [newTask, setNewTask] = useState<{ status: TaskStatus } | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);

  const savePreferences = (next: BoardPreferences) => {
    setPreferences(next);
    if (preferencesKey) writeBoardPreferences(storage, preferencesKey, next);
  };
  const setFilter = (filter: BoardFilter) => savePreferences({ ...preferences, filter });

  const { filter } = preferences;
  const visible = useMemo(() => board.tasks.filter((task) => matchesBoardFilter(task, filter)), [board.tasks, filter]);
  const columns = useMemo(() => groupTasksByStatus(visible), [visible]);
  const labels = useMemo(() => board.tasks.flatMap((task) => task.labels).filter((label, index, all) => all.indexOf(label) === index).sort(), [board.tasks]);
  const statuses = useMemo(() => {
    const chosen: TaskStatus[] = filter.statuses.length ? BOARD_COLUMN_STATUSES.filter((status) => filter.statuses.includes(status)) : [...BOARD_COLUMN_STATUSES];
    if (filter.showCanceled || filter.statuses.includes("canceled")) chosen.push("canceled");
    return chosen;
  }, [filter.statuses, filter.showCanceled]);
  const openTask = openTaskId ? board.tasks.find((task) => task.id === openTaskId) : undefined;
  const liveCount = board.tasks.filter((task) => task.archivedAt === null).length;
  const hasArchived = liveCount < board.tasks.length;
  const empty = liveCount === 0 && !filter.showArchived;

  const { notice, dismissNotice } = board;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  const requestMove = async (taskId: string, status: TaskStatus, index: number) => {
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    const closing = (status === "done" || status === "canceled") && task?.status !== status;
    if (closing && (task?.chatStatus === "working" || task?.sessions.some((session) => session.agentStatus === "working"))) {
      setPendingClose({ taskId, status, index });
      return;
    }
    // The server can know about a working agent the board has not seen yet; it asks the same question.
    if (await board.moveTask(taskId, status, index, columns[status]) === "agent_working") setPendingClose({ taskId, status, index });
  };
  const confirmClose = () => {
    if (pendingClose) void board.moveTask(pendingClose.taskId, pendingClose.status, pendingClose.index, columns[pendingClose.status], { force: true });
    setPendingClose(null);
  };
  const pendingTask = pendingClose ? board.tasks.find((task) => task.id === pendingClose.taskId) : undefined;

  if (board.status === "loading") {
    return <div role="status" className="flex flex-1 items-center justify-center py-16 text-[13px]" style={tone.muted}>Loading the board…</div>;
  }
  if (board.status === "error") {
    return <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-[13px]" style={tone.secondary}>
      The board could not be loaded.
      <button type="button" onClick={board.retry} className={`rounded-lg px-2.5 py-1 hover:bg-[var(--bg-hover)] ${focusRing}`} style={tone.primary}>Try again</button>
    </div>;
  }

  return <div className="relative flex min-h-0 flex-1 flex-col" style={{ isolation: "isolate" }} data-slot="project-board">
    {/* The toolbar holds the only "Show archived" control, so it stays while archived tasks exist. */}
    {empty && !hasArchived
      ? accessory ? <div className="flex justify-end px-5">{accessory}</div> : null
      : <BoardToolbar view={preferences.layout} onViewChange={(layout) => savePreferences({ ...preferences, layout })}
        filter={filter} onFilterChange={setFilter} labels={labels} members={board.members}
        onNewTask={() => setNewTask({ status: "backlog" })} accessory={accessory} />}
    {empty ? <BoardEmptyState hasArchived={hasArchived} onNewTask={() => setNewTask({ status: "backlog" })}
      onImportLinear={board.settings?.linearConnected ? onImportLinear : undefined} /> : <>
      {boardFilterIsActive(filter) && visible.length === 0 ? <p className="px-5 pb-2 text-[12.5px]" style={tone.muted}>No tasks match these filters.</p> : null}
      {preferences.layout === "board"
        ? <BoardColumns columns={columns} statuses={statuses} members={board.members} nowMs={nowMs} allTasks={board.tasks}
          onOpenTask={openCard} onMoveTask={(taskId, status, index) => void requestMove(taskId, status, index)}
          onQuickCreate={async (status, title) => Boolean(await board.createTask({ title, status }))} />
        : <BoardList tasks={visible} members={board.members} nowMs={nowMs} onOpenTask={openCard} />}
    </>}

    {openTask ? <TaskDetail client={client} task={openTask} allTasks={board.tasks} members={board.members} settings={board.settings}
      boardLabels={labels} nowMs={nowMs} onClose={() => setOpenTaskId(null)} onOpenTask={(task: ProjectTask) => setOpenTaskId(task.id)}
      onUpdate={board.updateTask} onStatusChange={(task, status) => void requestMove(task.id, status, 0)} run={board.run} onOpenSession={onOpenSession} onOpenChat={onOpenChat} /> : null}

    {notice ? <div role="alert" className="absolute bottom-4 left-1/2 flex max-w-[min(480px,calc(100%-32px))] -translate-x-1/2 items-center gap-3 rounded-[14px] border px-3.5 py-2.5 text-[13px] shadow-lg"
      style={{ zIndex: 2, borderColor: "var(--border-default, var(--border))", background: "var(--bg-overlay, var(--popover, var(--card)))", ...tone.primary }}>
      <span>{notice}</span>
      <button type="button" aria-label="Dismiss" onClick={dismissNotice} className={`grid size-6 shrink-0 place-items-center rounded-md hover:bg-[var(--bg-hover)] ${focusRing}`}><X size={13} aria-hidden /></button>
    </div> : null}

    <NewTaskDialog open={newTask !== null} onClose={() => setNewTask(null)} members={board.members} labels={labels}
      defaultStatus={newTask?.status} onCreate={async (input) => Boolean(await board.createTask(input))} />
    <CloseWhileWorkingDialog open={pendingClose !== null && pendingTask !== undefined}
      taskLabel={pendingTask ? `${pendingTask.key} ${pendingTask.title}` : ""}
      statusLabel={pendingClose ? TASK_STATUS_LABEL[pendingClose.status] : ""}
      onCancel={() => setPendingClose(null)}
      onConfirm={confirmClose} />
  </div>;
}
