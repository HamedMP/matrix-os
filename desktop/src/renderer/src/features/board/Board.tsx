import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Kanban, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { AppError } from "../../../../shared/app-error";
import { useBoard, BOARD_COLUMNS, groupCardsByColumn, type Card, type CardStatus } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useGit } from "../../stores/git";
import { useSessions } from "../../stores/sessions";
import { useUi } from "../../stores/ui";
import BoardCard from "./BoardCard";
import CreateTaskDialog from "./CreateTaskDialog";

const COLUMN_LABEL: Record<CardStatus, string> = {
  todo: "Todo",
  running: "Running",
  waiting: "Waiting",
  blocked: "Blocked",
  complete: "Complete",
  archived: "Archived",
};

const EMPTY_CARDS: Card[] = [];

const COLUMN_COLOR: Record<CardStatus, string> = {
  todo: "var(--status-todo)",
  running: "var(--status-running)",
  waiting: "var(--status-waiting)",
  blocked: "var(--status-blocked)",
  complete: "var(--status-complete)",
  archived: "var(--status-todo)",
};

function midpointOrder(cards: Card[], beforeId: string | null): number {
  if (cards.length === 0) return 1;
  if (beforeId === null) return (cards[cards.length - 1]?.order ?? 0) + 1;
  const idx = cards.findIndex((c) => c.id === beforeId);
  if (idx <= 0) return (cards[0]?.order ?? 1) - 1;
  return ((cards[idx - 1]?.order ?? 0) + (cards[idx]?.order ?? 0)) / 2;
}

function Column({
  status,
  cards,
  activeDragId,
}: {
  status: CardStatus;
  cards: Card[];
  activeDragId: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });
  const openCreateTask = useUi((s) => s.openCreateTask);
  return (
    <div className="group/col flex w-[252px] shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="h-2 w-2 rounded-full" style={{ background: COLUMN_COLOR[status] }} />
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {COLUMN_LABEL[status]}
        </span>
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {cards.length}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={`New task in ${COLUMN_LABEL[status]}`}
          title={`New task in ${COLUMN_LABEL[status]}`}
          className="flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity duration-100 hover:bg-[var(--bg-hover)] group-hover/col:opacity-100"
          style={{ color: "var(--text-tertiary)" }}
          onClick={() => openCreateTask(status)}
        >
          <Plus size={14} />
        </button>
      </div>
      <div
        ref={setNodeRef}
        className="flex min-h-[120px] flex-1 flex-col gap-1.5 rounded-lg p-1 transition-colors duration-100"
        style={{ background: isOver ? "var(--bg-selected)" : "transparent" }}
      >
        {cards.map((card) => (
          <DraggableCard key={card.id} card={card} dragging={activeDragId === card.id} />
        ))}
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-100 hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={() => openCreateTask(status)}
        >
          <Plus size={13} />
          New task
        </button>
      </div>
    </div>
  );
}

function DraggableCard({ card, dragging }: { card: Card; dragging: boolean }) {
  const { setNodeRef, attributes, listeners } = useDraggable({ id: card.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `card:${card.id}` });
  return (
    <div ref={setDropRef} style={{ paddingTop: isOver ? 6 : 0, transition: "padding 80ms" }}>
      <div ref={setNodeRef} {...attributes} {...listeners} style={{ opacity: dragging ? 0.35 : 1 }}>
        <BoardCard card={card} />
      </div>
    </div>
  );
}

export default function Board({ projectSlug, active = true }: { projectSlug?: string; active?: boolean }) {
  const api = useConnection((s) => s.api);
  const fallbackSlug = useBoard((s) => s.activeProjectSlug);
  const activeSlug = projectSlug ?? fallbackSlug;
  const cards = useBoard((s) =>
    activeSlug ? (s.cardsByProject[activeSlug] ?? EMPTY_CARDS) : EMPTY_CARDS,
  );
  const firstLoadPending = useBoard((s) =>
    activeSlug ? (s.firstLoadByProject[activeSlug] ?? cards.length === 0) : false,
  );
  const error = useBoard((s) => s.error);
  const moveTask = useBoard((s) => s.moveTask);
  const selectProject = useBoard((s) => s.selectProject);
  const sessionsLoad = useSessions((s) => s.load);
  const gitLoadAll = useGit((s) => s.loadAll);
  const gitLoadPreviews = useGit((s) => s.loadPreviews);
  const createTaskOpen = useUi((s) => s.createTaskOpen);
  const setCreateTaskOpen = useUi((s) => s.setCreateTaskOpen);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // Only the focused board tab becomes the create-dialog context. Inactive
  // mounted board tabs must not clobber activeProjectSlug.
  useEffect(() => {
    if (api && activeSlug && active) void selectProject(api, activeSlug);
  }, [api, active, activeSlug, selectProject]);

  // Live development state for the card badges (session/branch/dirty/preview).
  useEffect(() => {
    if (!api || !activeSlug || !active) return;
    void sessionsLoad(api);
    void gitLoadAll(api, activeSlug);
    void gitLoadPreviews(api, activeSlug);
  }, [api, active, activeSlug, sessionsLoad, gitLoadAll, gitLoadPreviews]);

  const columns = useMemo(() => groupCardsByColumn(cards), [cards]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (event: DragStartEvent) => setActiveDragId(String(event.active.id));

  const onDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || !api || !activeSlug) return;
    const cardId = String(active.id);
    const overId = String(over.id);
    let targetStatus: CardStatus | null = null;
    let beforeId: string | null = null;
    if (overId.startsWith("column:")) {
      targetStatus = overId.slice("column:".length) as CardStatus;
    } else if (overId.startsWith("card:")) {
      const overCardId = overId.slice("card:".length);
      if (overCardId === cardId) return;
      const overCard = cards.find((c) => c.id === overCardId);
      if (!overCard) return;
      targetStatus = overCard.status;
      beforeId = overCard.id;
    }
    if (!targetStatus) return;
    const order = midpointOrder(columns[targetStatus] ?? [], beforeId);
    void moveTask(api, activeSlug, cardId, targetStatus, order);
  };

  const dragCard = activeDragId ? cards.find((c) => c.id === activeDragId) : null;

  if (firstLoadPending) {
    return (
      <div className="flex flex-1 gap-4 overflow-x-auto p-4">
        {BOARD_COLUMNS.map((status) => (
          <div key={status} className="flex w-[252px] shrink-0 flex-col gap-2">
            <div className="h-5 w-24 rounded" style={{ background: "var(--bg-raised)" }} />
            {["a", "b", "c"].map((slot) => (
              <div
                key={`${status}-${slot}`}
                className="status-pulse h-[72px] rounded-lg"
                style={{ background: "var(--bg-raised)" }}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (error && cards.length === 0) {
    return (
      <EmptyState
        icon={<Kanban size={28} />}
        headline="Can't load the board"
        description={toUserMessage(new AppError(error))}
        action={
          <Button
            variant="primary"
            onClick={() => {
              if (api && activeSlug) void useBoard.getState().refreshTasks(api, activeSlug);
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (cards.length === 0) {
    return (
      <>
        <EmptyState
          icon={<Kanban size={28} />}
          headline="No tasks yet"
          description="Create your first task to start working with your Matrix OS computer."
          action={
            <Button variant="primary" onClick={() => setCreateTaskOpen(true)}>
              New task
            </Button>
          }
        />
        <CreateTaskDialog open={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />
      </>
    );
  }

  return (
    <>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="flex flex-1 gap-4 overflow-x-auto p-4">
          {BOARD_COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              cards={columns[status] ?? []}
              activeDragId={activeDragId}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragCard ? <BoardCard card={dragCard} overlay /> : null}
        </DragOverlay>
      </DndContext>
      <CreateTaskDialog open={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />
    </>
  );
}
