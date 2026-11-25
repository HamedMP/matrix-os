/**
 * Month view: whole weeks of day cells, events as bars, "+N more" per day.
 */
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Popover } from "../../../_shared/office-ui";
import type { CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState } from "../model";
import { buildMonthGrid } from "../model/month";
import { calendarColorStyle } from "./colors";
import { dayOfMonth, formatEventWhen, formatLongDate, formatShortDate, formatWeekdayShort } from "./format";

const MONTH_ROWS = 3;

export interface MonthViewProps {
  state: CalendarState;
  calendarsById: Readonly<Record<string, CalendarInfo>>;
  onCreateAllDay(dayKey: string): void;
  onOpenEvent(eventId: string, anchor: HTMLElement): void;
  onPickDay(dayKey: string): void;
}

export function MonthView({ state, calendarsById, onCreateAllDay, onOpenEvent, onPickDay }: MonthViewProps) {
  const grid = useMemo(
    () => buildMonthGrid(state.range, state.events, { timeZone: state.timeZone, today: state.today, maxRows: MONTH_ROWS }),
    [state.range, state.events, state.timeZone, state.today],
  );
  const pendingIds = useMemo(() => new Set(state.pendingEventIds), [state.pendingEventIds]);
  const moreAnchor = useRef<HTMLElement | null>(null);
  const [moreDay, setMoreDay] = useState<string | null>(null);
  const eventsById = useMemo(() => Object.fromEntries(state.events.map((event) => [event.id, event])), [state.events]);
  const hidden = moreDay
    ? grid.weeks.flatMap((week) => week.days).find((day) => day.key === moreDay)?.hiddenEventIds ?? []
    : [];
  const rowsStyle: CSSProperties = {
    gridTemplateRows: `var(--cal-month-date) repeat(${MONTH_ROWS}, var(--cal-bar-height)) var(--cal-bar-height)`,
  };

  return (
    <section className="cal-month" aria-label="Month">
      <div className="cal-month__weekdays" aria-hidden="true">
        {(grid.weeks[0]?.days ?? []).map((day) => (
          <div key={day.key} className="cal-month__weekday">{formatWeekdayShort(day.key)}</div>
        ))}
      </div>
      {grid.weeks.map((week) => (
        <div key={week.days[0].key} className="cal-month__week" style={rowsStyle}>
          {week.days.map((day, index) => (
            <div
              key={day.key}
              data-day={day.key}
              className={`cal-month__cell${day.inMonth ? "" : " is-outside"}${day.isToday ? " is-today" : ""}`}
              style={{ gridColumn: index + 1, gridRow: "1 / -1" }}
            >
              <button
                type="button"
                className="cal-month__date"
                onClick={() => onPickDay(day.key)}
                aria-label={`${formatLongDate(day.key)}${day.isToday ? ", today" : ""}, ${day.eventCount} events. Open day view`}
                aria-current={day.isToday ? "date" : undefined}
              >
                {dayOfMonth(day.key)}
              </button>
              <button
                type="button"
                className="cal-month__add"
                onClick={() => onCreateAllDay(day.key)}
                aria-label={`New all-day event on ${formatLongDate(day.key)}`}
              />
            </div>
          ))}
          {week.bars.map((bar) => (
            <button
              key={bar.event.id}
              type="button"
              data-event-id={bar.event.id}
              className={`cal-bar${bar.event.allDay || bar.endIndex - bar.startIndex > 1 ? "" : " cal-bar--timed"}${pendingIds.has(bar.event.id) ? " is-pending" : ""}`}
              style={{ ...calendarColorStyle(calendarsById[bar.event.calendarId]), gridColumn: `${bar.startIndex + 1} / ${bar.endIndex + 1}`, gridRow: bar.row + 2 }}
              aria-label={`${bar.event.title || "(No title)"}, ${formatEventWhen(bar.event, state.timeZone)}`}
              onClick={(event) => onOpenEvent(bar.event.id, event.currentTarget)}
            >
              {bar.event.title || "(No title)"}
            </button>
          ))}
          {week.days.map((day, index) => day.overflow > 0 && (
            <button
              key={`more-${day.key}`}
              type="button"
              className="cal-month__more"
              style={{ gridColumn: index + 1, gridRow: MONTH_ROWS + 2 }}
              onClick={(event) => {
                moreAnchor.current = event.currentTarget;
                setMoreDay(day.key);
              }}
            >
              +{day.overflow} more
            </button>
          ))}
        </div>
      ))}
      <Popover open={moreDay !== null} onClose={() => setMoreDay(null)} anchorRef={moreAnchor} label={moreDay ? `More events on ${formatShortDate(moreDay)}` : "More events"}>
        <ul className="cal-more-list">
          {hidden.map((id) => {
            const event = eventsById[id];
            if (!event) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  className="cal-more-list__item"
                  style={calendarColorStyle(calendarsById[event.calendarId])}
                  onClick={() => {
                    const anchor = moreAnchor.current;
                    setMoreDay(null);
                    if (anchor) onOpenEvent(id, anchor);
                  }}
                >
                  <span className="cal-swatch" aria-hidden="true" />
                  <span>{event.title || "(No title)"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Popover>
    </section>
  );
}
