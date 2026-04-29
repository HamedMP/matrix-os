export type Priority = "low" | "medium" | "high" | "urgent";

export interface Project {
  id: string;
  name: string;
  color: string;
  description: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  color: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Card {
  id: string;
  projectId: string;
  columnId: string;
  title: string;
  description: string;
  priority: Priority;
  labels: string[];
  assignee: string;
  dueDate: string;
  checklist: ChecklistItem[];
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  version: 1;
  projects: Project[];
  columns: BoardColumn[];
  cards: Card[];
  updatedAt: string;
}

export interface NewCardInput {
  columnId: string;
  projectId: string;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  assignee?: string;
  dueDate?: string;
  checklist?: ChecklistItem[];
}

export interface BoardSummary {
  totalCards: number;
  doneCards: number;
  activeProjects: number;
  checklistDone: number;
  checklistTotal: number;
}

export const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: "backlog", title: "Backlog", color: "#64748b" },
  { id: "ready", title: "Ready", color: "#0ea5e9" },
  { id: "in-progress", title: "In progress", color: "#f59e0b" },
  { id: "review", title: "Review", color: "#8b5cf6" },
  { id: "done", title: "Done", color: "#10b981" },
];

const PROJECT_COLORS = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#e11d48"];
let sequence = 0;

function now(): string {
  sequence += 1;
  return new Date(Date.now() + sequence).toISOString();
}

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createBoard(projectName = "Launch project"): Board {
  const project: Project = {
    id: "project-default",
    name: projectName,
    color: PROJECT_COLORS[0],
    description: "Default workspace project",
  };
  return {
    version: 1,
    projects: [project],
    columns: DEFAULT_COLUMNS,
    cards: [],
    updatedAt: now(),
  };
}

export function createSeedBoard(): Board {
  let board = createBoard("Matrix OS");
  board = addProject(board, "Personal Ops", "Plans, errands, and recurring life admin");
  const defaultProjectId = board.projects[0].id;
  const personalProjectId = board.projects[1].id;

  board = addCard(board, {
    columnId: "backlog",
    projectId: defaultProjectId,
    title: "Design default app quality bar",
    description: "Capture what a professional Matrix OS app should feel like.",
    priority: "high",
    labels: ["product", "design"],
    assignee: "Hamed",
    checklist: [
      { id: "seed-1", text: "Notes upgrade", done: true },
      { id: "seed-2", text: "Task board upgrade", done: false },
    ],
  });
  board = addCard(board, {
    columnId: "ready",
    projectId: personalProjectId,
    title: "Plan weekly review",
    description: "Collect open tasks, sort by project, and pick this week's commitments.",
    priority: "medium",
    labels: ["planning"],
    dueDate: new Date(Date.now() + 86_400_000 * 3).toISOString().slice(0, 10),
  });
  board = addCard(board, {
    columnId: "in-progress",
    projectId: defaultProjectId,
    title: "Ship polished project boards",
    description: "Replace the old kernel task list with boards, projects, cards, and checklists.",
    priority: "urgent",
    labels: ["frontend", "default-apps"],
    assignee: "Matrix",
  });
  board = addCard(board, {
    columnId: "review",
    projectId: defaultProjectId,
    title: "Verify app rebuild",
    description: "Build Vite apps and refresh the user container for testing.",
    priority: "high",
    labels: ["release"],
  });
  return board;
}

export function addProject(board: Board, name: string, description = ""): Board {
  const project: Project = {
    id: id("project"),
    name: name.trim() || "Untitled project",
    color: PROJECT_COLORS[board.projects.length % PROJECT_COLORS.length],
    description,
  };
  return { ...board, projects: [...board.projects, project], updatedAt: now() };
}

export function addCard(board: Board, input: NewCardInput): Board {
  const columnCards = board.cards.filter((card) => card.columnId === input.columnId);
  const card: Card = {
    id: id("card"),
    projectId: input.projectId,
    columnId: input.columnId,
    title: input.title.trim() || "Untitled card",
    description: input.description?.trim() ?? "",
    priority: input.priority ?? "medium",
    labels: input.labels ?? [],
    assignee: input.assignee?.trim() ?? "",
    dueDate: input.dueDate ?? "",
    checklist: input.checklist ?? [],
    order: columnCards.length,
    createdAt: now(),
    updatedAt: now(),
  };
  return { ...board, cards: normalizeOrders([...board.cards, card]), updatedAt: now() };
}

export function updateCard(board: Board, cardId: string, patch: Partial<Omit<Card, "id" | "createdAt">>): Board {
  return {
    ...board,
    cards: board.cards.map((card) => (
      card.id === cardId ? { ...card, ...patch, updatedAt: now() } : card
    )),
    updatedAt: now(),
  };
}

export function deleteCard(board: Board, cardId: string): Board {
  return {
    ...board,
    cards: normalizeOrders(board.cards.filter((card) => card.id !== cardId)),
    updatedAt: now(),
  };
}

export function moveCard(board: Board, cardId: string, targetColumnId: string, targetIndex: number): Board {
  const moving = board.cards.find((card) => card.id === cardId);
  if (!moving) return board;

  const withoutMoving = board.cards.filter((card) => card.id !== cardId);
  const targetCards = withoutMoving
    .filter((card) => card.columnId === targetColumnId)
    .sort((a, b) => a.order - b.order);
  const nextIndex = Math.max(0, Math.min(targetIndex, targetCards.length));
  targetCards.splice(nextIndex, 0, { ...moving, columnId: targetColumnId, updatedAt: now() });

  const otherCards = withoutMoving.filter((card) => card.columnId !== targetColumnId);
  return {
    ...board,
    cards: normalizeOrders([...otherCards, ...targetCards]),
    updatedAt: now(),
  };
}

export function toggleChecklistItem(board: Board, cardId: string, itemId: string): Board {
  return updateCard(board, cardId, {
    checklist: board.cards
      .find((card) => card.id === cardId)
      ?.checklist.map((item) => (item.id === itemId ? { ...item, done: !item.done } : item)) ?? [],
  });
}

export function addChecklistItem(board: Board, cardId: string, text: string): Board {
  const card = board.cards.find((item) => item.id === cardId);
  if (!card) return board;
  return updateCard(board, cardId, {
    checklist: [...card.checklist, { id: id("check"), text: text.trim() || "Checklist item", done: false }],
  });
}

export function summarizeBoard(board: Board): BoardSummary {
  const checklist = board.cards.flatMap((card) => card.checklist);
  const activeProjectIds = board.cards.reduce<string[]>((projectIds, card) => (
    projectIds.includes(card.projectId) ? projectIds : [...projectIds, card.projectId]
  ), []);
  return {
    totalCards: board.cards.length,
    doneCards: board.cards.filter((card) => card.columnId === "done").length,
    activeProjects: activeProjectIds.length,
    checklistDone: checklist.filter((item) => item.done).length,
    checklistTotal: checklist.length,
  };
}

export function hydrateBoard(value: unknown): Board {
  if (!value || typeof value !== "object") return createSeedBoard();
  const candidate = value as Partial<Board>;
  if (!Array.isArray(candidate.projects) || !Array.isArray(candidate.cards)) return createSeedBoard();
  return {
    version: 1,
    projects: candidate.projects.length > 0 ? candidate.projects : createBoard().projects,
    columns: Array.isArray(candidate.columns) && candidate.columns.length > 0 ? candidate.columns : DEFAULT_COLUMNS,
    cards: normalizeOrders(sortCards(candidate.cards as Card[])),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now(),
  };
}

function normalizeOrders(cards: Card[]): Card[] {
  const nextOrderByColumn: Record<string, number> = {};
  return cards.map((card) => {
    const order = nextOrderByColumn[card.columnId] ?? 0;
    nextOrderByColumn[card.columnId] = order + 1;
    return { ...card, order };
  });
}

function sortCards(cards: Card[]): Card[] {
  return cards.slice().sort((a, b) => {
    if (a.columnId !== b.columnId) return a.columnId.localeCompare(b.columnId);
    return a.order - b.order;
  });
}
