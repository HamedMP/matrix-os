/**
 * The time rule for Mail and Calendar.
 *
 * Every instant in these contracts is an `IsoInstant`: an ISO 8601 date-time
 * with seconds and a mandatory offset, either `Z` or `±HH:MM`.
 *
 *   2026-11-23T09:00:00+01:00     2026-11-23T08:00:00Z     2026-11-23T08:00:00.250Z
 *
 * 1. No offset, no instant. A value without an offset is never stored, passed
 *    to a provider interface or returned from one. Adapters normalise provider
 *    values (for example a date-time plus a separate zone name) on the way in.
 * 2. Compare and sort by the moment (`instantToMs`, `compareInstants`), never
 *    by the text: two instants with different offsets can be the same moment.
 * 3. Render in the viewer's zone from the moment (`instantInZone`). Do not
 *    trust the offset a provider happened to return.
 * 4. A value the owner picked on a grid is wall-clock time in a named zone.
 *    Turn it into an instant with `instantFromWallTime`, so the offset is the
 *    one that zone has on that day (daylight saving included).
 * 5. All-day events are calendar dates, not moments. They use midnight UTC with
 *    an exclusive end; see `allDayInstant` in `calendar.ts`.
 */
export type IsoInstant = string;

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const MAX_OFFSET_MINUTES = 14 * 60;
const MAX_ZONE_FORMATTERS = 16;

function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function realClock(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 59;
}

function parseOffset(suffix: string): number | null {
  if (suffix === "Z") return 0;
  const hours = Number(suffix.slice(1, 3));
  const minutes = Number(suffix.slice(4, 6));
  if (minutes > 59) return null;
  const total = hours * 60 + minutes;
  if (total > MAX_OFFSET_MINUTES) return null;
  return suffix.startsWith("-") ? -total : total;
}

/** True only for a real date-time with seconds and an explicit offset. */
export function isIsoInstant(value: unknown): value is IsoInstant {
  if (typeof value !== "string") return false;
  const match = INSTANT.exec(value);
  if (!match) return false;
  return realDate(Number(match[1]), Number(match[2]), Number(match[3]))
    && realClock(Number(match[4]), Number(match[5]), Number(match[6]))
    && parseOffset(match[8]) !== null;
}

function requireInstant(instant: IsoInstant): RegExpExecArray {
  const match = isIsoInstant(instant) ? INSTANT.exec(instant) : null;
  if (!match) throw new RangeError("Expected an ISO date-time with an offset");
  return match;
}

/** Epoch milliseconds of an instant. Throws `RangeError` for anything else. */
export function instantToMs(instant: IsoInstant): number {
  requireInstant(instant);
  return Date.parse(instant);
}

/** The offset written in the instant, in minutes east of UTC. */
export function offsetMinutesOf(instant: IsoInstant): number {
  return parseOffset(requireInstant(instant)[8]) ?? 0;
}

/** Formats a moment with the given offset. Milliseconds appear only when non-zero. */
export function instantFromMs(ms: number, offsetMinutes = 0): IsoInstant {
  if (!Number.isFinite(ms) || !Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
    throw new RangeError("Expected a finite time and a whole offset within 14 hours");
  }
  const shifted = new Date(Math.trunc(ms) + offsetMinutes * 60_000);
  if (Number.isNaN(shifted.getTime())) throw new RangeError("Time is out of range");
  const text = shifted.toISOString();
  const fraction = text.slice(19, 23) === ".000" ? "" : text.slice(19, 23);
  if (offsetMinutes === 0) return `${text.slice(0, 19)}${fraction}Z`;
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${text.slice(0, 19)}${fraction}${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The same moment written with `Z`. */
export function toUtcInstant(instant: IsoInstant): IsoInstant {
  return instantFromMs(instantToMs(instant), 0);
}

/** Sort comparator: earlier moments first. */
export function compareInstants(a: IsoInstant, b: IsoInstant): number {
  return instantToMs(a) - instantToMs(b);
}

/** `YYYY-MM-DDTHH:mm:ss` as written in the instant: wall-clock time at its own offset. */
export function wallTimeOf(instant: IsoInstant): string {
  requireInstant(instant);
  return instant.slice(0, 19);
}

/** `YYYY-MM-DD` as written in the instant: the calendar date at its own offset. */
export function localDateOf(instant: IsoInstant): string {
  requireInstant(instant);
  return instant.slice(0, 10);
}

// Building a formatter is slow and views ask for the same few zones repeatedly.
// The cache is capped; the oldest zone is evicted first.
const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = zoneFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch (error: unknown) {
    // An unknown zone name is a RangeError. Anything else is a real fault.
    if (!(error instanceof RangeError)) throw error;
    formatter = null;
  }
  if (zoneFormatters.size >= MAX_ZONE_FORMATTERS) {
    const oldest = zoneFormatters.keys().next();
    if (!oldest.done) zoneFormatters.delete(oldest.value);
  }
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Minutes east of UTC that `timeZone` (an IANA name) has at the given moment.
 * A zone name the runtime does not know yields 0, so callers fall back to UTC
 * instead of failing; some providers return zone names that are not IANA names.
 */
export function zoneOffsetMinutes(ms: number, timeZone: string): number {
  if (!Number.isFinite(ms)) throw new RangeError("Expected a finite time");
  const formatter = zoneFormatter(timeZone);
  if (!formatter) return 0;
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** A moment written with the offset `timeZone` has at that moment. */
export function instantInZone(ms: number, timeZone: string): IsoInstant {
  return instantFromMs(ms, zoneOffsetMinutes(ms, timeZone));
}

const WALL_TIME_SEARCH_MS = 86_400_000;

/**
 * The instant at which clocks in `timeZone` show `wallTime`
 * (`YYYY-MM-DDTHH:mm:ss`, no offset), by the rule Temporal calls `compatible`:
 *
 * - A time skipped by a daylight-saving change moves forward by the length of
 *   the gap: 02:30 on a night clocks jump from 02:00 to 03:00 becomes 03:30.
 * - A time shown twice when clocks go back is the first of the two moments.
 */
export function instantFromWallTime(wallTime: string, timeZone: string): IsoInstant {
  const match = WALL_TIME.exec(wallTime);
  if (!match || !realDate(Number(match[1]), Number(match[2]), Number(match[3]))
    || !realClock(Number(match[4]), Number(match[5]), Number(match[6]))) {
    throw new RangeError("Expected wall-clock time as YYYY-MM-DDTHH:mm:ss");
  }
  const naive = Date.parse(`${wallTime}Z`);
  // The offsets in force a day either side cover any single change near this time.
  const before = zoneOffsetMinutes(naive - WALL_TIME_SEARCH_MS, timeZone);
  const after = zoneOffsetMinutes(naive + WALL_TIME_SEARCH_MS, timeZone);
  const moments = [...new Set([before, after, zoneOffsetMinutes(naive, timeZone)])]
    .map((offset) => naive - offset * 60_000)
    .filter((ms) => ms + zoneOffsetMinutes(ms, timeZone) * 60_000 === naive)
    .sort((a, b) => a - b);
  // No moment shows this time, so it is in a gap: read it with the offset before the gap.
  const ms = moments[0] ?? naive - before * 60_000;
  return instantFromMs(ms, zoneOffsetMinutes(ms, timeZone));
}
