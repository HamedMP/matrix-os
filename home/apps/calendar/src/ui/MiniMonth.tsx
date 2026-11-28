/**
 * Small month navigator in the left rail. Its month follows the main view
 * until the owner pages it; picking a day navigates there.
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths, compareDayKeys, dayKeysFrom, startOfMonth, startOfWeek, type DayKey } from "../model/dates";
import { dayOfMonth, formatLongDate, formatMonthYear, formatWeekdayNarrow } from "./format";

export interface MiniMonthProps {
  anchor: DayKey;
  today: DayKey;
  weekStart: number;
  rangeStart: DayKey;
  /** Exclusive. */
  rangeEnd: DayKey;
  onPick(day: DayKey): void;
}

export function MiniMonth({ anchor, today, weekStart, rangeStart, rangeEnd, onPick }: MiniMonthProps) {
  const [offset, setOffset] = useState<{ anchor: DayKey; months: number }>({ anchor, months: 0 });
  // Paging is relative to the main view's month; a new main anchor resets it.
  const months = offset.anchor === anchor ? offset.months : 0;
  const month = addMonths(startOfMonth(anchor), months);
  const days = dayKeysFrom(startOfWeek(month, weekStart), 42);
  const monthPrefix = month.slice(0, 7);

  return (
    <div className="cal-mini" aria-label="Month navigator" role="group">
      <div className="cal-mini__head">
        <span className="cal-mini__title" aria-live="polite">{formatMonthYear(month)}</span>
        <button type="button" className="oui-icon-button" aria-label="Previous month" onClick={() => setOffset({ anchor, months: months - 1 })}>
          <ChevronLeft size={16} />
        </button>
        <button type="button" className="oui-icon-button" aria-label="Next month" onClick={() => setOffset({ anchor, months: months + 1 })}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="cal-mini__grid">
        {days.slice(0, 7).map((day) => (
          <span key={`h-${day}`} className="cal-mini__weekday" aria-hidden="true">{formatWeekdayNarrow(day)}</span>
        ))}
        {days.map((day) => {
          const inRange = compareDayKeys(day, rangeStart) >= 0 && compareDayKeys(day, rangeEnd) < 0;
          const classes = [
            "cal-mini__day",
            !day.startsWith(monthPrefix) && "is-outside",
            day === today && "is-today",
            inRange && "is-in-range",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={day}
              type="button"
              className={classes}
              aria-label={formatLongDate(day)}
              aria-current={day === today ? "date" : undefined}
              aria-pressed={inRange}
              onClick={() => onPick(day)}
            >
              {dayOfMonth(day)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

