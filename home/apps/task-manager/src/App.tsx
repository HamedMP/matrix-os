import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  Circle,
  ClipboardList,
  FolderKanban,
  GripVertical,
  LayoutDashboard,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  addCard,
  addChecklistItem,
  addProject,
  createSeedBoard,
  deleteCard,
  hydrateBoard,
  moveCard,
  summarizeBoard,
  toggleChecklistItem,
  updateCard,
  type Board,
  type Card,
  type Priority,
} from "./board-model";

const APP_ID = "task-manager";
const BOARD_KEY = "project-board";
const FETCH_TIMEOUT_MS = 10_000;

async function readBoard(): Promise<Board> {
  const params = new URLSearchParams({ app: APP_ID, key: BOARD_KEY });
  const response = await fetch(`/api/bridge/data?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return createSeedBoard();
  const payload = (await response.json()) as { value?: string | null };
  if (!payload.value) return createSeedBoard();
  try {
    return hydrateBoard(JSON.parse(payload.value));
  } catch (err: unknown) {
    console.warn("[task-manager] ignored invalid board payload:", err instanceof Error ? err.message : String(err));
    return createSeedBoard();
  }
}

async function writeBoard(board: Board): Promise<void> {
  await fetch("/api/bridge/data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      action: "write",
      app: APP_ID,
      key: BOARD_KEY,
      value: JSON.stringify(board),
    }),
  });
}

function priorityClass(priority: Priority): string {
  return `priority priority--${priority}`;
}

function CardView({
  card,
  projectName,
  onOpen,
  onDragStart,
}: {
  card: Card;
  projectName: string;
  onOpen: () => void;
  onDragStart: () => void;
}) {
  const done = card.checklist.filter((item) => item.done).length;
  return (
    <article className="task-card" draggable onDragStart={onDragStart}>
      <button className="task-card__open" type="button" onClick={onOpen}>
        <span className="task-card__drag">
          <GripVertical size={14} />
        </span>
        <span className="task-card__title">{card.title}</span>
        <span className={priorityClass(card.priority)}>{card.priority}</span>
      </button>
      {card.description ? <p>{card.description}</p> : null}
      <div className="label-row">
        {card.labels.map((label) => (
          <span className="label" key={label}>{label}</span>
        ))}
      </div>
      <footer className="task-card__meta">
        <span><FolderKanban size={13} />{projectName}</span>
        {card.dueDate ? <span><CalendarDays size={13} />{card.dueDate}</span> : null}
        {card.assignee ? <span><Users size={13} />{card.assignee}</span> : null}
        {card.checklist.length > 0 ? <span><CheckCircle2 size={13} />{done}/{card.checklist.length}</span> : null}
      </footer>
    </article>
  );
}

function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    readBoard()
      .then(setBoard)
      .catch((err: unknown) => {
        console.warn("[task-manager] load failed:", err instanceof Error ? err.message : String(err));
        setBoard(createSeedBoard());
        setError("Board could not be loaded.");
      });
  }, []);

  const saveBoard = useCallback((nextBoard: Board) => {
    setBoard(nextBoard);
    writeBoard(nextBoard).catch((err: unknown) => {
      console.warn("[task-manager] save failed:", err instanceof Error ? err.message : String(err));
      setError("Board could not be saved.");
    });
  }, []);

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
        ...card.labels,
        board.projects.find((project) => project.id === card.projectId)?.name ?? "",
      ].join(" ").toLowerCase().includes(normalizedQuery);
    });
  }, [activeProjectId, board, query]);

  const createCard = useCallback((columnId: string) => {
    if (!board || !newCardTitle.trim()) return;
    const projectId = activeProjectId === "all" ? board.projects[0].id : activeProjectId;
    saveBoard(addCard(board, {
      columnId,
      projectId,
      title: newCardTitle,
      priority: "medium",
      labels: [],
    }));
    setNewCardTitle("");
  }, [activeProjectId, board, newCardTitle, saveBoard]);

  const createProject = useCallback(() => {
    if (!board || !newProjectName.trim()) return;
    const nextBoard = addProject(board, newProjectName);
    saveBoard(nextBoard);
    setActiveProjectId(nextBoard.projects[nextBoard.projects.length - 1].id);
    setNewProjectName("");
  }, [board, newProjectName, saveBoard]);

  if (!board || !summary) {
    return <div className="loading">Opening Task Manager</div>;
  }

  const projectById = Object.fromEntries(board.projects.map((project) => [project.id, project]));

  return (
    <main className="board-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="app-icon"><LayoutDashboard size={24} /></span>
          <div>
            <span className="eyebrow">Project boards</span>
            <h1>Task Manager</h1>
          </div>
        </div>
        <label className="search-field">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cards" />
        </label>
      </header>

      <section className="summary-grid" aria-label="Board summary">
        <div className="summary-card"><ClipboardList size={17} /><span>{summary.totalCards}</span><small>Cards</small></div>
        <div className="summary-card"><FolderKanban size={17} /><span>{summary.activeProjects}</span><small>Active projects</small></div>
        <div className="summary-card"><CheckCircle2 size={17} /><span>{summary.doneCards}</span><small>Done</small></div>
        <div className="summary-card"><Archive size={17} /><span>{summary.checklistDone}/{summary.checklistTotal}</span><small>Checklist</small></div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="control-row">
        <div className="project-tabs">
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

      <form className="quick-add" onSubmit={(event) => { event.preventDefault(); createCard("backlog"); }}>
        <input value={newCardTitle} onChange={(event) => setNewCardTitle(event.target.value)} placeholder="Add a card to Backlog" />
        <button className="button button--primary" type="submit"><Plus size={15} />Add card</button>
      </form>

      <section className="board" aria-label="Kanban board">
        {board.columns.map((column) => {
          const cards = visibleCards
            .filter((card) => card.columnId === column.id)
            .sort((a, b) => a.order - b.order);
          return (
            <div
              className="column"
              key={column.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (!draggingCardId) return;
                saveBoard(moveCard(board, draggingCardId, column.id, cards.length));
                setDraggingCardId(null);
              }}
            >
              <header className="column__header">
                <span style={{ background: column.color }} />
                <h2>{column.title}</h2>
                <strong>{cards.length}</strong>
              </header>
              <div className="column__cards">
                {cards.map((card, index) => (
                  <div
                    key={card.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.stopPropagation();
                      if (!draggingCardId) return;
                      saveBoard(moveCard(board, draggingCardId, column.id, index));
                      setDraggingCardId(null);
                    }}
                  >
                    <CardView
                      card={card}
                      projectName={projectById[card.projectId]?.name ?? "Project"}
                      onOpen={() => setSelectedCardId(card.id)}
                      onDragStart={() => setDraggingCardId(card.id)}
                    />
                  </div>
                ))}
                {cards.length === 0 ? <div className="column-empty">Drop cards here</div> : null}
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
                <span className="eyebrow">Card</span>
                <h2>{selectedCard.title}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setSelectedCardId(null)} title="Close">
                <X size={18} />
              </button>
            </header>
            <label>
              Title
              <input
                value={selectedCard.title}
                onChange={(event) => saveBoard(updateCard(board, selectedCard.id, { title: event.target.value }))}
              />
            </label>
            <label>
              Description
              <textarea
                value={selectedCard.description}
                onChange={(event) => saveBoard(updateCard(board, selectedCard.id, { description: event.target.value }))}
              />
            </label>
            <div className="field-grid">
              <label>
                Priority
                <select
                  value={selectedCard.priority}
                  onChange={(event) => saveBoard(updateCard(board, selectedCard.id, { priority: event.target.value as Priority }))}
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
                  onChange={(event) => saveBoard(updateCard(board, selectedCard.id, { dueDate: event.target.value }))}
                />
              </label>
            </div>
            <label>
              Assignee
              <input
                value={selectedCard.assignee}
                onChange={(event) => saveBoard(updateCard(board, selectedCard.id, { assignee: event.target.value }))}
                placeholder="Owner"
              />
            </label>
            <label>
              Labels
              <input
                value={selectedCard.labels.join(", ")}
                onChange={(event) => saveBoard(updateCard(board, selectedCard.id, {
                  labels: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                }))}
                placeholder="design, launch"
              />
            </label>
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
              Delete card
            </button>
          </section>
        </aside>
      ) : null}
    </main>
  );
}

export default App;
