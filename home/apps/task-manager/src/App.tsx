import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  Circle,
  ClipboardList,
  FolderKanban,
  GripVertical,
  LayoutDashboard,
  ListChecks,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  addCard,
  addChecklistItem,
  addProject,
  clearDelegation,
  createSeedBoard,
  delegateCard,
  deleteCard,
  hydrateBoard,
  moveCard,
  moveCardToAdjacentColumn,
  resolveColumnId,
  summarizeBoard,
  toggleChecklistItem,
  updateCard,
  type Board,
  type Card,
  type CardDelegation,
  type DelegationStatus,
  type DelegationTarget,
  type DelegationTrigger,
  type Priority,
} from "./board-model";

const APP_ID = "task-manager";
const BOARD_KEY = "project-board";
const FETCH_TIMEOUT_MS = 10_000;

const TRIGGER_LABELS: Record<DelegationTrigger, string> = {
  manual: "Manual",
  when_ready: "When ready",
  on_review: "On review",
  scheduled: "Scheduled",
};

const STATUS_LABELS: Record<DelegationStatus, string> = {
  queued: "Queued",
  active: "Active",
  blocked: "Blocked",
  done: "Done",
};

const DELEGATION_LABELS: Record<DelegationTarget, string> = {
  matrix: "Matrix",
  hermes: "Hermes",
};

type DraftDelegationTarget = DelegationTarget | "none";

interface QuickDraft {
  title: string;
  columnId: string;
  priority: Priority;
  delegationTarget: DraftDelegationTarget;
}

function makeDefaultQuickDraft(board?: Board | null): QuickDraft {
  return {
    title: "",
    columnId: board ? resolveColumnId(board, null) : "backlog",
    priority: "medium",
    delegationTarget: "none",
  };
}

const DEFAULT_QUICK_DRAFT: QuickDraft = makeDefaultQuickDraft();

async function readBoard(): Promise<Board> {
  const params = new URLSearchParams({ app: APP_ID, key: BOARD_KEY });
  const response = await fetch(`/api/bridge/data?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return createSeedBoard();
  if (!response.headers.get("content-type")?.includes("application/json")) return createSeedBoard();
  let payload: { value?: string | null } | null;
  try {
    payload = (await response.json()) as { value?: string | null } | null;
  } catch (err: unknown) {
    throw new Error(`Bridge returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!payload?.value) return createSeedBoard();
  try {
    return hydrateBoard(JSON.parse(payload.value));
  } catch (err: unknown) {
    throw new Error(`Bridge returned invalid board payload: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  if (!signal) return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function writeBoard(board: Board, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/bridge/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: timeoutSignal(signal),
    body: JSON.stringify({
      action: "write",
      app: APP_ID,
      key: BOARD_KEY,
      value: JSON.stringify(board),
    }),
  });
  if (!response.ok) {
    throw new Error("Board save failed");
  }
}

function priorityClass(priority: Priority): string {
  return `priority priority--${priority}`;
}

function delegationClass(target: DelegationTarget): string {
  return `delegation-badge delegation-badge--${target}`;
}

function defaultDelegationInstructions(card: Card): string {
  return card.description.trim() || card.title;
}

function columnCardCount(board: Board, columnId: string): number {
  return board.cards.filter((card) => card.columnId === columnId).length;
}

function cardDropIndex(board: Board, targetCardId: string, movingCardId: string): number {
  const targetCard = board.cards.find((card) => card.id === targetCardId);
  if (!targetCard) return 0;
  const targetCards = board.cards
    .filter((card) => card.columnId === targetCard.columnId && card.id !== movingCardId)
    .sort((a, b) => a.order - b.order);
  const targetIndex = targetCards.findIndex((card) => card.id === targetCardId);
  return targetIndex < 0 ? targetCards.length : targetIndex;
}

function CardView({
  card,
  projectName,
  columnTitle,
  canMovePrevious,
  canMoveNext,
  onOpen,
  onDragStart,
  onMovePrevious,
  onMoveNext,
}: {
  card: Card;
  projectName: string;
  columnTitle: string;
  canMovePrevious: boolean;
  canMoveNext: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onMovePrevious: () => void;
  onMoveNext: () => void;
}) {
  const done = card.checklist.filter((item) => item.done).length;
  return (
    <article className={card.delegation ? "task-card task-card--delegated" : "task-card"} draggable onDragStart={onDragStart}>
      <button className="task-card__open" type="button" onClick={onOpen}>
        <span className="task-card__drag">
          <GripVertical size={14} />
        </span>
        <span className="task-card__main">
          <span className="task-card__title">{card.title}</span>
          <span className="task-card__status">{columnTitle}</span>
        </span>
        <span className={priorityClass(card.priority)}>{card.priority}</span>
      </button>
      {card.description ? <p>{card.description}</p> : null}
      <div className="label-row">
        {card.labels.map((label) => (
          <span className="label" key={label}>{label}</span>
        ))}
        {card.delegation ? (
          <span className={delegationClass(card.delegation.target)}>
            <Bot size={12} />
            {DELEGATION_LABELS[card.delegation.target]}
          </span>
        ) : null}
      </div>
      <footer className="task-card__meta">
        <span><FolderKanban size={13} />{projectName}</span>
        {card.dueDate ? <span><CalendarDays size={13} />{card.dueDate}</span> : null}
        {card.assignee ? <span><Users size={13} />{card.assignee}</span> : null}
        {card.checklist.length > 0 ? <span><CheckCircle2 size={13} />{done}/{card.checklist.length}</span> : null}
      </footer>
      <div className="task-card__actions">
        <button className="icon-button icon-button--compact" type="button" onClick={onMovePrevious} disabled={!canMovePrevious} title="Move previous">
          <ArrowLeft size={15} />
        </button>
        <button className="button button--compact" type="button" onClick={onOpen}>
          <ListChecks size={14} />
          Details
        </button>
        <button className="icon-button icon-button--compact" type="button" onClick={onMoveNext} disabled={!canMoveNext} title="Move next">
          <ArrowRight size={15} />
        </button>
      </div>
    </article>
  );
}

function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [quickDraft, setQuickDraft] = useState<QuickDraft>(DEFAULT_QUICK_DRAFT);
  const [columnDrafts, setColumnDrafts] = useState<Record<string, string>>({});
  const [newProjectName, setNewProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const detailSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    readBoard()
      .then((nextBoard) => {
        setBoard(nextBoard);
        setQuickDraft(makeDefaultQuickDraft(nextBoard));
      })
      .catch((err: unknown) => {
        console.warn("[task-manager] load failed:", err instanceof Error ? err.message : String(err));
        setError("Board could not be loaded.");
      });
  }, []);

  useEffect(() => {
    return () => {
      if (detailSaveTimerRef.current) clearTimeout(detailSaveTimerRef.current);
      saveAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!board) return;
    setQuickDraft((draft) => {
      const columnId = resolveColumnId(board, draft.columnId);
      return columnId === draft.columnId ? draft : { ...draft, columnId };
    });
  }, [board]);

  useEffect(() => {
    if (!selectedCardId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedCardId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedCardId]);

  const persistBoard = useCallback((nextBoard: Board) => {
    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    writeBoard(nextBoard, controller.signal)
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        console.warn("[task-manager] save failed:", err instanceof Error ? err.message : String(err));
        setError("Board could not be saved.");
      })
      .finally(() => {
        if (saveAbortRef.current === controller) saveAbortRef.current = null;
      });
  }, []);

  const saveBoard = useCallback((nextBoard: Board) => {
    if (detailSaveTimerRef.current) {
      clearTimeout(detailSaveTimerRef.current);
      detailSaveTimerRef.current = null;
    }
    setBoard(nextBoard);
    setError(null);
    persistBoard(nextBoard);
  }, [persistBoard]);

  const queueBoardSave = useCallback((nextBoard: Board) => {
    setBoard(nextBoard);
    setError(null);
    if (detailSaveTimerRef.current) clearTimeout(detailSaveTimerRef.current);
    detailSaveTimerRef.current = setTimeout(() => {
      detailSaveTimerRef.current = null;
      persistBoard(nextBoard);
    }, 400);
  }, [persistBoard]);

  const summary = useMemo(() => board ? summarizeBoard(board) : null, [board]);
  const selectedCard = board?.cards.find((card) => card.id === selectedCardId) ?? null;
  const visibleCards = useMemo(() => {
    if (!board) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return board.cards.filter((card) => {
      const projectMatch = activeProjectId === "all" || card.projectId === activeProjectId;
      if (!projectMatch) return false;
      if (!normalizedQuery) return true;
      return [
        card.title,
        card.description,
        card.assignee,
        card.priority,
        card.delegation?.target,
        card.delegation?.instructions,
        ...card.labels,
        board.projects.find((project) => project.id === card.projectId)?.name ?? "",
      ].join(" ").toLowerCase().includes(normalizedQuery);
    });
  }, [activeProjectId, board, query]);

  const createCard = useCallback((
    columnId: string,
    title: string,
    options?: { priority?: Priority; delegationTarget?: DraftDelegationTarget },
  ) => {
    if (!board || !title.trim()) return;
    const projectId = activeProjectId === "all" ? board.projects[0]?.id : activeProjectId;
    if (!projectId) return;
    const existingIds = new Set(board.cards.map((card) => card.id));
    const targetColumnId = resolveColumnId(board, columnId);
    let nextBoard = addCard(board, {
      columnId: targetColumnId,
      projectId,
      title,
      priority: options?.priority ?? "medium",
      labels: [],
    });
    const createdCard = nextBoard.cards.find((card) => !existingIds.has(card.id));
    if (createdCard && options?.delegationTarget && options.delegationTarget !== "none") {
      nextBoard = delegateCard(nextBoard, createdCard.id, {
        target: options.delegationTarget,
        trigger: "manual",
        instructions: createdCard.title,
      });
    }
    saveBoard(nextBoard);
  }, [activeProjectId, board, saveBoard]);

  const createProject = useCallback(() => {
    if (!board || !newProjectName.trim()) return;
    const nextBoard = addProject(board, newProjectName);
    saveBoard(nextBoard);
    setActiveProjectId(nextBoard.projects[nextBoard.projects.length - 1].id);
    setNewProjectName("");
  }, [board, newProjectName, saveBoard]);

  const updateSelectedCard = useCallback((patch: Partial<Omit<Card, "id" | "createdAt">>) => {
    if (!board || !selectedCard) return;
    queueBoardSave(updateCard(board, selectedCard.id, patch));
  }, [board, queueBoardSave, selectedCard]);

  const moveSelectedCard = useCallback((columnId: string) => {
    if (!board || !selectedCard || selectedCard.columnId === columnId) return;
    const targetCount = board.cards.filter((card) => card.columnId === columnId).length;
    saveBoard(moveCard(board, selectedCard.id, columnId, targetCount));
  }, [board, saveBoard, selectedCard]);

  const updateDelegation = useCallback((patch: Partial<Omit<CardDelegation, "updatedAt">>) => {
    if (!board || !selectedCard) return;
    const current = selectedCard.delegation;
    const target = patch.target ?? current?.target;
    if (!target) return;
    queueBoardSave(delegateCard(board, selectedCard.id, {
      target,
      trigger: patch.trigger ?? current?.trigger ?? "manual",
      instructions: patch.instructions ?? current?.instructions ?? defaultDelegationInstructions(selectedCard),
      status: patch.status ?? current?.status ?? "queued",
    }));
  }, [board, queueBoardSave, selectedCard]);

  const setDelegationTarget = useCallback((target: DraftDelegationTarget) => {
    if (!board || !selectedCard) return;
    if (target === "none") {
      saveBoard(clearDelegation(board, selectedCard.id));
      return;
    }
    saveBoard(delegateCard(board, selectedCard.id, {
      target,
      trigger: selectedCard.delegation?.trigger ?? "manual",
      instructions: selectedCard.delegation?.instructions ?? defaultDelegationInstructions(selectedCard),
      status: selectedCard.delegation?.status ?? "queued",
    }));
  }, [board, saveBoard, selectedCard]);

  if (!board || !summary) {
    return <div className="loading">{error ?? "Opening Task Manager"}</div>;
  }

  const projectById = Object.fromEntries(board.projects.map((project) => [project.id, project]));
  const columnById = Object.fromEntries(board.columns.map((column) => [column.id, column]));
  const selectedColumn = selectedCard ? columnById[selectedCard.columnId] : null;

  return (
    <main className="board-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="app-icon"><LayoutDashboard size={24} /></span>
          <div>
            <span className="eyebrow">Proactive board</span>
            <h1>Task Manager</h1>
          </div>
        </div>
        <label className="search-field">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks, projects, agents" />
        </label>
      </header>

      <section className="summary-grid" aria-label="Board summary">
        <div className="summary-card"><ClipboardList size={17} /><span>{summary.totalCards}</span><small>Tasks</small></div>
        <div className="summary-card"><FolderKanban size={17} /><span>{summary.activeProjects}</span><small>Projects</small></div>
        <div className="summary-card"><Send size={17} /><span>{summary.delegatedCards}</span><small>Delegated</small></div>
        <div className="summary-card"><Sparkles size={17} /><span>{summary.urgentCards}</span><small>Urgent</small></div>
        <div className="summary-card"><CheckCircle2 size={17} /><span>{summary.doneCards}</span><small>Done</small></div>
        <div className="summary-card"><Archive size={17} /><span>{summary.checklistDone}/{summary.checklistTotal}</span><small>Checklist</small></div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="control-row">
        <div className="project-tabs" aria-label="Project filter">
          <button className={activeProjectId === "all" ? "project-tab project-tab--active" : "project-tab"} type="button" onClick={() => setActiveProjectId("all")}>All</button>
          {board.projects.map((project) => (
            <button
              className={activeProjectId === project.id ? "project-tab project-tab--active" : "project-tab"}
              type="button"
              key={project.id}
              onClick={() => setActiveProjectId(project.id)}
            >
              <span style={{ background: project.color }} />
              {project.name}
            </button>
          ))}
        </div>
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); createProject(); }}>
          <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="New project" />
          <button className="button" type="submit"><Plus size={15} />Project</button>
        </form>
      </section>

      <form
        className="quick-add"
        onSubmit={(event) => {
          event.preventDefault();
          createCard(quickDraft.columnId, quickDraft.title, {
            priority: quickDraft.priority,
            delegationTarget: quickDraft.delegationTarget,
          });
          setQuickDraft((draft) => ({ ...draft, title: "", delegationTarget: "none" }));
        }}
      >
        <label className="quick-add__title">
          <span className="sr-only">Task title</span>
          <input
            value={quickDraft.title}
            onChange={(event) => setQuickDraft((draft) => ({ ...draft, title: event.target.value }))}
            placeholder="Capture a task"
          />
        </label>
        <label>
          <span className="sr-only">Status</span>
          <select value={quickDraft.columnId} onChange={(event) => setQuickDraft((draft) => ({ ...draft, columnId: event.target.value }))}>
            {board.columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Priority</span>
          <select value={quickDraft.priority} onChange={(event) => setQuickDraft((draft) => ({ ...draft, priority: event.target.value as Priority }))}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Agent</span>
          <select value={quickDraft.delegationTarget} onChange={(event) => setQuickDraft((draft) => ({ ...draft, delegationTarget: event.target.value as DraftDelegationTarget }))}>
            <option value="none">No agent</option>
            <option value="matrix">Matrix</option>
            <option value="hermes">Hermes</option>
          </select>
        </label>
        <button className="button button--primary" type="submit"><Plus size={15} />Add task</button>
      </form>

      <section className="board" aria-label="Kanban board">
        {board.columns.map((column, columnIndex) => {
          const cards = visibleCards
            .filter((card) => card.columnId === column.id)
            .sort((a, b) => a.order - b.order);
          const totalCards = columnCardCount(board, column.id);
          const draftValue = columnDrafts[column.id] ?? "";
          return (
            <div
              className="column"
              key={column.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (!draggingCardId) return;
                saveBoard(moveCard(board, draggingCardId, column.id, columnCardCount(board, column.id)));
                setDraggingCardId(null);
              }}
            >
              <header className="column__header">
                <span style={{ background: column.color }} />
                <div>
                  <h2>{column.title}</h2>
                  <small>{cards.length === totalCards ? `${totalCards} tasks` : `${cards.length}/${totalCards} shown`}</small>
                </div>
              </header>
              <form
                className="column__quick-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  createCard(column.id, draftValue);
                  setColumnDrafts((drafts) => ({ ...drafts, [column.id]: "" }));
                }}
              >
                <input
                  value={draftValue}
                  onChange={(event) => setColumnDrafts((drafts) => ({ ...drafts, [column.id]: event.target.value }))}
                  placeholder={`Add to ${column.title}`}
                />
                <button className="icon-button icon-button--compact" type="submit" title={`Add to ${column.title}`}>
                  <Plus size={15} />
                </button>
              </form>
              <div className="column__cards">
                {cards.map((card, index) => (
                  <div
                    key={card.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.stopPropagation();
                      if (!draggingCardId) return;
                      saveBoard(moveCard(board, draggingCardId, column.id, cardDropIndex(board, card.id, draggingCardId)));
                      setDraggingCardId(null);
                    }}
                  >
                    <CardView
                      card={card}
                      projectName={projectById[card.projectId]?.name ?? "Project"}
                      columnTitle={column.title}
                      canMovePrevious={columnIndex > 0}
                      canMoveNext={columnIndex < board.columns.length - 1}
                      onOpen={() => setSelectedCardId(card.id)}
                      onDragStart={() => setDraggingCardId(card.id)}
                      onMovePrevious={() => saveBoard(moveCardToAdjacentColumn(board, card.id, "previous"))}
                      onMoveNext={() => saveBoard(moveCardToAdjacentColumn(board, card.id, "next"))}
                    />
                  </div>
                ))}
                {cards.length === 0 ? (
                  <div className="column-empty">
                    <Circle size={16} />
                    <span>No tasks</span>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </section>

      {selectedCard ? (
        <aside className="detail-panel" aria-label="Card details">
          <div className="detail-panel__backdrop" onClick={() => setSelectedCardId(null)} />
          <section className="detail-panel__sheet">
            <header>
              <div>
                <span className="eyebrow">Task</span>
                <h2>{selectedCard.title}</h2>
                {selectedColumn ? <small>{selectedColumn.title}</small> : null}
              </div>
              <button className="icon-button" type="button" onClick={() => setSelectedCardId(null)} title="Close">
                <X size={18} />
              </button>
            </header>
            <label>
              Title
              <input
                value={selectedCard.title}
                onChange={(event) => updateSelectedCard({ title: event.target.value })}
              />
            </label>
            <label>
              Description
              <textarea
                value={selectedCard.description}
                onChange={(event) => updateSelectedCard({ description: event.target.value })}
              />
            </label>
            <div className="field-grid">
              <label>
                Status
                <select value={selectedCard.columnId} onChange={(event) => moveSelectedCard(event.target.value)}>
                  {board.columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
                </select>
              </label>
              <label>
                Project
                <select value={selectedCard.projectId} onChange={(event) => updateSelectedCard({ projectId: event.target.value })}>
                  {board.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
            </div>
            <div className="field-grid">
              <label>
                Priority
                <select
                  value={selectedCard.priority}
                  onChange={(event) => updateSelectedCard({ priority: event.target.value as Priority })}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
              <label>
                Due
                <input
                  type="date"
                  value={selectedCard.dueDate}
                  onChange={(event) => updateSelectedCard({ dueDate: event.target.value })}
                />
              </label>
            </div>
            <label>
              Assignee
              <input
                value={selectedCard.assignee}
                onChange={(event) => updateSelectedCard({ assignee: event.target.value })}
                placeholder="Owner"
              />
            </label>
            <label>
              Labels
              <input
                value={selectedCard.labels.join(", ")}
                onChange={(event) => updateSelectedCard({
                  labels: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                })}
                placeholder="design, launch"
              />
            </label>

            <section className="delegation-panel" aria-label="Agent delegation">
              <header>
                <h3><Bot size={16} />Delegate</h3>
                {selectedCard.delegation ? <span>{STATUS_LABELS[selectedCard.delegation.status]}</span> : <span>Unassigned</span>}
              </header>
              <div className="delegate-options" role="group" aria-label="Delegation target">
                {(["none", "matrix", "hermes"] as DraftDelegationTarget[]).map((target) => {
                  const active = target === "none" ? !selectedCard.delegation : selectedCard.delegation?.target === target;
                  return (
                    <button
                      className={active ? "delegate-option delegate-option--active" : "delegate-option"}
                      type="button"
                      key={target}
                      onClick={() => setDelegationTarget(target)}
                    >
                      {target === "none" ? <Circle size={14} /> : <Bot size={14} />}
                      {target === "none" ? "No agent" : DELEGATION_LABELS[target]}
                    </button>
                  );
                })}
              </div>
              {selectedCard.delegation ? (
                <div className="delegation-fields">
                  <div className="field-grid">
                    <label>
                      Trigger
                      <select
                        value={selectedCard.delegation.trigger}
                        onChange={(event) => updateDelegation({ trigger: event.target.value as DelegationTrigger })}
                      >
                        {Object.entries(TRIGGER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <label>
                      State
                      <select
                        value={selectedCard.delegation.status}
                        onChange={(event) => updateDelegation({ status: event.target.value as DelegationStatus })}
                      >
                        {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label>
                    Agent brief
                    <textarea
                      value={selectedCard.delegation.instructions}
                      onChange={(event) => updateDelegation({ instructions: event.target.value })}
                    />
                  </label>
                </div>
              ) : null}
            </section>

            <div className="checklist">
              <h3>Checklist</h3>
              {selectedCard.checklist.map((item) => (
                <button
                  className="checklist-item"
                  type="button"
                  key={item.id}
                  onClick={() => saveBoard(toggleChecklistItem(board, selectedCard.id, item.id))}
                >
                  {item.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                  {item.text}
                </button>
              ))}
              <form onSubmit={(event) => {
                event.preventDefault();
                const input = event.currentTarget.elements.namedItem("checklist") as HTMLInputElement;
                saveBoard(addChecklistItem(board, selectedCard.id, input.value));
                input.value = "";
              }}>
                <input name="checklist" placeholder="Add checklist item" />
              </form>
            </div>
            <button
              className="button button--danger"
              type="button"
              onClick={() => {
                saveBoard(deleteCard(board, selectedCard.id));
                setSelectedCardId(null);
              }}
            >
              <Trash2 size={15} />
              Delete task
            </button>
          </section>
        </aside>
      ) : null}
    </main>
  );
}

export default App;
