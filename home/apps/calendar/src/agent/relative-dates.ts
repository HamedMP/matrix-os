/**
 * Relative dates, resolved in code.
 *
 * The model only says which day the owner meant ("tomorrow", "next Thursday",
 * "the 30th"); these functions turn that into calendar dates from a supplied
 * "now" and IANA time zone. Untrusted input is validated first (`parseDateRef`,
 * `parseWindowRef`); anything malformed becomes null, never a guess.
 */
import { instantToMs, type IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import {
  MINUTES_PER_DAY,
  MS_PER_MINUTE,
  addDays,
  addMonths,
  compareDayKeys,
  dayKeyAt,
  daysInMonth,
  instantAtWall,
  isDayKey,
  startOfWeek,
  weekdayOf,
  zonedInstant,
  type DayKey,
} from "../model/dates";
import { WEEKDAY_NAMES, type DateRef, type ResolvedWindow, type WeekdayName, type WindowRef } from "./types";

export interface DateContext {
  now: number;
  timeZone: string;
  /** 0 Sunday to 6 Saturday. */
  weekStart: number;
}

/** Longest window the agent searches or lists; matches the provider range limit. */
export const MAX_WINDOW_DAYS = 62;
const MAX_OFFSET_DAYS = 366;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function wholeIn(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function weekdayName(value: unknown): WeekdayName | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return WEEKDAY_NAMES.find((name) => name === lower || name.slice(0, 3) === lower) ?? null;
}

// ---------------------------------------------------------------- parsing

/** Validates a day reference from an untrusted source. */
export function parseDateRef(raw: unknown): DateRef | null {
  const value = record(raw);
  if (!value) return null;
  switch (value.type) {
    case "today":
    case "tomorrow":
    case "yesterday":
      return { type: value.type };
    case "offset": {
      const days = wholeIn(value.days, -MAX_OFFSET_DAYS, MAX_OFFSET_DAYS);
      return days === null ? null : { type: "offset", days };
    }
    case "weekday": {
      const day = weekdayName(value.day);
      if (!day) return null;
      const which = value.which === "next" ? "next" : value.which === "this" ? "this" : undefined;
      return which ? { type: "weekday", day, which } : { type: "weekday", day };
    }
    case "day_of_month": {
      const day = wholeIn(value.day, 1, 31);
      if (day === null) return null;
      const month = wholeIn(value.month, 1, 12);
      return month === null ? { type: "day_of_month", day } : { type: "day_of_month", day, month };
    }
    case "date":
      return isDayKey(value.date) ? { type: "date", date: value.date } : null;
    default:
      return null;
  }
}

/** Validates a window reference from an untrusted source. */
export function parseWindowRef(raw: unknown): WindowRef | null {
  const value = record(raw);
  if (!value) return null;
  switch (value.type) {
    case "this_week":
    case "next_week":
    case "this_month":
      return { type: value.type };
    case "day":
    case "before": {
      const date = parseDateRef(value.date);
      return date ? { type: value.type, date } : null;
    }
    case "between": {
      const from = parseDateRef(value.from);
      const to = parseDateRef(value.to);
      return from && to ? { type: "between", from, to } : null;
    }
    case "next_days": {
      const days = wholeIn(value.days, 0, MAX_WINDOW_DAYS);
      return days === null ? null : { type: "next_days", days };
    }
    default:
      return null;
  }
}

/** Minutes after midnight for a wall-clock `HH:MM`, or null. */
export function parseWallTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// ---------------------------------------------------------------- resolving

/** Today's date in the context's zone. */
export function todayKey(context: DateContext): DayKey {
  return dayKeyAt(context.now, context.timeZone);
}

function nextDayOfMonth(today: DayKey, day: number, month?: number): DayKey | null {
  const year = Number(today.slice(0, 4));
  const pad = (value: number) => String(value).padStart(2, "0");
  if (month !== undefined) {
    for (let offset = 0; offset <= 4; offset += 1) {
      if (day > daysInMonth(year + offset, month)) continue;
      const key = `${year + offset}-${pad(month)}-${pad(day)}`;
      if (compareDayKeys(key, today) >= 0) return key;
    }
    return null;
  }
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  for (let offset = 0; offset < 12; offset += 1) {
    const monthStart = addMonths(firstOfMonth, offset);
    const monthYear = Number(monthStart.slice(0, 4));
    const monthNumber = Number(monthStart.slice(5, 7));
    if (day > daysInMonth(monthYear, monthNumber)) continue;
    const key = `${monthStart.slice(0, 7)}-${pad(day)}`;
    if (compareDayKeys(key, today) >= 0) return key;
  }
  return null;
}

/**
 * The calendar date a reference means, seen from `context.now` in its zone.
 *
 * - A bare weekday ("Thursday") is the nearest one from today, today included.
 * - "next Thursday" is the Thursday of next week (weeks start on `weekStart`).
 * - "the 30th" is the next 30th on or after today; months without one are skipped.
 */
export function resolveDateRef(ref: DateRef, context: DateContext): DayKey | null {
  const today = todayKey(context);
  switch (ref.type) {
    case "today":
      return today;
    case "tomorrow":
      return addDays(today, 1);
    case "yesterday":
      return addDays(today, -1);
    case "offset":
      return addDays(today, ref.days);
    case "weekday": {
      const target = WEEKDAY_NAMES.indexOf(ref.day);
      if (ref.which === "next") {
        const nextWeek = addDays(startOfWeek(today, context.weekStart), 7);
        return addDays(nextWeek, (target - context.weekStart + 7) % 7);
      }
      return addDays(today, (target - weekdayOf(today) + 7) % 7);
    }
    case "day_of_month":
      return nextDayOfMonth(today, ref.day, ref.month);
    case "date":
      return isDayKey(ref.date) ? ref.date : null;
  }
}

function windowOf(startMs: number, endMs: number, context: DateContext): ResolvedWindow | null {
  const cappedEnd = Math.min(endMs, startMs + MAX_WINDOW_DAYS * MINUTES_PER_DAY * MS_PER_MINUTE);
  if (!(cappedEnd > startMs)) return null;
  return { start: zonedInstant(startMs, context.timeZone), end: zonedInstant(cappedEnd, context.timeZone) };
}

function midnight(day: DayKey, context: DateContext): number {
  return instantToMs(instantAtWall(day, 0, context.timeZone));
}

/** `[startMs, endMs)` a window reference means, before the `MAX_WINDOW_DAYS` cap; null when a date does not resolve. */
function windowSpan(ref: WindowRef, context: DateContext, fromNow: boolean): [number, number] | null {
  const today = todayKey(context);
  const floor = (startMs: number) => (fromNow ? Math.max(startMs, context.now) : startMs);
  switch (ref.type) {
    case "this_week": {
      const start = startOfWeek(today, context.weekStart);
      return [floor(midnight(start, context)), midnight(addDays(start, 7), context)];
    }
    case "next_week": {
      const start = addDays(startOfWeek(today, context.weekStart), 7);
      return [midnight(start, context), midnight(addDays(start, 7), context)];
    }
    case "this_month": {
      const start = `${today.slice(0, 7)}-01`;
      return [floor(midnight(start, context)), midnight(addMonths(start, 1), context)];
    }
    case "day": {
      const day = resolveDateRef(ref.date, context);
      return day ? [floor(midnight(day, context)), midnight(addDays(day, 1), context)] : null;
    }
    case "before": {
      let day = resolveDateRef(ref.date, context);
      if (!day) return null;
      // "Before Friday" said on a Friday means next Friday.
      if (ref.date.type === "weekday" && compareDayKeys(day, today) <= 0) day = addDays(day, 7);
      return [context.now, midnight(day, context)];
    }
    case "between": {
      const from = resolveDateRef(ref.from, context);
      const to = resolveDateRef(ref.to, context);
      if (!from || !to || compareDayKeys(to, from) < 0) return null;
      return [floor(midnight(from, context)), midnight(addDays(to, 1), context)];
    }
    case "next_days":
      return [floor(midnight(today, context)), midnight(addDays(today, ref.days + 1), context)];
  }
}

/**
 * `resolveWindow`, plus whether the window was cut to `MAX_WINDOW_DAYS`, so an
 * answer can say it covers only part of what the owner asked about.
 */
export function resolveWindowDetail(ref: WindowRef, context: DateContext, options: { fromNow?: boolean } = {}): { window: ResolvedWindow; cut: boolean } | null {
  const span = windowSpan(ref, context, options.fromNow === true);
  const window = span ? windowOf(span[0], span[1], context) : null;
  return span && window ? { window, cut: instantToMs(window.end) < span[1] } : null;
}

/**
 * The span of time a window reference means. Windows that would start before
 * "now" (this week, before Friday, the next few days) start at "now" when
 * `fromNow` is true, so nothing in the past is searched. A window is at most
 * `MAX_WINDOW_DAYS` long; an empty or inverted one is null.
 */
export function resolveWindow(ref: WindowRef, context: DateContext, options: { fromNow?: boolean } = {}): ResolvedWindow | null {
  return resolveWindowDetail(ref, context, options)?.window ?? null;
}

/** The instant `minuteOfDay` on a resolved date, in the context's zone. */
export function instantOnDay(day: DayKey, minuteOfDay: number, context: DateContext): IsoInstant {
  return instantAtWall(day, minuteOfDay, context.timeZone);
}

/** The end of a date (23:59:59 wall-clock), the inclusive "until" of a recurrence. */
export function endOfDayInstant(day: DayKey, context: DateContext): IsoInstant {
  return zonedInstant(midnight(addDays(day, 1), context) - 1000, context.timeZone);
}
