const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

type TimeInput = Date | string | number | null | undefined;

function toDate(value: TimeInput): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function calendarDaysBetween(earlier: Date, later: Date): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);
}

function monthAndDay(date: Date, now: Date): string {
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label}, ${date.getFullYear()}`;
}

/** Short time for a list row: "now", "2m", "1h", "Yesterday", "Mon", "Sep 30". */
export function formatRelativeTime(value: TimeInput, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return "";

  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;

  const days = calendarDaysBetween(date, now);
  if (days <= 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[date.getDay()];
  return monthAndDay(date, now);
}

/** When something last changed, by calendar day: "Updated today", "Updated Mon", "Updated Sep 30". */
export function formatUpdated(value: TimeInput, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return "";

  const days = calendarDaysBetween(date, now);
  if (days <= 0) return "Updated today";
  if (days === 1) return "Updated yesterday";
  if (days < 7) return `Updated ${WEEKDAYS[date.getDay()]}`;
  return `Updated ${monthAndDay(date, now)}`;
}
