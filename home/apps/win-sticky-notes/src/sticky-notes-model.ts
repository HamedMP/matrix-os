// Pure, UI-free helpers for the Sticky Notes (win11) app. Unit-tested in
// tests/default-apps/win-sticky-notes-model.test.ts.

export type NoteColorId = "yellow" | "pink" | "green" | "blue" | "purple" | "gray";

export interface NoteColor {
  id: NoteColorId;
  label: string;
  /** Pastel paper fill for the editor and list chip. */
  paper: string;
  /** Slightly deeper tint for the editor top bar. */
  chrome: string;
}

/** Windows 11 Sticky Notes pastel palette; yellow is the classic default. */
export const NOTE_COLORS: readonly NoteColor[] = [
  { id: "yellow", label: "Yellow", paper: "#FDF2A9", chrome: "#F6E27E" },
  { id: "pink", label: "Pink", paper: "#FCD9E4", chrome: "#F3B4C8" },
  { id: "green", label: "Green", paper: "#D9F2D5", chrome: "#B2E2A9" },
  { id: "blue", label: "Blue", paper: "#D2E8F9", chrome: "#A9D2F0" },
  { id: "purple", label: "Purple", paper: "#E5DFF6", chrome: "#C7BBE8" },
  { id: "gray", label: "Gray", paper: "#E9E9E9", chrome: "#CFCFCF" },
];

export const DEFAULT_NOTE_COLOR: NoteColorId = "yellow";
// Values are JSON-serialized by the app bridge and then embedded in the
// /api/bridge/data request. These caps keep the worst-case double-escaped
// document below that route's 1 MB body limit.
export const MAX_NOTE_TEXT = 2_000;
export const MAX_NOTES = 100;

/** Bridge KV key for the persisted note list. */
export const NOTES_KEY = "win-sticky-notes/notes";

export interface StickyNote {
  id: string;
  text: string;
  color: NoteColorId;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms; bumps on every edit, drives list ordering + timestamps. */
  updatedAt: number;
}

export function colorFor(id: NoteColorId): NoteColor {
  return NOTE_COLORS.find((c) => c.id === id) ?? NOTE_COLORS[0];
}

export function isNoteColorId(value: unknown): value is NoteColorId {
  return typeof value === "string" && NOTE_COLORS.some((c) => c.id === value);
}

function clampTime(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 8.64e15); // max Date
}

/** Coerce a stored JSON value into notes; anything malformed is dropped. */
export function parseStickyNotes(value: unknown): StickyNote[] {
  if (typeof value === "string") {
    if (value.length > 1_000_000) return [];
    try {
      return parseStickyNotes(JSON.parse(value));
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return [];
      throw err;
    }
  }
  if (!Array.isArray(value)) return [];
  const out: StickyNote[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    const createdAt = clampTime(record.createdAt, 0);
    out.push({
      id: record.id,
      text: typeof record.text === "string" ? record.text.slice(0, MAX_NOTE_TEXT) : "",
      color: isNoteColorId(record.color) ? record.color : DEFAULT_NOTE_COLOR,
      createdAt,
      updatedAt: clampTime(record.updatedAt, createdAt),
    });
  }
  return out.slice(0, MAX_NOTES);
}

export function createNote(id: string, now: number): StickyNote {
  return { id, text: "", color: DEFAULT_NOTE_COLOR, createdAt: now, updatedAt: now };
}

/** First non-empty line, used as the list title. Falls back to a placeholder. */
export function noteSnippet(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }
  return "New note";
}

/** Most recently edited first; stable for equal timestamps. */
export function sortNotesByRecency(notes: readonly StickyNote[]): StickyNote[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => b.note.updatedAt - a.note.updatedAt || a.index - b.index)
    .map(({ note }) => note);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative timestamp for the list pane, e.g. "Just now", "5 min ago",
 * "3 hr ago", "Yesterday", or a short date for older notes.
 */
export function formatNoteTime(updatedAt: number, now: number): string {
  const diff = now - updatedAt;
  if (diff < 45_000) return "Just now";
  if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MINUTE))} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hr ago`;
  const date = new Date(updatedAt);
  const reference = new Date(now);
  const yesterday = new Date(reference);
  yesterday.setDate(reference.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  ) return "Yesterday";
  const sameYear = date.getFullYear() === reference.getFullYear();
  return date.toLocaleDateString("en-US", sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}
