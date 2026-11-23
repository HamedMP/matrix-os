/**
 * Geometry of the time grid and the keyboard map, kept free of React so it
 * can be tested on its own.
 */
import { MINUTES_PER_DAY } from "../model/dates";
import type { PositionedSegment } from "../model/layout";
import type { CalendarView } from "../model/ranges";

export const HOUR_HEIGHT = 48;
export const PX_PER_MINUTE = HOUR_HEIGHT / 60;
export const GRID_HEIGHT = MINUTES_PER_DAY * PX_PER_MINUTE;
export const SNAP_MINUTES = 15;
/** Pointer travel, in px, before a press becomes a drag instead of a click. */
export const DRAG_THRESHOLD_PX = 4;
/** Shortest event a resize can produce. */
export const MIN_EVENT_MINUTES = 15;

export function clampMinute(minute: number): number {
  return Math.min(MINUTES_PER_DAY, Math.max(0, minute));
}

/** The wall-clock minute under a vertical offset (px from the top of the grid), snapped down. */
export function minuteAtOffset(offsetPx: number, snap = SNAP_MINUTES): number {
  const raw = offsetPx / PX_PER_MINUTE;
  return clampMinute(Math.floor(raw / snap) * snap);
}

/** Rounds a minute delta to the snap step. */
export function snapDelta(minutes: number, snap = SNAP_MINUTES): number {
  return Math.round(minutes / snap) * snap;
}

/** Which day column an x offset falls in, clamped to the columns that exist. */
export function columnAtOffset(offsetPx: number, width: number, columns: number): number {
  if (columns <= 0 || width <= 0) return 0;
  return Math.min(columns - 1, Math.max(0, Math.floor((offsetPx / width) * columns)));
}

export interface BlockBox {
  top: number;
  height: number;
  /** Percent of the column width. */
  left: number;
  width: number;
}

/** Where a laid-out segment sits inside its day column. */
export function segmentBox(segment: Pick<PositionedSegment, "startMinute" | "endMinute" | "column" | "columnCount" | "span">): BlockBox {
  const columnWidth = 100 / Math.max(1, segment.columnCount);
  return {
    top: segment.startMinute * PX_PER_MINUTE,
    height: Math.max(MIN_EVENT_MINUTES, segment.endMinute - segment.startMinute) * PX_PER_MINUTE,
    left: segment.column * columnWidth,
    width: Math.max(1, segment.span) * columnWidth,
  };
}

/** A new event drawn by dragging from one minute to another (either direction). */
export function createSpan(fromMinute: number, toMinute: number, defaultMinutes: number): { start: number; end: number } {
  if (fromMinute === toMinute) return { start: fromMinute, end: clampMinute(fromMinute + defaultMinutes) };
  const start = Math.min(fromMinute, toMinute);
  const end = Math.max(fromMinute, toMinute);
  return { start, end: Math.max(end, start + SNAP_MINUTES) };
}

/** A resize: the new end minute, at least `MIN_EVENT_MINUTES` after the start. */
export function resizedEnd(startMinute: number, endMinute: number, deltaMinutes: number): number {
  return clampMinute(Math.max(startMinute + MIN_EVENT_MINUTES, endMinute + snapDelta(deltaMinutes)));
}

/** A move: the new start minute, kept inside the day so the event does not vanish off the grid. */
export function movedStart(startMinute: number, durationMinutes: number, deltaMinutes: number): number {
  const latest = Math.max(0, MINUTES_PER_DAY - Math.min(durationMinutes, MINUTES_PER_DAY));
  return Math.min(latest, Math.max(0, startMinute + snapDelta(deltaMinutes)));
}

// ---------------------------------------------------------------- keyboard

export type AppCommand =
  | { type: "today" }
  | { type: "shift"; steps: 1 | -1 }
  | { type: "view"; view: CalendarView }
  | { type: "new" };

export interface KeyInput {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** True when focus is in a text field, select or content-editable element. */
  editable?: boolean;
}

const VIEW_KEYS: Readonly<Record<string, CalendarView>> = Object.freeze({
  "1": "day",
  d: "day",
  "2": "workWeek",
  x: "workWeek",
  "3": "week",
  w: "week",
  "4": "month",
  m: "month",
  "5": "agenda",
  a: "agenda",
});

/** App-wide single-key shortcuts. Ignored while typing or with modifier keys. */
export function keyCommand(input: KeyInput): AppCommand | null {
  if (input.editable || input.altKey || input.ctrlKey || input.metaKey) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === "t") return { type: "today" };
  if (key === "n" || key === "j" || key === "]") return { type: "shift", steps: 1 };
  if (key === "p" || key === "k" || key === "[") return { type: "shift", steps: -1 };
  if (key === "c") return { type: "new" };
  const view = VIEW_KEYS[key];
  return view ? { type: "view", view } : null;
}

export const SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = Object.freeze([
  { keys: "T", action: "Today" },
  { keys: "N / P", action: "Next / previous" },
  { keys: "1–5", action: "Day, work week, week, month, agenda" },
  { keys: "C", action: "New event" },
  { keys: "Arrows", action: "Move the time cursor on the grid; Enter creates" },
  { keys: "Alt + arrows", action: "Move the focused event" },
]);

/** True when a keyboard event target accepts typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}
