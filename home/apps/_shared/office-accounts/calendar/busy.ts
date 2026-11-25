/**
 * Turns raw busy intervals into `BusyBlock[]`: clipped to the requested range,
 * overlapping and touching intervals merged, and where statuses overlap the
 * stronger one wins (out of office, then busy, then tentative, then unknown).
 */
import { instantFromMs } from "../types/calendar.js";
import type { BusyBlock, BusyStatus, IsoInstant } from "../types/calendar.js";

export interface BusyInterval {
  startMs: number;
  endMs: number;
  status: Exclude<BusyStatus, "unknown"> | "unknown";
}

const STRENGTH: Readonly<Record<BusyStatus, number>> = { unknown: 1, tentative: 2, busy: 3, outOfOffice: 4 };

/** Upper bound on intervals read per person; a busier reply is cut. */
export const MAX_BUSY_INTERVALS = 2000;

export function mergeBusyIntervals(address: string, intervals: readonly BusyInterval[], rangeStartMs: number, rangeEndMs: number): BusyBlock[] {
  const clipped = intervals
    .slice(0, MAX_BUSY_INTERVALS)
    .map((interval) => ({ ...interval, startMs: Math.max(interval.startMs, rangeStartMs), endMs: Math.min(interval.endMs, rangeEndMs) }))
    .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.endMs > interval.startMs);
  if (clipped.length === 0) return [];

  const edges = [...new Set(clipped.flatMap((interval) => [interval.startMs, interval.endMs]))].sort((a, b) => a - b);
  const segments: BusyInterval[] = [];
  for (let index = 0; index < edges.length - 1; index++) {
    const startMs = edges[index];
    const endMs = edges[index + 1];
    let status: BusyStatus | undefined;
    for (const interval of clipped) {
      if (interval.startMs <= startMs && interval.endMs >= endMs && (!status || STRENGTH[interval.status] > STRENGTH[status])) {
        status = interval.status;
      }
    }
    if (!status) continue;
    const previous = segments[segments.length - 1];
    if (previous && previous.endMs === startMs && previous.status === status) previous.endMs = endMs;
    else segments.push({ startMs, endMs, status });
  }
  return segments.map((segment) => ({
    address,
    start: instantFromMs(segment.startMs, 0),
    end: instantFromMs(segment.endMs, 0),
    status: segment.status,
  }));
}

/** One block over the whole range, for a person whose availability cannot be read. */
export function unknownBlock(address: string, start: IsoInstant, end: IsoInstant): BusyBlock {
  return { address, start, end, status: "unknown" };
}
