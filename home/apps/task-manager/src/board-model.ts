export type Priority = "low" | "medium" | "high" | "urgent";
export type DelegationTarget = "matrix" | "hermes";
export type DelegationTrigger = "manual" | "when_ready" | "on_review" | "scheduled";
export type DelegationStatus = "queued" | "active" | "blocked" | "done";

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

export interface CardDelegation {
  target: DelegationTarget;
  trigger: DelegationTrigger;
  instructions: string;
  status: DelegationStatus;
  updatedAt: string;
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
  delegation: CardDelegation | null;
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
  delegation?: CardDelegation | null;
}

export interface DelegateCardInput {
  target: DelegationTarget;
  trigger?: DelegationTrigger;
  instructions?: string;
  status?: DelegationStatus;
}

export interface BoardSummary {
  totalCards: number;
  doneCards: number;
  activeProjects: number;
  checklistDone: number;
  checklistTotal: number;
  delegatedCards: number;
  urgentCards: number;
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
  const columnId = resolveColumnId(board, input.columnId);
  const columnCards = board.cards.filter((card) => card.columnId === columnId);
  const card: Card = {
    id: id("card"),
    projectId: input.projectId,
    columnId,
    title: input.title.trim() || "Untitled card",
    description: input.description?.trim() ?? "",
    priority: input.priority ?? "medium",
    labels: input.labels ?? [],
    assignee: input.assignee?.trim() ?? "",
    dueDate: input.dueDate ?? "",
    checklist: input.checklist ?? [],
    delegation: normalizeDelegation(input.delegation),
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

export function moveCardToAdjacentColumn(board: Board, cardId: string, direction: "previous" | "next"): Board {
  const card = board.cards.find((item) => item.id === cardId);
  if (!card) return board;
  const currentIndex = board.columns.findIndex((column) => column.id === card.columnId);
  if (currentIndex < 0) return board;
  const offset = direction === "next" ? 1 : -1;
  const targetIndex = Math.max(0, Math.min(board.columns.length - 1, currentIndex + offset));
  const targetColumn = board.columns[targetIndex];
  if (!targetColumn || targetColumn.id === card.columnId) return board;
  const targetCards = board.cards.filter((item) => item.columnId === targetColumn.id);
  return moveCard(board, cardId, targetColumn.id, targetCards.length);
}

export function delegateCard(board: Board, cardId: string, input: DelegateCardInput): Board {
  return updateCard(board, cardId, {
    delegation: {
      target: input.target,
      trigger: input.trigger ?? "manual",
      instructions: input.instructions?.trim() ?? "",
      status: input.status ?? "queued",
      updatedAt: now(),
    },
  });
}

export function clearDelegation(board: Board, cardId: string): Board {
  return updateCard(board, cardId, { delegation: null });
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

export function resolveColumnId(board: Board, preferredColumnId: string | null | undefined): string {
  if (preferredColumnId && board.columns.some((column) => column.id === preferredColumnId)) return preferredColumnId;
  return board.columns[0]?.id ?? "backlog";
}

export function summarizeBoard(board: Board): BoardSummary {
  const checklist = board.cards.flatMap((card) => card.checklist);
  const activeProjectIds = board.cards.reduce<string[]>((projectIds, card) => (
    projectIds.includes(card.projectId) ? projectIds : [...projectIds, card.projectId]
  ), []);
  const doneColumnId = resolveDoneColumnId(board);
  return {
    totalCards: board.cards.length,
    doneCards: doneColumnId ? board.cards.filter((card) => card.columnId === doneColumnId).length : 0,
    activeProjects: activeProjectIds.length,
    checklistDone: checklist.filter((item) => item.done).length,
    checklistTotal: checklist.length,
    delegatedCards: board.cards.filter((card) => card.delegation).length,
    urgentCards: board.cards.filter((card) => card.priority === "urgent").length,
  };
}

function resolveDoneColumnId(board: Board): string | null {
  const explicitDone = board.columns.find((column) => column.id === "done");
  if (explicitDone) return explicitDone.id;
  const semanticDone = board.columns.find((column) => /\b(done|complete|completed)\b/i.test(column.title));
  return semanticDone?.id ?? board.columns.at(-1)?.id ?? null;
}

export function hydrateBoard(value: unknown): Board {
  if (!value || typeof value !== "object") return createSeedBoard();
  const candidate = value as Partial<Board>;
  if (!Array.isArray(candidate.projects) || !Array.isArray(candidate.cards)) return createSeedBoard();
  const columns = Array.isArray(candidate.columns) && candidate.columns.length > 0 ? candidate.columns : DEFAULT_COLUMNS;
  const columnIds = new Set(columns.map((column) => column.id));
  const fallbackColumnId = columns[0]?.id ?? "backlog";
  return {
    version: 1,
    projects: candidate.projects.length > 0 ? candidate.projects : createBoard().projects,
    columns,
    cards: normalizeOrders(sortCards((candidate.cards as Card[]).map((card) => normalizeCard(card, columnIds, fallbackColumnId)))),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now(),
  };
}

function normalizeCard(card: Card, columnIds: Set<string>, fallbackColumnId: string): Card {
  return {
    ...card,
    id: typeof card.id === "string" && card.id ? card.id : id("card"),
    projectId: typeof card.projectId === "string" && card.projectId ? card.projectId : "",
    columnId: columnIds.has(card.columnId) ? card.columnId : fallbackColumnId,
    description: typeof card.description === "string" ? card.description : "",
    priority: isPriority(card.priority) ? card.priority : "medium",
    labels: Array.isArray(card.labels) ? card.labels.filter((label): label is string => typeof label === "string") : [],
    assignee: typeof card.assignee === "string" ? card.assignee : "",
    dueDate: typeof card.dueDate === "string" ? card.dueDate : "",
    checklist: Array.isArray(card.checklist)
      ? card.checklist.filter(isChecklistItem)
      : [],
    delegation: normalizeDelegation(card.delegation),
    createdAt: typeof card.createdAt === "string" ? card.createdAt : now(),
    updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : now(),
  };
}

function normalizeDelegation(value: unknown): CardDelegation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CardDelegation>;
  if (!isDelegationTarget(candidate.target)) return null;
  return {
    target: candidate.target,
    trigger: isDelegationTrigger(candidate.trigger) ? candidate.trigger : "manual",
    instructions: typeof candidate.instructions === "string" ? candidate.instructions : "",
    status: isDelegationStatus(candidate.status) ? candidate.status : "queued",
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now(),
  };
}

function isPriority(value: unknown): value is Priority {
  return value === "low" || value === "medium" || value === "high" || value === "urgent";
}

function isDelegationTarget(value: unknown): value is DelegationTarget {
  return value === "matrix" || value === "hermes";
}

function isDelegationTrigger(value: unknown): value is DelegationTrigger {
  return value === "manual" || value === "when_ready" || value === "on_review" || value === "scheduled";
}

function isDelegationStatus(value: unknown): value is DelegationStatus {
  return value === "queued" || value === "active" || value === "blocked" || value === "done";
}

function isChecklistItem(value: unknown): value is ChecklistItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChecklistItem>;
  return typeof item.id === "string" && typeof item.text === "string" && typeof item.done === "boolean";
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
