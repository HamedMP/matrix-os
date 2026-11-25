/**
 * Recurrence as RFC 5545 `RRULE` lines, the form Google Calendar uses. Rules
 * the contract cannot describe are shown as "Repeats" and never rewritten.
 */
import {
  RECURRENCE_FREQUENCIES,
  WEEKDAYS,
  describeRecurrence,
  isValidRecurrence,
  localDateOf,
  recurrenceToRRule,
} from "../types/calendar.js";
import type { Recurrence, RecurrenceFrequency, Weekday } from "../types/calendar.js";
import { asArray } from "./service.js";

/** Shown for an occurrence, or for a rule the contract cannot describe. */
export const GENERIC_RECURRENCE_TEXT = "Repeats";

const RULE_PART = /^([A-Z]+)=([A-Z0-9,+-]+)$/;
const UNTIL_DATE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/;

/** The contract's recurrence for an `RRULE:` line, or undefined when it cannot be expressed. */
export function parseRRule(line: string): Recurrence | undefined {
  if (!line.startsWith("RRULE:")) return undefined;
  const parts = new Map<string, string>();
  for (const part of line.slice(6).split(";")) {
    const match = RULE_PART.exec(part);
    if (!match) return undefined;
    parts.set(match[1], match[2]);
  }
  const freq = (parts.get("FREQ") ?? "").toLowerCase() as RecurrenceFrequency;
  if (!RECURRENCE_FREQUENCIES.includes(freq)) return undefined;
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);
  if ([...parts.keys()].some((key) => !known.has(key))) return undefined;
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  const recurrence: Recurrence = { freq, interval };
  const byDay = parts.get("BYDAY");
  if (byDay !== undefined) {
    const days = byDay.split(",");
    if (freq !== "weekly" || days.some((day) => !WEEKDAYS.includes(day as Weekday))) return undefined;
    recurrence.byDay = days as Weekday[];
  }
  const count = parts.get("COUNT");
  const until = parts.get("UNTIL");
  if (count !== undefined && until !== undefined) return undefined;
  if (count !== undefined) Object.assign(recurrence, { count: Number(count) });
  if (until !== undefined) {
    const match = UNTIL_DATE.exec(until);
    if (!match) return undefined;
    const time = match[4] ? `${match[4]}:${match[5]}:${match[6]}` : "00:00:00";
    Object.assign(recurrence, { until: `${match[1]}-${match[2]}-${match[3]}T${time}Z` });
  }
  return isValidRecurrence(recurrence) ? recurrence : undefined;
}

/** `recurrenceText` for Google's `recurrence` lines (EXDATE and RDATE lines are ignored). */
export function describeRRuleLines(lines: unknown): string | undefined {
  const rules = asArray(lines).filter((line): line is string => typeof line === "string" && line.startsWith("RRULE:"));
  if (rules.length === 0) return undefined;
  const parsed = rules.length === 1 ? parseRRule(rules[0]) : undefined;
  return parsed ? describeRecurrence(parsed) : GENERIC_RECURRENCE_TEXT;
}

/**
 * The `RRULE` line to send. An all-day series ends on a date (RFC 5545 needs
 * a date `UNTIL` when the start is a date), read as written, not shifted.
 */
export function rruleForDraft(recurrence: Recurrence, allDay: boolean): string {
  const line = recurrenceToRRule(recurrence);
  if (!allDay || recurrence.until === undefined) return line;
  return line.replace(/UNTIL=\d{8}T\d{6}Z/, `UNTIL=${localDateOf(recurrence.until).replace(/-/g, "")}`);
}
