/**
 * Display text for dates and times. Everything goes through Intl with an
 * explicit zone so the grid, popover and composer agree on the wall clock.
 */
import { allDayDate, instantInZone, instantToMs, wallTimeOf, type CalendarEvent, type IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import { addDays, type DayKey } from "../model/dates";
import type { CalendarView, ViewRange } from "../model/ranges";

const MAX_FORMATTERS = 48;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter; the cache is capped and drops its oldest entry first. */
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
  if (formatters.size >= MAX_FORMATTERS) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(key, created);
  return created;
}

function dayDate(key: DayKey): Date {
  return new Date(`${key}T12:00:00Z`);
}

/** "9:30 AM" (or the viewer's locale form) at a moment in a zone. */
export function formatTime(ms: number, timeZone: string): string {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

/** "9 AM" style label for an hour line. */
export function formatHour(hour: number): string {
  return formatter("UTC", { hour: "numeric" }).format(new Date(Date.UTC(2000, 0, 1, hour)));
}

export function formatWeekdayShort(key: DayKey): string {
  return formatter("UTC", { weekday: "short" }).format(dayDate(key));
}

export function formatWeekdayNarrow(key: DayKey): string {
  return formatter("UTC", { weekday: "narrow" }).format(dayDate(key));
}

export function dayOfMonth(key: DayKey): number {
  return Number(key.slice(8, 10));
}

/** "Monday, November 23, 2026". */
export function formatLongDate(key: DayKey): string {
  return formatter("UTC", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(dayDate(key));
}

/** "Mon, Nov 23". */
export function formatShortDate(key: DayKey): string {
  return formatter("UTC", { weekday: "short", month: "short", day: "numeric" }).format(dayDate(key));
}

export function formatMonthYear(key: DayKey): string {
  return formatter("UTC", { year: "numeric", month: "long" }).format(dayDate(key));
}

function formatMonthDay(key: DayKey): string {
  return formatter("UTC", { month: "short", day: "numeric" }).format(dayDate(key));
}

/** The heading over the grid for a view range. */
export function formatRangeTitle(range: ViewRange): string {
  if (range.view === "day") return formatLongDate(range.anchor);
  if (range.view === "month") return formatMonthYear(range.anchor);
  const first = range.startKey;
  const last = addDays(range.endKey, -1);
  const year = last.slice(0, 4);
  if (first.slice(0, 4) !== year) return `${formatMonthDay(first)}, ${first.slice(0, 4)} – ${formatMonthDay(last)}, ${year}`;
  return `${formatMonthDay(first)} – ${formatMonthDay(last)}, ${year}`;
}

export const VIEW_LABELS: Readonly<Record<CalendarView, string>> = Object.freeze({
  day: "Day",
  workWeek: "Work week",
  week: "Week",
  month: "Month",
  agenda: "Agenda",
});

/** "9:00 – 9:30 AM" for timed events, "All day" (with dates when it spans days) for all-day ones. */
export function formatEventWhen(event: Pick<CalendarEvent, "start" | "end" | "allDay">, timeZone: string): string {
  if (event.allDay) {
    const first = allDayDate(event.start);
    const last = addDays(allDayDate(event.end), -1);
    return last > first ? `All day, ${formatShortDate(first)} – ${formatShortDate(last)}` : `All day, ${formatShortDate(first)}`;
  }
  const startMs = instantToMs(event.start);
  const endMs = instantToMs(event.end);
  const startDay = wallTimeOf(instantInZone(startMs, timeZone)).slice(0, 10);
  const endDay = wallTimeOf(instantInZone(Math.max(startMs, endMs - 1), timeZone)).slice(0, 10);
  const span = `${formatTime(startMs, timeZone)} – ${formatTime(endMs, timeZone)}`;
  if (startDay === endDay) return `${formatShortDate(startDay)}, ${span}`;
  return `${formatShortDate(startDay)} ${formatTime(startMs, timeZone)} – ${formatShortDate(endDay)} ${formatTime(endMs, timeZone)}`;
}

/** Wall-clock `YYYY-MM-DDTHH:mm` of an instant in a zone, for date and time inputs. */
export function wallInputValue(instant: IsoInstant | number, timeZone: string): string {
  const ms = typeof instant === "number" ? instant : instantToMs(instant);
  return wallTimeOf(instantInZone(ms, timeZone)).slice(0, 16);
}

/** "UTC−05:00" style label for a zone at a moment. */
export function formatZoneOffset(timeZone: string, ms: number): string {
  const offset = instantInZone(ms, timeZone).slice(19);
  if (offset === "Z" || offset === "") return "UTC";
  return `UTC${offset.replace("-", "−")}`;
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The zone's short name ("EST", "GMT+1") at a moment. */
export function formatZoneShort(timeZone: string, ms: number): string {
  const part = formatter(timeZone, { timeZoneName: "short" }).formatToParts(new Date(ms)).find((item) => item.type === "timeZoneName");
  return part?.value ?? timeZone;
}
