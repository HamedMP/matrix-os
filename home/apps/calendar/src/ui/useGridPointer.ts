/**
 * Pointer gestures on the time grid: click or drag on empty time to create,
 * drag an event to move it (across days too), drag its bottom edge to resize.
 * The preview is local state; the store is only called when the pointer lifts.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { instantToMs } from "../../../_shared/office-accounts/types/calendar";
import { MS_PER_MINUTE, instantAtWall, type DaySlice } from "../model/dates";
import type { PositionedSegment } from "../model/layout";
import {
  DRAG_THRESHOLD_PX,
  PX_PER_MINUTE,
  columnAtOffset,
  createSpan,
  minuteAtOffset,
  movedStart,
  resizedEnd,
} from "./gridMath";

export type GridDrag =
  | { kind: "create"; dayIndex: number; from: number; to: number }
  | { kind: "move"; eventId: string; dayIndex: number; startMinute: number; durationMinutes: number }
  | { kind: "resize"; eventId: string; dayIndex: number; startMinute: number; endMinute: number };

interface Press {
  pointerId: number;
  x: number;
  y: number;
  dayIndex: number;
  minute: number;
  moved: boolean;
  target: HTMLElement | null;
  segment: PositionedSegment | null;
  resize: boolean;
  /** Whether the pressed event may be moved or resized. */
  editable: boolean;
}

export interface GridPointerOptions {
  days: readonly DaySlice[];
  timeZone: string;
  defaultMinutes: number;
  findSegment(eventId: string, dayKey: string): PositionedSegment | null;
  isEditable(eventId: string): boolean;
  onCreate(dayKey: string, startMinute: number, endMinute?: number): void;
  onOpenEvent(eventId: string, anchor: HTMLElement): void;
  onChangeTime(eventId: string, startMs: number, endMs: number): void;
}

function locate(element: HTMLElement, event: ReactPointerEvent, columns: number): { dayIndex: number; minute: number } {
  const rect = element.getBoundingClientRect();
  return {
    dayIndex: columnAtOffset(event.clientX - rect.left, rect.width, columns),
    minute: minuteAtOffset(event.clientY - rect.top),
  };
}

export function useGridPointer(options: GridPointerOptions) {
  const press = useRef<Press | null>(null);
  const [drag, setDrag] = useState<GridDrag | null>(null);

  function preview(current: Press, event: ReactPointerEvent, element: HTMLElement): GridDrag | null {
    const here = locate(element, event, options.days.length);
    const { segment } = current;
    if (!segment) return { kind: "create", dayIndex: current.dayIndex, from: current.minute, to: here.minute };
    if (!current.editable) return null;
    const deltaMinutes = (event.clientY - current.y) / PX_PER_MINUTE;
    const eventStart = instantToMs(segment.event.start);
    const duration = Math.round((instantToMs(segment.event.end) - eventStart) / MS_PER_MINUTE);
    if (current.resize) {
      if (segment.continuesAfter) return null;
      return { kind: "resize", eventId: segment.event.id, dayIndex: current.dayIndex, startMinute: segment.startMinute, endMinute: resizedEnd(segment.startMinute, segment.endMinute, deltaMinutes) };
    }
    if (segment.continuesBefore) return null;
    return { kind: "move", eventId: segment.event.id, dayIndex: here.dayIndex, startMinute: movedStart(segment.startMinute, duration, deltaMinutes), durationMinutes: duration };
  }

  function commit(current: Press, final: GridDrag | null): void {
    if (!current.moved) {
      if (current.segment && current.target) options.onOpenEvent(current.segment.event.id, current.target);
      else if (!current.segment) options.onCreate(options.days[current.dayIndex].key, current.minute);
      return;
    }
    if (!final) return;
    const day = options.days[final.dayIndex];
    if (final.kind === "create") {
      const span = createSpan(final.from, final.to, options.defaultMinutes);
      options.onCreate(day.key, span.start, span.end);
      return;
    }
    if (final.kind === "move") {
      const startMs = instantToMs(instantAtWall(day.key, final.startMinute, options.timeZone));
      options.onChangeTime(final.eventId, startMs, startMs + final.durationMinutes * MS_PER_MINUTE);
      return;
    }
    // A resize changes only the end: the shown segment may be the last day of
    // an event that started earlier, so its minute is not the event's start.
    if (!current.segment) return;
    options.onChangeTime(final.eventId, instantToMs(current.segment.event.start), instantToMs(instantAtWall(day.key, final.endMinute, options.timeZone)));
  }

  return {
    drag,
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || options.days.length === 0) return;
      const element = event.currentTarget;
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-event-id]");
      const here = locate(element, event, options.days.length);
      const eventId = target?.dataset.eventId ?? null;
      const segment = eventId ? options.findSegment(eventId, target?.dataset.dayKey ?? "") : null;
      if (target && !segment) return;
      press.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dayIndex: here.dayIndex,
        minute: here.minute,
        moved: false,
        target,
        segment,
        resize: Boolean((event.target as HTMLElement).closest("[data-resize]")),
        editable: eventId ? options.isEditable(eventId) : true,
      };
      if (typeof element.setPointerCapture === "function") element.setPointerCapture(event.pointerId);
      if (!segment) event.preventDefault();
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const current = press.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD_PX) return;
      current.moved = true;
      setDrag(preview(current, event, event.currentTarget));
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      const current = press.current;
      if (!current || current.pointerId !== event.pointerId) return;
      press.current = null;
      const final = current.moved ? preview(current, event, event.currentTarget) : null;
      setDrag(null);
      commit(current, final);
    },
    onPointerCancel() {
      press.current = null;
      setDrag(null);
    },
  };
}
