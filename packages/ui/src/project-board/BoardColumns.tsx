"use client";

import {
  DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { keyboardMoveTarget, type BoardColumns as Columns, type KeyboardMoveDirection } from "./board-model.js";
import { StatusIcon } from "./board-primitives.js";
import { BOARD_COLUMN_DROP_PREFIX, boardCollisionDetection, orderAfterDrop } from "./board-collision.js";
import { BoardScrollRow } from "./BoardScrollRow.js";
import { focusOnMount, focusRing, tone } from "./board-style.js";
import { TaskCard } from "./TaskCard.js";
import { TASK_STATUS_LABEL, type BoardMember, type ProjectTask, type TaskStatus } from "./types.js";

type ColumnIds = Record<TaskStatus, string[]>;

export interface BoardColumnsProps {
  columns: Columns;
  /** Columns to draw, normally the five board statuses; `canceled` joins when it is filtered in. */
  statuses: readonly TaskStatus[];
  members: readonly BoardMember[];
  nowMs: number;
  /** Every task on the board, for subtask and blocker counts. */
  allTasks: readonly ProjectTask[];
  onOpenTask(task: ProjectTask): void;
  onMoveTask(taskId: string, status: TaskStatus, index: number): void;
  onQuickCreate(status: TaskStatus, title: string): Promise<boolean>;
}

const COLUMN_PREFIX = BOARD_COLUMN_DROP_PREFIX;
const KEY_DIRECTION: Record<string, KeyboardMoveDirection> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

function idsOf(columns: Columns, statuses: readonly TaskStatus[]): ColumnIds {
  const ids = {} as ColumnIds;
  for (const status of statuses) ids[status] = columns[status].map((task) => task.id);
  return ids;
}

function containerOf(ids: ColumnIds, statuses: readonly TaskStatus[], id: string): TaskStatus | undefined {
  if (id.startsWith(COLUMN_PREFIX)) return id.slice(COLUMN_PREFIX.length) as TaskStatus;
  return statuses.find((status) => ids[status]?.includes(id));
}

/**
 * The kanban columns. Pointer drags reorder within and between columns; on a
 * focused card, Alt plus an arrow key does the same one step at a time.
 */
export function BoardColumns({ columns, statuses, members, nowMs, allTasks, onOpenTask, onMoveTask, onQuickCreate }: BoardColumnsProps) {
  const [dragIds, setDragIds] = useState<ColumnIds | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const instructionsId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const byId = useMemo(() => Object.fromEntries(allTasks.map((task) => [task.id, task])), [allTasks]);
  const counts = useMemo(() => {
    const subtasks: Record<string, number> = {};
    for (const task of allTasks) if (task.parentTaskId) subtasks[task.parentTaskId] = (subtasks[task.parentTaskId] ?? 0) + 1;
    return subtasks;
  }, [allTasks]);
  const openBlockers = (task: ProjectTask) => task.blockedBy.filter((id) => {
    const blocker = byId[id];
    return blocker && blocker.status !== "done" && blocker.status !== "canceled";
  }).length;

  const ids = dragIds ?? idsOf(columns, statuses);

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    setDragIds(idsOf(columns, statuses));
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !dragIds) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    const from = containerOf(dragIds, statuses, activeKey);
    const to = containerOf(dragIds, statuses, overKey);
    if (!from || !to || from === to) return;
    const target = dragIds[to];
    const overIndex = overKey.startsWith(COLUMN_PREFIX) ? target.length : target.indexOf(overKey);
    const below = over.rect && active.rect.current.translated ? active.rect.current.translated.top > over.rect.top + over.rect.height / 2 : false;
    const index = overIndex < 0 ? target.length : overIndex + (below ? 1 : 0);
    setDragIds({
      ...dragIds,
      [from]: dragIds[from].filter((id) => id !== activeKey),
      [to]: [...target.slice(0, index), activeKey, ...target.slice(index)],
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const activeKey = String(active.id);
    const current = dragIds;
    setDragIds(null);
    setActiveId(null);
    if (!over || !current) return;
    const status = containerOf(current, statuses, activeKey);
    if (!status) return;
    const overKey = String(over.id);
    const list = overKey.startsWith(COLUMN_PREFIX) || current[status].includes(overKey)
      ? orderAfterDrop(current[status], activeKey, overKey) : current[status];
    const index = list.indexOf(activeKey);
    const original = byId[activeKey];
    const originalIndex = original ? columns[original.status].findIndex((task) => task.id === activeKey) : -1;
    if (original && original.status === status && originalIndex === index) return;
    onMoveTask(activeKey, status, index);
    setAnnouncement(`Moved to ${TASK_STATUS_LABEL[status]}, position ${index + 1}.`);
  };

  const onCardKeyDown = (task: ProjectTask) => (event: KeyboardEvent<HTMLElement>) => {
    const direction = event.altKey ? KEY_DIRECTION[event.key] : undefined;
    if (!direction) return;
    event.preventDefault();
    const target = keyboardMoveTarget(columns, statuses, task.id, direction);
    if (!target) return;
    onMoveTask(task.id, target.status, target.index);
    setAnnouncement(`${task.title} moved to ${TASK_STATUS_LABEL[target.status]}, position ${target.index + 1}.`);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-task-id="${globalThis.CSS?.escape ? globalThis.CSS.escape(task.id) : task.id}"] [role="button"]`)?.focus();
    });
  };

  const activeTask = activeId ? byId[activeId] : undefined;
  return <DndContext sensors={sensors} collisionDetection={boardCollisionDetection} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}
    onDragCancel={() => { setDragIds(null); setActiveId(null); }}>
    <p id={instructionsId} className="sr-only">Press Enter to open. Hold Alt and use the arrow keys to move the card.</p>
    <p className="sr-only" aria-live="polite">{announcement}</p>
    <BoardScrollRow>
      {statuses.map((status) => <BoardColumn key={status} status={status} count={columns[status].length}
        onQuickCreate={(title) => onQuickCreate(status, title)}>
        <SortableContext id={`${COLUMN_PREFIX}${status}`} items={ids[status] ?? []} strategy={verticalListSortingStrategy}>
          {(ids[status] ?? []).map((id) => {
            const task = byId[id];
            if (!task) return null;
            return <SortableTaskCard key={id} task={task} members={members} nowMs={nowMs}
              subtaskCount={counts[task.id] ?? 0} openBlockerCount={openBlockers(task)} describedBy={instructionsId}
              onOpen={() => onOpenTask(task)} onKeyDown={onCardKeyDown(task)} />;
          })}
        </SortableContext>
      </BoardColumn>)}
    </BoardScrollRow>
    <DragOverlay dropAnimation={null}>
      {activeTask ? <TaskCard task={activeTask} members={members} nowMs={nowMs} overlay
        subtaskCount={counts[activeTask.id] ?? 0} openBlockerCount={openBlockers(activeTask)} /> : null}
    </DragOverlay>
  </DndContext>;
}

function SortableTaskCard(props: Omit<Parameters<typeof TaskCard>[0], "cardRef" | "style" | "dragHandleProps" | "placeholder">) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.task.id });
  return <li className="list-none">
    <TaskCard {...props} cardRef={setNodeRef} placeholder={isDragging} dragHandleProps={listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }} />
  </li>;
}

function BoardColumn({ status, count, onQuickCreate, children }: {
  status: TaskStatus; count: number; onQuickCreate(title: string): Promise<boolean>; children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status}` });
  const [composing, setComposing] = useState(false);
  const label = TASK_STATUS_LABEL[status];
  return <section aria-label={`${label}, ${count} ${count === 1 ? "task" : "tasks"}`} data-column={status}
    className="flex max-h-full min-w-[240px] max-w-[340px] flex-1 basis-0 flex-col rounded-[14px]"
    style={{ background: isOver ? "var(--bg-hover)" : "var(--bg-sunken, var(--muted))" }}>
    <header className="flex h-10 shrink-0 items-center gap-2 px-3">
      <StatusIcon status={status} />
      <h3 className="text-[13px] font-semibold" style={tone.primary}>{label}</h3>
      <span className="text-[12px]" style={tone.muted}>{count}</span>
      <button type="button" aria-label={`Add a task to ${label}`} title={`Add a task to ${label}`} onClick={() => setComposing(true)}
        className={`ml-auto grid size-7 place-items-center rounded-lg hover:bg-[var(--bg-hover)] ${focusRing}`} style={tone.secondary}>
        <Plus size={15} aria-hidden />
      </button>
    </header>
    <ul ref={setNodeRef} className="flex min-h-[48px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
      {composing ? <li className="list-none"><QuickCreate label={label} onCancel={() => setComposing(false)}
        onSubmit={async (title) => { const created = await onQuickCreate(title); if (created) setComposing(false); return created; }} /></li> : null}
      {children}
    </ul>
  </section>;
}

function QuickCreate({ label, onSubmit, onCancel }: { label: string; onSubmit(title: string): Promise<boolean>; onCancel(): void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      if (await onSubmit(trimmed)) setTitle("");
    } finally {
      setBusy(false);
    }
  };
  return <div className="rounded-[12px] border p-2" style={{ ...tone.border, background: "var(--bg-surface, var(--card))" }}>
    <textarea aria-label={`New task in ${label}`} placeholder="Task title" rows={2} maxLength={300} value={title} disabled={busy}
      ref={focusOnMount}
      onChange={(event) => setTitle(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
      }}
      onBlur={() => { if (!title.trim()) onCancel(); }}
      className="block w-full resize-none bg-transparent text-[13.5px] leading-[18px] outline-none" style={tone.primary} />
    <p className="mt-1 text-[11px]" style={tone.muted}>Enter to add · Esc to cancel</p>
  </div>;
}

