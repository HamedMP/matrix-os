/**
 * The month view: whole weeks of day cells, events as bars, and "+N more"
 * counts for the events that do not fit.
 */
import type { CalendarEvent } from "../../../_shared/office-accounts/types/calendar";
import { monthKeyOf, weekdayOf, type DayKey, type WeekdayIndex } from "./dates";
import { barCandidate, packBars, type BarPlacement } from "./layout";
import type { ViewRange } from "./ranges";

export const DEFAULT_MONTH_ROWS = 3;

export interface MonthCell {
  key: DayKey;
  weekday: WeekdayIndex;
  /** False for the leading and trailing days of neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  /** Every event that touches this day. */
  eventCount: number;
  /** Events touching this day that sit below the visible rows. */
  overflow: number;
  /** Ids of those hidden events, in display order, for the "+N more" popover. */
  hiddenEventIds: string[];
}

export interface MonthWeek {
  days: MonthCell[];
  /** Bars in visible rows only (`row < maxRows`); indexes are into `days`. */
  bars: BarPlacement[];
  /** Rows the visible bars use, at most `maxRows`. */
  rowCount: number;
}

export interface MonthGrid {
  /** `YYYY-MM`. */
  monthKey: string;
  weeks: MonthWeek[];
}

export interface MonthGridOptions {
  timeZone: string;
  /** Bar rows a cell shows before counting the rest as overflow. The UI keeps one more line for "+N more". */
  maxRows?: number;
  /** Today's date in the viewer's zone. */
  today?: DayKey;
}

/**
 * Every event becomes a bar in its week: multi-day and all-day events span
 * their days, timed events take one cell. Rows at or below `maxRows` are hidden
 * and counted per day.
 */
export function buildMonthGrid(range: ViewRange, events: readonly CalendarEvent[], options: MonthGridOptions): MonthGrid {
  const maxRows = Math.max(0, Math.floor(options.maxRows ?? DEFAULT_MONTH_ROWS));
  const monthKey = range.monthKey ?? monthKeyOf(range.anchor);
  const weeks: MonthWeek[] = [];
  for (let offset = 0; offset < range.days.length; offset += 7) {
    const dayKeys = range.days.slice(offset, offset + 7);
    const candidates = [];
    for (const event of events) {
      const candidate = barCandidate(event, dayKeys, options.timeZone);
      if (candidate) candidates.push(candidate);
    }
    const { bars } = packBars(candidates);
    const days: MonthCell[] = dayKeys.map((key) => ({
      key,
      weekday: weekdayOf(key),
      inMonth: key.startsWith(monthKey),
      isToday: key === options.today,
      eventCount: 0,
      overflow: 0,
      hiddenEventIds: [],
    }));
    const ordered = [...bars].sort((a, b) => a.row - b.row || a.startIndex - b.startIndex);
    for (const bar of ordered) {
      for (let index = bar.startIndex; index < bar.endIndex; index += 1) {
        days[index].eventCount += 1;
        if (bar.row >= maxRows) {
          days[index].overflow += 1;
          days[index].hiddenEventIds.push(bar.event.id);
        }
      }
    }
    const visible = bars.filter((bar) => bar.row < maxRows);
    weeks.push({ days, bars: visible, rowCount: visible.reduce((rows, bar) => Math.max(rows, bar.row + 1), 0) });
  }
  return { monthKey, weeks };
}
