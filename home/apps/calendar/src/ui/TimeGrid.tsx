/**
 * Day, work week and week views: day headers, the all-day bar row and the
 * scrolling time grid with its gestures and keyboard cursor.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { instantToMs, type CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState } from "../model";
import { MS_PER_MINUTE, addDays, daySlices, dayKeyAt, instantAtWall, wallMinutesAt } from "../model/dates";
import { layoutBars, layoutTimedGrid, type PositionedSegment } from "../model/layout";
import { proposalSegments } from "../model/proposals";
import { AllDayRow } from "./AllDayRow";
import { DayColumn, type GhostBlock } from "./DayColumn";
import { dayOfMonth, formatHour, formatLongDate, formatTime, formatWeekdayShort, formatZoneShort } from "./format";
import { GRID_HEIGHT, HOUR_HEIGHT, SNAP_MINUTES, clampMinute, createSpan } from "./gridMath";
import { useGridPointer, type GridDrag } from "./useGridPointer";

export interface TimeGridProps {
  state: CalendarState;
  now: number;
  calendarsById: Readonly<Record<string, CalendarInfo>>;
  isEditable(eventId: string): boolean;
  onCreate(dayKey: string, startMinute: number, endMinute?: number): void;
  onCreateAllDay(dayKey: string): void;
  onOpenEvent(eventId: string, anchor: HTMLElement): void;
  onChangeTime(eventId: string, startMs: number, endMs: number): void;
  onProposal(proposalId: string): void;
  onPickDay(dayKey: string): void;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const CURSOR_STEP = 30;

function ghostFor(drag: GridDrag | null, dayIndex: number, defaultMinutes: number): GhostBlock | null {
  if (!drag || drag.dayIndex !== dayIndex) return null;
  if (drag.kind === "create") {
    const span = createSpan(drag.from, drag.to, defaultMinutes);
    return { startMinute: span.start, endMinute: span.end, label: "New event" };
  }
  if (drag.kind === "move") return { startMinute: drag.startMinute, endMinute: clampMinute(drag.startMinute + drag.durationMinutes), label: "" };
  return { startMinute: drag.startMinute, endMinute: drag.endMinute, label: "" };
}

export function TimeGrid(props: TimeGridProps) {
  const { state, now, calendarsById } = props;
  const { timeZone } = state;
  const days = useMemo(() => daySlices(state.range.days, timeZone), [state.range.days, timeZone]);
  const timed = useMemo(() => layoutTimedGrid(state.events, days, timeZone), [state.events, days, timeZone]);
  const bars = useMemo(() => layoutBars(state.events, state.range.days, timeZone), [state.events, state.range.days, timeZone]);
  const pendingIds = useMemo(() => new Set(state.pendingEventIds), [state.pendingEventIds]);
  const proposals = useMemo(() => proposalSegments(state.proposals, days, timeZone), [state.proposals, days, timeZone]);
  const scroller = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<{ dayIndex: number; minute: number } | null>(null);
  const todayKey = dayKeyAt(now, timeZone);
  const nowMinute = wallMinutesAt(now, timeZone);
  const defaultMinutes = state.preferences.defaultDurationMinutes;
  const workStart = state.preferences.workingHours.startMinute;

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = Math.max(0, (workStart / 60 - 1) * HOUR_HEIGHT);
  }, [workStart]);

  function findSegment(eventId: string, dayKey: string): PositionedSegment | null {
    return timed[dayKey]?.find((segment) => segment.event.id === eventId) ?? null;
  }

  const pointer = useGridPointer({
    days,
    timeZone,
    defaultMinutes,
    findSegment,
    isEditable: props.isEditable,
    onCreate: props.onCreate,
    onOpenEvent: props.onOpenEvent,
    onChangeTime: props.onChangeTime,
  });

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const current = cursor ?? { dayIndex: Math.max(0, state.range.days.indexOf(todayKey)), minute: workStart };
    let next = current;
    if (event.key === "ArrowDown") next = { ...current, minute: Math.min(1440 - CURSOR_STEP, current.minute + CURSOR_STEP) };
    else if (event.key === "ArrowUp") next = { ...current, minute: Math.max(0, current.minute - CURSOR_STEP) };
    else if (event.key === "ArrowRight") next = { ...current, dayIndex: Math.min(days.length - 1, current.dayIndex + 1) };
    else if (event.key === "ArrowLeft") next = { ...current, dayIndex: Math.max(0, current.dayIndex - 1) };
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onCreate(days[current.dayIndex].key, current.minute, current.minute + CURSOR_STEP);
      return;
    } else return;
    event.preventDefault();
    setCursor(next);
  }

  function onEventKeyDown(segment: PositionedSegment, event: KeyboardEvent<HTMLButtonElement>) {
    if (!event.altKey || !props.isEditable(segment.event.id)) return;
    const deltas: Record<string, number> = { ArrowUp: -SNAP_MINUTES, ArrowDown: SNAP_MINUTES, ArrowLeft: -1440, ArrowRight: 1440 };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const startMs = instantToMs(segment.event.start);
    const endMs = instantToMs(segment.event.end);
    if (Math.abs(delta) === 1440) {
      const dayKey = dayKeyAt(startMs, timeZone);
      const shifted = instantToMs(instantAtWall(addDays(dayKey, Math.sign(delta)), wallMinutesAt(startMs, timeZone), timeZone));
      props.onChangeTime(segment.event.id, shifted, shifted + (endMs - startMs));
      return;
    }
    props.onChangeTime(segment.event.id, startMs + delta * MS_PER_MINUTE, endMs + delta * MS_PER_MINUTE);
  }

  const draggingId = pointer.drag && pointer.drag.kind !== "create" ? pointer.drag.eventId : null;
  const cursorLabel = cursor && days[cursor.dayIndex]
    ? `${formatLongDate(days[cursor.dayIndex].key)}, ${formatTime(instantToMs(instantAtWall(days[cursor.dayIndex].key, cursor.minute, timeZone)), timeZone)}`
    : "";
  const columns = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <div className="cal-timegrid" data-view={state.range.view}>
      <div className="cal-timegrid__head">
        <div className="cal-timegrid__gutter" aria-hidden="true">{formatZoneShort(timeZone, now)}</div>
        <div className="cal-timegrid__days" style={columns}>
          {days.map((day) => (
            <button
              key={day.key}
              type="button"
              className={`cal-dayhead${day.key === todayKey ? " is-today" : ""}`}
              onClick={() => props.onPickDay(day.key)}
              aria-label={`${formatLongDate(day.key)}${day.key === todayKey ? ", today" : ""}. Open day view`}
              aria-current={day.key === todayKey ? "date" : undefined}
            >
              <span className="cal-dayhead__weekday">{formatWeekdayShort(day.key)}</span>
              <span className="cal-dayhead__date">{dayOfMonth(day.key)}</span>
            </button>
          ))}
        </div>
      </div>
      <AllDayRow
        dayKeys={state.range.days}
        bars={bars.bars}
        rowCount={bars.rowCount}
        calendarsById={calendarsById}
        pendingIds={pendingIds}
        timeZone={timeZone}
        onCreate={props.onCreateAllDay}
        onOpenEvent={props.onOpenEvent}
      />
      <div className="cal-timegrid__scroll" ref={scroller}>
        <div className="cal-timegrid__body" style={{ height: GRID_HEIGHT }}>
          <div className="cal-timegrid__hours" aria-hidden="true">
            {HOURS.map((hour) => (
              <div key={hour} className="cal-hour" style={{ top: hour * HOUR_HEIGHT }}>{hour === 0 ? "" : formatHour(hour)}</div>
            ))}
          </div>
          <div
            className="cal-timegrid__columns"
            style={columns}
            tabIndex={0}
            role="group"
            aria-label="Time grid. Arrow keys move the time cursor, Enter creates an event."
            aria-describedby="cal-cursor-status"
            onKeyDown={onGridKeyDown}
            onBlur={() => setCursor(null)}
            onPointerDown={pointer.onPointerDown}
            onPointerMove={pointer.onPointerMove}
            onPointerUp={pointer.onPointerUp}
            onPointerCancel={pointer.onPointerCancel}
          >
            {days.map((day, index) => (
              <DayColumn
                key={day.key}
                day={day}
                timeZone={timeZone}
                segments={timed[day.key] ?? []}
                overlays={state.assistant.overlays[day.key] ?? []}
                attendees={state.assistant.attendees}
                proposals={proposals[day.key] ?? []}
                calendarsById={calendarsById}
                pendingIds={pendingIds}
                draggingId={draggingId}
                ghost={ghostFor(pointer.drag, index, defaultMinutes)}
                cursorMinute={cursor?.dayIndex === index ? cursor.minute : null}
                nowMinute={day.key === todayKey ? nowMinute : null}
                onEventClick={props.onOpenEvent}
                onEventKeyDown={onEventKeyDown}
                onProposal={props.onProposal}
              />
            ))}
          </div>
        </div>
      </div>
      <span id="cal-cursor-status" className="oui-sr-only" aria-live="polite">{cursorLabel}</span>
    </div>
  );
}
