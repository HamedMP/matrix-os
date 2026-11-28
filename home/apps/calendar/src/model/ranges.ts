/**
 * The span of days and moments each calendar view shows.
 */
import { MAX_EVENT_RANGE_DAYS, type IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import {
  addDays,
  addMonths,
  dayKeysFrom,
  dayStartMs,
  diffDays,
  isWeekdayIndex,
  monthKeyOf,
  startOfMonth,
  startOfWeek,
  weekdayOf,
  zonedInstant,
  type DayKey,
} from "./dates";

export const CALENDAR_VIEWS = ["day", "workWeek", "week", "month", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function isCalendarView(value: unknown): value is CalendarView {
  return typeof value === "string" && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

export interface RangeOptions {
  /** IANA zone the grid is drawn in (the viewer's zone). */
  timeZone: string;
  /** First day of the week, 0 Sunday to 6 Saturday. */
  weekStart: number;
  /** Weekdays shown in the work week view (0 Sunday to 6 Saturday). Empty means the whole week. */
  workDays: readonly number[];
  /** Days the agenda covers, clamped to 1 to `MAX_EVENT_RANGE_DAYS`. */
  agendaDays: number;
}

export interface ViewRange {
  view: CalendarView;
  /** The day the owner navigated to; the range is built around it. */
  anchor: DayKey;
  /** Every day the view shows, in order. Work week skips non-working days. */
  days: DayKey[];
  /** First day shown. */
  startKey: DayKey;
  /** Day after the last day shown (exclusive). */
  endKey: DayKey;
  /** Midnight of `startKey` in the zone. */
  start: IsoInstant;
  /** Midnight of `endKey` in the zone (exclusive). */
  end: IsoInstant;
  timeZone: string;
  /** `YYYY-MM` of the month a month view is about; absent for other views. */
  monthKey?: string;
}

export function clampAgendaDays(days: number): number {
  if (!Number.isFinite(days)) return 14;
  return Math.min(MAX_EVENT_RANGE_DAYS, Math.max(1, Math.round(days)));
}

function weekDays(anchor: DayKey, weekStart: number): DayKey[] {
  return dayKeysFrom(startOfWeek(anchor, weekStart), 7);
}

function viewDays(view: CalendarView, anchor: DayKey, options: RangeOptions): DayKey[] {
  switch (view) {
    case "day":
      return [anchor];
    case "week":
      return weekDays(anchor, options.weekStart);
    case "workWeek": {
      const work = new Set(options.workDays.filter(isWeekdayIndex));
      const days = weekDays(anchor, options.weekStart).filter((day) => work.has(weekdayOf(day)));
      return days.length > 0 ? days : weekDays(anchor, options.weekStart);
    }
    case "month": {
      const first = startOfMonth(anchor);
      const gridStart = startOfWeek(first, options.weekStart);
      const lastOfMonth = addDays(addMonths(first, 1), -1);
      const gridEnd = addDays(startOfWeek(lastOfMonth, options.weekStart), 7);
      return dayKeysFrom(gridStart, diffDays(gridStart, gridEnd));
    }
    case "agenda":
      return dayKeysFrom(anchor, clampAgendaDays(options.agendaDays));
  }
}

export function viewRange(view: CalendarView, anchor: DayKey, options: RangeOptions): ViewRange {
  const days = viewDays(view, anchor, options);
  const startKey = days[0];
  const endKey = addDays(days[days.length - 1], 1);
  const range: ViewRange = {
    view,
    anchor,
    days,
    startKey,
    endKey,
    start: zonedInstant(dayStartMs(startKey, options.timeZone), options.timeZone),
    end: zonedInstant(dayStartMs(endKey, options.timeZone), options.timeZone),
    timeZone: options.timeZone,
  };
  if (view === "month") range.monthKey = monthKeyOf(anchor);
  return range;
}

/** The anchor after moving `steps` whole views forward (positive) or back. */
export function shiftAnchor(view: CalendarView, anchor: DayKey, steps: number, options: RangeOptions): DayKey {
  switch (view) {
    case "day":
      return addDays(anchor, steps);
    case "week":
    case "workWeek":
      return addDays(anchor, steps * 7);
    case "month":
      return addMonths(anchor, steps);
    case "agenda":
      return addDays(anchor, steps * clampAgendaDays(options.agendaDays));
  }
}

/** Two ranges cover the same days in the same zone. */
export function sameRange(a: ViewRange | null, b: ViewRange | null): boolean {
  if (!a || !b) return a === b;
  return a.start === b.start && a.end === b.end && a.days.length === b.days.length && a.days.every((day, i) => day === b.days[i]);
}
