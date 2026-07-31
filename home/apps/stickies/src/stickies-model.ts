export type StickyColorId = "yellow" | "pink" | "green" | "blue" | "purple";

export interface StickyColor {
  id: StickyColorId;
  /** Translucent fill — alpha keeps the glass blur visible underneath. */
  background: string;
  /** Slightly deeper tint for the drag header. */
  header: string;
}

export const STICKY_COLORS: readonly StickyColor[] = [
  { id: "yellow", background: "rgba(254, 240, 160, 0.68)", header: "rgba(247, 222, 110, 0.72)" },
  { id: "pink", background: "rgba(251, 211, 224, 0.68)", header: "rgba(246, 183, 205, 0.72)" },
  { id: "green", background: "rgba(214, 244, 206, 0.68)", header: "rgba(186, 233, 174, 0.72)" },
  { id: "blue", background: "rgba(210, 231, 251, 0.68)", header: "rgba(178, 213, 247, 0.72)" },
  { id: "purple", background: "rgba(232, 223, 247, 0.68)", header: "rgba(212, 198, 240, 0.72)" },
];

export const STICKY_WIDTH = 240;
export const STICKY_MIN_HEIGHT = 170;
export const MAX_STICKY_TEXT = 20_000;
export const MAX_STICKY_NOTES = 100;
// Bridge writes have a 1 MB request cap and structured values are JSON encoded
// twice (the bridge envelope and the request body). Keep enough headroom for
// worst-case escaped text plus note metadata.
export const MAX_STICKY_TOTAL_TEXT = 100_000;

export interface StickyNote {
  id: string;
  x: number;
  y: number;
  z: number;
  text: string;
  color: StickyColorId;
}

export function colorFor(id: StickyColorId): StickyColor {
  return STICKY_COLORS.find((c) => c.id === id) ?? STICKY_COLORS[0];
}

function isStickyColorId(value: unknown): value is StickyColorId {
  return typeof value === "string" && STICKY_COLORS.some((c) => c.id === value);
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, n));
}

export function parseStickyNotes(value: unknown): StickyNote[] | null {
  if (typeof value === "string") {
    if (value.length > 1_000_000) return null;
    try {
      return parseStickyNotes(JSON.parse(value));
    } catch (err: unknown) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }
  if (!Array.isArray(value)) return null;
  const out: StickyNote[] = [];
  let remainingText = MAX_STICKY_TOTAL_TEXT;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    const text = typeof record.text === "string"
      ? record.text.slice(0, Math.min(MAX_STICKY_TEXT, remainingText))
      : "";
    remainingText -= text.length;
    out.push({
      id: record.id,
      x: clampNumber(record.x, 24, 4000),
      y: clampNumber(record.y, 24, 4000),
      z: clampNumber(record.z, 1, 100000),
      text,
      color: isStickyColorId(record.color) ? record.color : "yellow",
    });
  }
  return out.slice(0, MAX_STICKY_NOTES);
}

export function clampStickyText(notes: readonly StickyNote[], id: string, value: string): string {
  const otherTextLength = notes.reduce(
    (total, note) => total + (note.id === id ? 0 : note.text.length),
    0,
  );
  const available = Math.max(0, MAX_STICKY_TOTAL_TEXT - otherTextLength);
  return value.slice(0, Math.min(MAX_STICKY_TEXT, available));
}

export function welcomeNote(): StickyNote {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `sticky-${Date.now()}`,
    x: 32,
    y: 64,
    z: 1,
    text: "Welcome to Stickies!\n\nDrag notes by their top bar, close them with the red dot, and press + for a new one. Everything saves automatically.",
    color: "yellow",
  };
}
