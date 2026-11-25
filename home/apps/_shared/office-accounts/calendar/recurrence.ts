/**
 * Recurrence in both provider forms: RFC 5545 `RRULE` lines (Google) and
 * pattern plus range objects (Outlook). Rules the contract cannot describe
 * are shown as "Repeats" and never rewritten.
 */
import {
  RECURRENCE_FREQUENCIES,
  WEEKDAYS,
  allDayInstant,
  describeRecurrence,
  instantInZone,
  instantToMs,
  isValidRecurrence,
  localDateOf,
  recurrenceToRRule,
} from "../types/calendar.js";
import type { IsoInstant, Recurrence, RecurrenceFrequency, Weekday } from "../types/calendar.js";
import { asArray, asRecord, asString } from "./service.js";

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

// ---------------------------------------------------------------- Outlook

const GRAPH_DAYS: Readonly<Record<Weekday, string>> = {
  MO: "monday", TU: "tuesday", WE: "wednesday", TH: "thursday", FR: "friday", SA: "saturday", SU: "sunday",
};
const DAY_FROM_GRAPH = new Map(Object.entries(GRAPH_DAYS).map(([day, name]) => [name, day as Weekday]));
const DAY_BY_INDEX: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface GraphRecurrence {
  pattern: { type: string; interval: number; daysOfWeek?: string[]; dayOfMonth?: number; month?: number };
  range: { type: "noEnd" | "endDate" | "numbered"; startDate: string; endDate?: string; numberOfOccurrences?: number };
}

/** The local calendar date of an event start, in the zone it was scheduled in. */
function localStart(start: IsoInstant, timeZone: string, allDay: boolean): string {
  return allDay ? localDateOf(start) : localDateOf(instantInZone(instantToMs(start), timeZone));
}

/** Outlook's pattern and range for a contract recurrence starting at `start`. */
export function graphRecurrence(recurrence: Recurrence, start: IsoInstant, timeZone: string, allDay: boolean): GraphRecurrence {
  if (!isValidRecurrence(recurrence)) throw new RangeError("Invalid recurrence");
  const startDate = localStart(start, timeZone, allDay);
  const [year, month, day] = startDate.split("-").map(Number);
  const weekday = DAY_BY_INDEX[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const { interval } = recurrence;
  const pattern: GraphRecurrence["pattern"] =
    recurrence.freq === "daily" ? { type: "daily", interval }
      : recurrence.freq === "weekly" ? { type: "weekly", interval, daysOfWeek: (recurrence.byDay ?? [weekday]).map((code) => GRAPH_DAYS[code]) }
        : recurrence.freq === "monthly" ? { type: "absoluteMonthly", interval, dayOfMonth: day }
          : { type: "absoluteYearly", interval, dayOfMonth: day, month };
  let range: GraphRecurrence["range"] = { type: "noEnd", startDate };
  if (recurrence.count !== undefined) range = { type: "numbered", startDate, numberOfOccurrences: recurrence.count };
  if (recurrence.until !== undefined) {
    const endDate = allDay ? localDateOf(recurrence.until) : localDateOf(instantInZone(instantToMs(recurrence.until), timeZone));
    range = { type: "endDate", startDate, endDate: endDate < startDate ? startDate : endDate };
  }
  return { pattern, range };
}

const GRAPH_FREQUENCY: Readonly<Record<string, RecurrenceFrequency>> = {
  daily: "daily", weekly: "weekly", absoluteMonthly: "monthly", absoluteYearly: "yearly",
};

/** `recurrenceText` for an Outlook series master's `recurrence`. */
export function describeGraphRecurrence(value: unknown): string | undefined {
  const raw = asRecord(value);
  if (!raw.pattern) return undefined;
  const pattern = asRecord(raw.pattern);
  const range = asRecord(raw.range);
  const freq = GRAPH_FREQUENCY[asString(pattern.type)];
  if (!freq) return GENERIC_RECURRENCE_TEXT;
  const recurrence: Recurrence = { freq, interval: typeof pattern.interval === "number" ? pattern.interval : 1 };
  if (freq === "weekly") {
    const days = asArray(pattern.daysOfWeek).map((name) => DAY_FROM_GRAPH.get(asString(name).toLowerCase()));
    if (days.length > 0 && days.every((day): day is Weekday => day !== undefined)) {
      recurrence.byDay = WEEKDAYS.filter((day) => days.includes(day));
    }
  }
  const rangeType = asString(range.type);
  if (rangeType === "numbered" && typeof range.numberOfOccurrences === "number") {
    Object.assign(recurrence, { count: range.numberOfOccurrences });
  } else if (rangeType === "endDate") {
    try {
      Object.assign(recurrence, { until: allDayInstant(asString(range.endDate)) });
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      return GENERIC_RECURRENCE_TEXT;
    }
  }
  return isValidRecurrence(recurrence) ? describeRecurrence(recurrence) : GENERIC_RECURRENCE_TEXT;
}
