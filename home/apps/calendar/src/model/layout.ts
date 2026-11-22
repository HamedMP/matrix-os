/**
 * Where events go on the time grid and in the bar row above it.
 *
 * Timed events shorter than a day are cut at each zoned midnight and placed by
 * the wall clock, so a 09:00 event sits on the 09:00 line even on a 23 or 25
 * hour day. All-day events and events of a day or longer are drawn as bars
 * that span day columns instead.
 */
import { allDayDate, instantToMs, type CalendarEvent } from "../../../_shared/office-accounts/types/calendar";
import {
  MINUTES_PER_DAY,
  MS_PER_MINUTE,
  addDays,
  compareDayKeys,
  dayKeyAt,
  wallMinutesAt,
  type DayKey,
  type DaySlice,
} from "./dates";

/** Shortest height, in minutes, an event is laid out with so it stays clickable. */
export const MIN_SEGMENT_MINUTES = 15;
const DAY_MS = MINUTES_PER_DAY * MS_PER_MINUTE;

export interface TimedSegment {
  event: CalendarEvent;
  dayKey: DayKey;
  /** Wall-clock minute the segment starts at in its day, 0 to 1439. */
  startMinute: number;
  /** Wall-clock minute it ends at, up to 1440; at least `MIN_SEGMENT_MINUTES` after the start when room allows. */
  endMinute: number;
  /** The event started on an earlier day. */
  continuesBefore: boolean;
  /** The event goes on into a later day. */
  continuesAfter: boolean;
}

export interface PositionedSegment extends TimedSegment {
  /** Zero-based column inside its overlap cluster. */
  column: number;
  /** Columns the cluster is divided into; the segment's width is `span / columnCount`. */
  columnCount: number;
  /** Columns the segment may stretch over (1 or more) because its neighbours are free. */
  span: number;
}

export interface BarPlacement {
  event: CalendarEvent;
  /** Index into the day list of the first day the bar covers. */
  startIndex: number;
  /** Index after the last day it covers (exclusive). */
  endIndex: number;
  row: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

function eventMs(event: CalendarEvent): { startMs: number; endMs: number } {
  const startMs = instantToMs(event.start);
  return { startMs, endMs: Math.max(startMs, instantToMs(event.end)) };
}

/** True for events drawn as bars: all-day events and timed events of 24 hours or more. */
export function isMultiDayBar(event: CalendarEvent): boolean {
  if (event.allDay) return true;
  const { startMs, endMs } = eventMs(event);
  return endMs - startMs >= DAY_MS;
}

/** First calendar day and the exclusive end day an event covers in the viewer's zone. */
export function eventDaySpan(event: CalendarEvent, timeZone: string): { startKey: DayKey; endKey: DayKey } {
  if (event.allDay) {
    const startKey = allDayDate(event.start);
    const endKey = allDayDate(event.end);
    return { startKey, endKey: compareDayKeys(endKey, startKey) > 0 ? endKey : addDays(startKey, 1) };
  }
  const { startMs, endMs } = eventMs(event);
  const startKey = dayKeyAt(startMs, timeZone);
  const lastKey = dayKeyAt(Math.max(startMs, endMs - 1), timeZone);
  return { startKey, endKey: addDays(lastKey, 1) };
}

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return instantToMs(a.start) - instantToMs(b.start)
    || instantToMs(b.end) - instantToMs(a.end)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id);
}

function sliceOne(event: CalendarEvent, day: DaySlice, timeZone: string): TimedSegment | null {
  const { startMs, endMs } = eventMs(event);
  const pointInDay = endMs === startMs && startMs >= day.startMs && startMs < day.endMs;
  if (!(startMs < day.endMs && endMs > day.startMs) && !pointInDay) return null;
  const continuesBefore = startMs < day.startMs;
  const continuesAfter = endMs > day.endMs;
  const startMinute = continuesBefore ? 0 : wallMinutesAt(startMs, timeZone);
  let endMinute = endMs >= day.endMs ? MINUTES_PER_DAY : wallMinutesAt(endMs, timeZone);
  if (endMinute <= startMinute) {
    // A fall-back repeat hour can make the wall clock run backwards; use elapsed time.
    const elapsed = Math.round((Math.min(endMs, day.endMs) - Math.max(startMs, day.startMs)) / MS_PER_MINUTE);
    endMinute = startMinute + elapsed;
  }
  endMinute = Math.min(MINUTES_PER_DAY, Math.max(endMinute, startMinute + MIN_SEGMENT_MINUTES));
  return { event, dayKey: day.key, startMinute, endMinute, continuesBefore, continuesAfter };
}

/** Timed events shorter than a day, cut into one segment per day they touch. */
export function sliceTimedEvents(
  events: readonly CalendarEvent[],
  days: readonly DaySlice[],
  timeZone: string,
): Record<DayKey, TimedSegment[]> {
  const result: Record<DayKey, TimedSegment[]> = {};
  for (const day of days) result[day.key] = [];
  const timed = events.filter((event) => !isMultiDayBar(event)).sort(compareEvents);
  for (const event of timed) {
    for (const day of days) {
      const segment = sliceOne(event, day, timeZone);
      if (segment) result[day.key].push(segment);
    }
  }
  return result;
}

function compareSegments(a: TimedSegment, b: TimedSegment): number {
  return a.startMinute - b.startMinute || b.endMinute - a.endMinute || compareEvents(a.event, b.event);
}

function overlaps(a: TimedSegment, b: TimedSegment): boolean {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

function placeCluster(cluster: TimedSegment[], columns: number[], output: PositionedSegment[]): void {
  const columnCount = Math.max(1, Math.max(...columns) + 1);
  const placed = cluster.map((segment, index) => ({ segment, column: columns[index] }));
  for (const { segment, column } of placed) {
    let span = 1;
    while (column + span < columnCount) {
      const next = column + span;
      if (placed.some((other) => other.column === next && overlaps(other.segment, segment))) break;
      span += 1;
    }
    output.push({ ...segment, column, columnCount, span });
  }
}

/**
 * Side-by-side columns for one day's segments. Events that overlap, directly
 * or through a chain, form a cluster that shares the day's width; each event
 * takes the first column free at its start and widens into free columns.
 */
export function layoutColumns(segments: readonly TimedSegment[]): PositionedSegment[] {
  const sorted = [...segments].sort(compareSegments);
  const output: PositionedSegment[] = [];
  let cluster: TimedSegment[] = [];
  let clusterColumns: number[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  for (const segment of sorted) {
    if (cluster.length > 0 && segment.startMinute >= clusterEnd) {
      placeCluster(cluster, clusterColumns, output);
      cluster = [];
      clusterColumns = [];
      columnEnds = [];
    }
    let column = columnEnds.findIndex((end) => end <= segment.startMinute);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(segment.endMinute);
    } else {
      columnEnds[column] = segment.endMinute;
    }
    cluster.push(segment);
    clusterColumns.push(column);
    clusterEnd = cluster.length === 1 ? segment.endMinute : Math.max(clusterEnd, segment.endMinute);
  }
  if (cluster.length > 0) placeCluster(cluster, clusterColumns, output);
  return output;
}

/** Sliced and column-placed timed events for every day of a time grid. */
export function layoutTimedGrid(
  events: readonly CalendarEvent[],
  days: readonly DaySlice[],
  timeZone: string,
): Record<DayKey, PositionedSegment[]> {
  const sliced = sliceTimedEvents(events, days, timeZone);
  const result: Record<DayKey, PositionedSegment[]> = {};
  for (const day of days) result[day.key] = layoutColumns(sliced[day.key]);
  return result;
}

interface BarCandidate {
  event: CalendarEvent;
  startIndex: number;
  endIndex: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Where an event's days fall in `dayKeys` (sorted, possibly with gaps), or null when it shows on none. */
export function barCandidate(event: CalendarEvent, dayKeys: readonly DayKey[], timeZone: string): BarCandidate | null {
  if (dayKeys.length === 0) return null;
  const { startKey, endKey } = eventDaySpan(event, timeZone);
  const startIndex = dayKeys.findIndex((day) => compareDayKeys(day, startKey) >= 0);
  if (startIndex === -1) return null;
  let endIndex = startIndex;
  while (endIndex < dayKeys.length && compareDayKeys(dayKeys[endIndex], endKey) < 0) endIndex += 1;
  if (endIndex <= startIndex) return null;
  return {
    event,
    startIndex,
    endIndex,
    continuesBefore: compareDayKeys(startKey, dayKeys[startIndex]) < 0,
    continuesAfter: compareDayKeys(endKey, addDays(dayKeys[endIndex - 1], 1)) > 0,
  };
}

function compareBars(a: BarCandidate, b: BarCandidate): number {
  return a.startIndex - b.startIndex
    || (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex)
    || Number(b.event.allDay) - Number(a.event.allDay)
    || compareEvents(a.event, b.event);
}

/** Packs bars into the fewest rows: earliest first, longest first, then all-day before timed. */
export function packBars(candidates: readonly BarCandidate[]): { bars: BarPlacement[]; rowCount: number } {
  const rowEnds: number[] = [];
  const bars: BarPlacement[] = [];
  for (const candidate of [...candidates].sort(compareBars)) {
    let row = rowEnds.findIndex((end) => end <= candidate.startIndex);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(candidate.endIndex);
    } else {
      rowEnds[row] = candidate.endIndex;
    }
    bars.push({ ...candidate, row });
  }
  return { bars, rowCount: rowEnds.length };
}

/** The bar row above a time grid: all-day events and events of a day or longer. */
export function layoutBars(
  events: readonly CalendarEvent[],
  dayKeys: readonly DayKey[],
  timeZone: string,
): { bars: BarPlacement[]; rowCount: number } {
  const candidates: BarCandidate[] = [];
  for (const event of events) {
    if (!isMultiDayBar(event)) continue;
    const candidate = barCandidate(event, dayKeys, timeZone);
    if (candidate) candidates.push(candidate);
  }
  return packBars(candidates);
}
