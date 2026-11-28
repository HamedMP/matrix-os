/**
 * Free-busy maths for the scheduling assistant.
 *
 * - `busyOverlays` turns attendees' busy blocks into per-day bands for the
 *   time grid, merged per person and cut at each zoned midnight.
 * - `findSlots` finds start times inside working hours where nobody is busy.
 *
 * Unknown availability is never free: an `unknown` block always blocks a slot.
 */
import { instantToMs, type BusyBlock, type BusyStatus, type IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import {
  MINUTES_PER_DAY,
  MS_PER_MINUTE,
  addDays,
  compareDayKeys,
  dayKeyAt,
  instantAtWall,
  isWeekdayIndex,
  wallMinutesAt,
  weekdayOf,
  zonedInstant,
  type DayKey,
  type DaySlice,
} from "./dates";

export interface WorkingHours {
  /** Weekdays worked, 0 Sunday to 6 Saturday. */
  days: readonly number[];
  /** Wall-clock minute the working day starts, 0 to 1439. */
  startMinute: number;
  /** Wall-clock minute it ends (exclusive), after `startMinute`, up to 1440. */
  endMinute: number;
}

export const DEFAULT_WORKING_HOURS: WorkingHours = Object.freeze({
  days: Object.freeze([1, 2, 3, 4, 5]),
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}) as WorkingHours;

export interface TimeSlot {
  start: IsoInstant;
  /** Exclusive. */
  end: IsoInstant;
}

export interface FindSlotsOptions {
  busy: readonly BusyBlock[];
  rangeStart: IsoInstant;
  /** Exclusive. */
  rangeEnd: IsoInstant;
  durationMinutes: number;
  /** Zone the working hours are read in; slots are written with its offset. */
  timeZone: string;
  workingHours: WorkingHours;
  /** Slot starts are this far apart, counted from the start of working hours. Default 30, 5 to 240. */
  stepMinutes?: number;
  /** Free time kept before and after every busy block. Default 0, at most 240. */
  bufferMinutes?: number;
  /** Default 10, at most `MAX_SLOT_RESULTS`. */
  maxResults?: number;
  /** Epoch ms; no slot starts earlier (pass "now" so nothing is proposed in the past). */
  notBefore?: number;
  /** Tentative time blocks a slot. Default true. */
  tentativeIsBusy?: boolean;
  /** Results never overlap each other (distinct choices to offer); the next start stays on the step grid. Default false. */
  distinct?: boolean;
}

export const MAX_SLOT_RESULTS = 100;
export const MAX_SLOT_DURATION_MINUTES = MINUTES_PER_DAY;

/** A meeting length `findSlots` can search for: whole minutes, 1 to `MAX_SLOT_DURATION_MINUTES`. */
export function isSlotDuration(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_SLOT_DURATION_MINUTES;
}
const MAX_SEARCH_DAYS = 62;

export function isValidWorkingHours(value: unknown): value is WorkingHours {
  if (!value || typeof value !== "object") return false;
  const hours = value as Partial<WorkingHours>;
  return Array.isArray(hours.days)
    && hours.days.length <= 7
    && hours.days.every(isWeekdayIndex)
    && Number.isInteger(hours.startMinute)
    && Number.isInteger(hours.endMinute)
    && (hours.startMinute as number) >= 0
    && (hours.endMinute as number) <= MINUTES_PER_DAY
    && (hours.startMinute as number) < (hours.endMinute as number);
}

function wholeIn(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return resolved;
}

interface Interval {
  startMs: number;
  endMs: number;
}

function blocksSlot(block: BusyBlock, tentativeIsBusy: boolean): boolean {
  const status = block.status ?? "busy";
  return status !== "tentative" || tentativeIsBusy;
}

/** Sorted, merged busy intervals widened by the buffer. Malformed blocks count as nothing. */
function mergedBusy(busy: readonly BusyBlock[], bufferMs: number, tentativeIsBusy: boolean): Interval[] {
  const intervals: Interval[] = [];
  for (const block of busy) {
    if (!blocksSlot(block, tentativeIsBusy)) continue;
    let startMs: number;
    let endMs: number;
    try {
      startMs = instantToMs(block.start);
      endMs = instantToMs(block.end);
    } catch (error: unknown) {
      if (error instanceof RangeError) continue;
      throw error;
    }
    if (endMs <= startMs) continue;
    intervals.push({ startMs: startMs - bufferMs, endMs: endMs + bufferMs });
  }
  intervals.sort((a, b) => a.startMs - b.startMs);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) last.endMs = Math.max(last.endMs, interval.endMs);
    else merged.push({ ...interval });
  }
  return merged;
}

/**
 * Common free slots of `durationMinutes` inside working hours, earliest first.
 * Candidate starts are `stepMinutes` apart from the start of each working day;
 * a slot must end by the end of working hours that day and must not touch any
 * busy block (plus buffer). Each day uses its own offset, so daylight-saving
 * changes move nothing.
 */
export function findSlots(options: FindSlotsOptions): TimeSlot[] {
  const duration = wholeIn(options.durationMinutes, 0, 1, MAX_SLOT_DURATION_MINUTES, "Duration");
  const step = wholeIn(options.stepMinutes, 30, 5, 240, "Step");
  const buffer = wholeIn(options.bufferMinutes, 0, 0, 240, "Buffer");
  const maxResults = wholeIn(options.maxResults, 10, 1, MAX_SLOT_RESULTS, "Result count");
  if (!isValidWorkingHours(options.workingHours)) throw new RangeError("Working hours must end after they start");
  const rangeStartMs = instantToMs(options.rangeStart);
  const rangeEndMs = instantToMs(options.rangeEnd);
  if (rangeEndMs <= rangeStartMs) return [];
  const floorMs = Math.max(rangeStartMs, Number.isFinite(options.notBefore) ? (options.notBefore as number) : -Infinity);
  const busy = mergedBusy(options.busy, buffer * MS_PER_MINUTE, options.tentativeIsBusy ?? true);
  const workDays = new Set(options.workingHours.days);
  const { timeZone } = options;
  const durationMs = duration * MS_PER_MINUTE;
  const stepMs = step * MS_PER_MINUTE;

  const slots: TimeSlot[] = [];
  let busyIndex = 0;
  const lastKey = dayKeyAt(rangeEndMs - 1, timeZone);
  let day = dayKeyAt(rangeStartMs, timeZone);
  for (let guard = 0; guard <= MAX_SEARCH_DAYS && compareDayKeys(day, lastKey) <= 0; guard += 1, day = addDays(day, 1)) {
    if (!workDays.has(weekdayOf(day))) continue;
    const windowStart = instantToMs(instantAtWall(day, options.workingHours.startMinute, timeZone));
    const windowEnd = Math.min(instantToMs(instantAtWall(day, options.workingHours.endMinute, timeZone)), rangeEndMs);
    let startMs = windowStart;
    if (startMs < floorMs) startMs = windowStart + Math.ceil((floorMs - windowStart) / stepMs) * stepMs;
    for (; startMs + durationMs <= windowEnd; startMs += stepMs) {
      const endMs = startMs + durationMs;
      while (busyIndex < busy.length && busy[busyIndex].endMs <= startMs) busyIndex += 1;
      const blocker = busy[busyIndex];
      if (blocker && blocker.startMs < endMs) {
        // Every start before the end of this busy run overlaps it; jump past them.
        const skip = Math.ceil((blocker.endMs - startMs) / stepMs) - 1;
        if (skip > 0) startMs += skip * stepMs;
        continue;
      }
      slots.push({ start: zonedInstant(startMs, timeZone), end: zonedInstant(endMs, timeZone) });
      if (slots.length >= maxResults) return slots;
      if (options.distinct) startMs += Math.ceil(durationMs / stepMs) * stepMs - stepMs;
    }
  }
  return slots;
}

// ---------------------------------------------------------------- overlays

export interface BusyOverlay {
  address: string;
  dayKey: DayKey;
  /** Wall-clock minute in the day, 0 to 1439. */
  startMinute: number;
  /** Up to 1440. */
  endMinute: number;
  status: BusyStatus;
}

interface PersonInterval extends Interval {
  address: string;
  status: BusyStatus;
}

/**
 * Lower-cased addresses with an `unknown` block: people whose calendar cannot
 * be read (Google answers a calendar the owner may not see with an error
 * entry, which the adapter turns into one unknown block). Their time counts
 * as busy; the UI names them calmly instead of reporting a failure.
 */
export function unknownAvailability(busy: readonly BusyBlock[]): string[] {
  return [...new Set(busy.filter((block) => block.status === "unknown").map((block) => block.address.toLowerCase()))];
}

function mergedPerPerson(busy: readonly BusyBlock[]): PersonInterval[] {
  const groups: Record<string, PersonInterval[]> = {};
  for (const block of busy) {
    let startMs: number;
    let endMs: number;
    try {
      startMs = instantToMs(block.start);
      endMs = instantToMs(block.end);
    } catch (error: unknown) {
      if (error instanceof RangeError) continue;
      throw error;
    }
    if (endMs <= startMs || typeof block.address !== "string") continue;
    const address = block.address.trim().toLowerCase();
    const status = block.status ?? "busy";
    const key = `${address}\u0000${status}`;
    (groups[key] ??= []).push({ address, status, startMs, endMs });
  }
  const merged: PersonInterval[] = [];
  for (const intervals of Object.values(groups)) {
    intervals.sort((a, b) => a.startMs - b.startMs);
    let current: PersonInterval | null = null;
    for (const interval of intervals) {
      if (current && interval.startMs <= current.endMs) {
        current.endMs = Math.max(current.endMs, interval.endMs);
      } else {
        current = { ...interval };
        merged.push(current);
      }
    }
  }
  return merged;
}

function minutesInDay(startMs: number, endMs: number, day: DaySlice, timeZone: string): { startMinute: number; endMinute: number } {
  const startMinute = startMs <= day.startMs ? 0 : wallMinutesAt(startMs, timeZone);
  let endMinute = endMs >= day.endMs ? MINUTES_PER_DAY : wallMinutesAt(endMs, timeZone);
  if (endMinute <= startMinute) {
    const elapsed = Math.round((Math.min(endMs, day.endMs) - Math.max(startMs, day.startMs)) / MS_PER_MINUTE);
    endMinute = Math.min(MINUTES_PER_DAY, startMinute + elapsed);
  }
  return { startMinute, endMinute };
}

/** Busy bands per day of the grid, merged per person and status. Every day in `days` has an entry. */
export function busyOverlays(
  busy: readonly BusyBlock[],
  days: readonly DaySlice[],
  timeZone: string,
): Record<DayKey, BusyOverlay[]> {
  const result: Record<DayKey, BusyOverlay[]> = {};
  for (const day of days) result[day.key] = [];
  for (const interval of mergedPerPerson(busy)) {
    for (const day of days) {
      if (!(interval.startMs < day.endMs && interval.endMs > day.startMs)) continue;
      const { startMinute, endMinute } = minutesInDay(interval.startMs, interval.endMs, day, timeZone);
      if (endMinute <= startMinute) continue;
      result[day.key].push({ address: interval.address, dayKey: day.key, startMinute, endMinute, status: interval.status });
    }
  }
  for (const day of days) {
    result[day.key].sort((a, b) => a.startMinute - b.startMinute || a.address.localeCompare(b.address));
  }
  return result;
}
