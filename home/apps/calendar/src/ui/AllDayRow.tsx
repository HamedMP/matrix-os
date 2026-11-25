/**
 * The bar row above the time grid: all-day events and events of a day or
 * longer, packed into rows. A click on empty space starts an all-day draft.
 */
import type { CSSProperties } from "react";
import type { CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { DayKey } from "../model/dates";
import type { BarPlacement } from "../model/layout";
import { calendarColorStyle } from "./colors";
import { formatEventWhen, formatLongDate } from "./format";

export interface AllDayRowProps {
  dayKeys: readonly DayKey[];
  bars: readonly BarPlacement[];
  rowCount: number;
  calendarsById: Readonly<Record<string, CalendarInfo>>;
  pendingIds: ReadonlySet<string>;
  timeZone: string;
  onCreate(dayKey: DayKey): void;
  onOpenEvent(eventId: string, anchor: HTMLElement): void;
}

export function AllDayRow({ dayKeys, bars, rowCount, calendarsById, pendingIds, timeZone, onCreate, onOpenEvent }: AllDayRowProps) {
  const rows = Math.max(1, rowCount);
  const grid: CSSProperties = {
    gridTemplateColumns: `repeat(${dayKeys.length}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, var(--cal-bar-height))`,
  };
  return (
    <div className="cal-allday">
      <div className="cal-timegrid__gutter cal-allday__label">All day</div>
      <div className="cal-allday__grid" style={grid} role="group" aria-label="All-day events">
        {dayKeys.map((day, index) => (
          <button
            key={day}
            type="button"
            className="cal-allday__cell"
            style={{ gridColumn: index + 1, gridRow: `1 / span ${rows}` }}
            aria-label={`New all-day event on ${formatLongDate(day)}`}
            onClick={() => onCreate(day)}
          />
        ))}
        {bars.map((bar) => {
          const calendar = calendarsById[bar.event.calendarId];
          const pending = pendingIds.has(bar.event.id);
          return (
            <button
              key={bar.event.id}
              type="button"
              data-event-id={bar.event.id}
              className={`cal-bar${pending ? " is-pending" : ""}${bar.continuesBefore ? " continues-before" : ""}${bar.continuesAfter ? " continues-after" : ""}`}
              style={{ ...calendarColorStyle(calendar), gridColumn: `${bar.startIndex + 1} / ${bar.endIndex + 1}`, gridRow: bar.row + 1 }}
              aria-label={`${bar.event.title || "(No title)"}, ${formatEventWhen(bar.event, timeZone)}`}
              onClick={(event) => onOpenEvent(bar.event.id, event.currentTarget)}
            >
              {bar.event.title || "(No title)"}
            </button>
          );
        })}
      </div>
    </div>
  );
}
