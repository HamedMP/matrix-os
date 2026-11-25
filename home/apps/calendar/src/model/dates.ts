/**
 * Calendar date arithmetic without a date library.
 *
 * Two kinds of value are kept apart:
 *
 * - A `DayKey` (`YYYY-MM-DD`) is a calendar date with no zone. Arithmetic on it
 *   runs on UTC midnights, so adding a day is always exactly one date step and
 *   never drifts across a daylight-saving change.
 * - A moment is epoch milliseconds or an `IsoInstant`. A day becomes a span of
 *   moments only through a named zone (`daySlice`), which is where a day can be
 *   23 or 25 hours long.
 */
import {
  instantFromWallTime,
  instantInZone,
  instantToMs,
  localDateOf,
  wallTimeOf,
  type IsoInstant,
} from "../../../_shared/office-accounts/types/calendar";

/** A calendar date, `YYYY-MM-DD`, with no time zone. */
export type DayKey = string;
/** 0 is Sunday, 6 is Saturday (the `Date.getUTCDay` numbering). */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const MINUTES_PER_DAY = 1440;
export const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(value: unknown): value is DayKey {
  if (typeof value !== "string") return false;
  const match = DAY_KEY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function requireDayKey(key: DayKey): number {
  if (!isDayKey(key)) throw new RangeError("Expected a calendar date as YYYY-MM-DD");
  return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
}

function keyFromUtcMs(ms: number): DayKey {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(key: DayKey, days: number): DayKey {
  if (!Number.isInteger(days)) throw new RangeError("Expected a whole number of days");
  return keyFromUtcMs(requireDayKey(key) + days * MS_PER_DAY);
}

/** Number of date steps from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: DayKey, to: DayKey): number {
  return Math.round((requireDayKey(to) - requireDayKey(from)) / MS_PER_DAY);
}

export function compareDayKeys(a: DayKey, b: DayKey): number {
  return requireDayKey(a) - requireDayKey(b);
}

export function weekdayOf(key: DayKey): WeekdayIndex {
  return new Date(requireDayKey(key)).getUTCDay() as WeekdayIndex;
}

export function isWeekdayIndex(value: unknown): value is WeekdayIndex {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

/** The first day of the week that holds `key`, for a week starting on `weekStart`. */
export function startOfWeek(key: DayKey, weekStart: number): DayKey {
  if (!isWeekdayIndex(weekStart)) throw new RangeError("Week start must be 0 (Sunday) to 6 (Saturday)");
  const back = (weekdayOf(key) - weekStart + 7) % 7;
  return addDays(key, -back);
}

export function startOfMonth(key: DayKey): DayKey {
  requireDayKey(key);
  return `${key.slice(0, 7)}-01`;
}

/** `YYYY-MM` of a day. */
export function monthKeyOf(key: DayKey): string {
  requireDayKey(key);
  return key.slice(0, 7);
}

/** Moves by whole months, clamping the day to the target month's length. */
export function addMonths(key: DayKey, months: number): DayKey {
  if (!Number.isInteger(months)) throw new RangeError("Expected a whole number of months");
  requireDayKey(key);
  const total = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(Number(key.slice(8, 10)), daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Consecutive days from `start`, `count` of them. */
export function dayKeysFrom(start: DayKey, count: number): DayKey[] {
  const days: DayKey[] = [];
  for (let index = 0; index < count; index += 1) days.push(addDays(start, index));
  return days;
}

// ---------------------------------------------------------------- zones

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch (error: unknown) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

let viewerZone: string | null = null;

/** The viewer's zone, read once (the runtime's zone does not change while the app runs). */
function viewerTimeZone(): string {
  if (viewerZone === null) {
    // react-doctor-disable-next-line react-doctor/js-hoist-intl -- runs once: the result is cached in `viewerZone` above.
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    viewerZone = isValidTimeZone(zone) ? zone : "UTC";
  }
  return viewerZone;
}

/** The given zone when the runtime knows it, else the viewer's zone, else `UTC`. */
export function resolveTimeZone(candidate?: string | null): string {
  if (candidate !== undefined && candidate !== null) return isValidTimeZone(candidate) ? candidate : "UTC";
  return viewerTimeZone();
}

/** The calendar date a moment falls on in `timeZone`. */
export function dayKeyAt(ms: number, timeZone: string): DayKey {
  return localDateOf(instantInZone(ms, timeZone));
}

/** Minutes since midnight that clocks in `timeZone` show at a moment (0 to 1439). */
export function wallMinutesAt(ms: number, timeZone: string): number {
  const wall = wallTimeOf(instantInZone(ms, timeZone));
  return Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
}

/**
 * The instant at which clocks in `timeZone` show `minuteOfDay` on `key`.
 * 1440 is the next midnight. A minute skipped by a daylight-saving change
 * resolves to the moment just after the gap.
 */
export function instantAtWall(key: DayKey, minuteOfDay: number, timeZone: string): IsoInstant {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > MINUTES_PER_DAY) {
    throw new RangeError("Minute of day must be 0 to 1440");
  }
  const day = minuteOfDay === MINUTES_PER_DAY ? addDays(key, 1) : key;
  const minute = minuteOfDay % MINUTES_PER_DAY;
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  requireDayKey(day);
  return instantFromWallTime(`${day}T${hh}:${mm}:00`, timeZone);
}

export function dayStartMs(key: DayKey, timeZone: string): number {
  return instantToMs(instantAtWall(key, 0, timeZone));
}

/** One calendar day as a span of moments in a zone. `endMs` is exclusive. */
export interface DaySlice {
  key: DayKey;
  startMs: number;
  endMs: number;
  /** 1440 on most days, 1380 or 1500 on daylight-saving change days. */
  lengthMinutes: number;
}

export function daySlice(key: DayKey, timeZone: string): DaySlice {
  const startMs = dayStartMs(key, timeZone);
  const endMs = dayStartMs(addDays(key, 1), timeZone);
  return { key, startMs, endMs, lengthMinutes: Math.round((endMs - startMs) / MS_PER_MINUTE) };
}

export function daySlices(keys: readonly DayKey[], timeZone: string): DaySlice[] {
  return keys.map((key) => daySlice(key, timeZone));
}

/** A moment written with the offset `timeZone` has then. */
export function zonedInstant(ms: number, timeZone: string): IsoInstant {
  return instantInZone(ms, timeZone);
}
