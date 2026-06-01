import {
  DEFAULT_COLUMNS,
  createBoard,
  type Board,
  type BoardColumn,
  type Card,
  type ChecklistItem,
  type Priority,
} from "./board-model";

// Persistence bridges the pure, UI-free board model to owner-controlled
// Postgres via window.MatrixOS.db. The board model keeps a single implicit
// project; the durable schema only persists columns + cards.

export const COLUMNS_TABLE = "columns";
export const CARDS_TABLE = "cards";
const LOCAL_KEY = "task-manager:board";
const DEFAULT_PROJECT_ID = "project-default";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asPriority(value: unknown): Priority {
  return value === "low" || value === "medium" || value === "high" || value === "urgent"
    ? value
    : "medium";
}

function parseLabels(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    return value.split(",").map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

function parseChecklist(value: unknown): ChecklistItem[] {
  let raw: unknown = value;
  if (typeof value === "string" && value.trim()) {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ChecklistItem | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.text !== "string") return null;
      return {
        id: typeof record.id === "string" ? record.id : `check-${Math.random().toString(36).slice(2, 8)}`,
        text: record.text,
        done: record.done === true,
      };
    })
    .filter((item): item is ChecklistItem => item !== null);
}

function parseDue(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  // Detail panel uses yyyy-mm-dd; timestamptz round-trips include time.
  return value.slice(0, 10);
}

/** Build the in-memory board from raw DB column + card rows. */
export function boardFromRows(columnRows: Record<string, unknown>[], cardRows: Record<string, unknown>[]): Board {
  const columns: BoardColumn[] = columnRows
    .slice()
    .sort((a, b) => asNumber(a.position) - asNumber(b.position))
    .map((row) => ({
      id: asString(row.id),
      title: asString(row.title, "Untitled"),
      color: asString(row.color, "#7A7768"),
    }))
    .filter((column) => column.id);

  const columnIds = new Set(columns.map((column) => column.id));
  const fallbackColumnId = columns[0]?.id ?? "";

  const cards: Card[] = cardRows
    .slice()
    .sort((a, b) => asNumber(a.position) - asNumber(b.position))
    .map((row) => {
      const columnId = asString(row.column_id);
      return {
        id: asString(row.id),
        projectId: DEFAULT_PROJECT_ID,
        columnId: columnIds.has(columnId) ? columnId : fallbackColumnId,
        title: asString(row.title, "Untitled card"),
        description: asString(row.description),
        priority: asPriority(row.priority),
        labels: parseLabels(row.labels),
        assignee: asString(row.assignee),
        dueDate: parseDue(row.due),
        checklist: parseChecklist(row.checklist),
        delegation: null,
        order: asNumber(row.position),
        createdAt: asString(row.created_at, new Date().toISOString()),
        updatedAt: asString(row.created_at, new Date().toISOString()),
      };
    })
    .filter((card) => card.id && card.columnId);

  return {
    version: 1,
    projects: [{ id: DEFAULT_PROJECT_ID, name: "Board", color: "#434E3F", description: "" }],
    columns: columns.length > 0 ? columns : DEFAULT_COLUMNS,
    cards,
    updatedAt: new Date().toISOString(),
  };
}

/** Serialize a card's app-shaped fields into DB column values. */
export function cardToRow(card: Card, position: number): Record<string, unknown> {
  return {
    column_id: card.columnId,
    title: card.title,
    description: card.description,
    labels: card.labels.join(", "),
    assignee: card.assignee,
    priority: card.priority,
    due: card.dueDate ? card.dueDate : null,
    checklist: card.checklist,
    position,
  };
}

export function columnToRow(column: BoardColumn, position: number): Record<string, unknown> {
  return { title: column.title, color: column.color, position };
}

// ---- localStorage fallback (only used when window.MatrixOS.db is undefined) ----

export function loadLocalBoard(): Board | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Board;
  } catch (err: unknown) {
    console.warn("[task-manager] local board parse failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function saveLocalBoard(board: Board): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(board));
  } catch (err: unknown) {
    console.warn("[task-manager] local board save failed:", err instanceof Error ? err.message : String(err));
  }
}

export function emptyBoard(): Board {
  return createBoard("Board");
}
