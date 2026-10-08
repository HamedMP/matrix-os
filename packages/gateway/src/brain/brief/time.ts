/**
 * UTC days and brief windows. A day window is [date 00:00Z, +1 day); a week window is the 7 days ending with date.
 */
import { BrainApiError } from "../api/types.js";
import { BRAIN_BRIEF_LIMITS, BRAIN_DATE_PATTERN, type BrainBriefWindow } from "../contracts.js";

export const DAY_MS = 86_400_000;

/** YYYY-MM-DD of an instant, in UTC. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Midnight UTC of a YYYY-MM-DD that names a real calendar day; null otherwise. */
export function parseUtcDate(value: string): Date | null {
  if (!BRAIN_DATE_PATTERN.test(value)) return null;
  const at = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) || utcDate(at) !== value ? null : at;
}

/** parseUtcDate's rule as one pattern for SQL `~`: YYYY-MM-DD of a real calendar day, leap days included. */
export const CALENDAR_DATE = new RegExp(String.raw`^(?:\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])`
  + String.raw`|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8]))`
  + String.raw`|(?:\d\d(?:[02468][48]|[13579][26]|[2468]0)|(?:[02468][048]|[13579][26])00)-02-29)$`);

export interface BriefWindowRange { readonly date: string; readonly from: Date; readonly to: Date }

/**
 * The window of a brief date: default today UTC; a date after today or more than historyDays back is
 * invalid_request.
 */
export function briefWindow(date: string | undefined, window: BrainBriefWindow, now: Date): BriefWindowRange {
  const today = parseUtcDate(utcDate(now))!;
  const day = date === undefined ? today : parseUtcDate(date);
  const earliest = today.getTime() - BRAIN_BRIEF_LIMITS.historyDays * DAY_MS;
  if (day === null || day.getTime() > today.getTime() || day.getTime() < earliest) {
    throw new BrainApiError("invalid_request");
  }
  const to = new Date(day.getTime() + DAY_MS);
  return { date: utcDate(day), from: window === "day" ? day : new Date(to.getTime() - 7 * DAY_MS), to };
}

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}
