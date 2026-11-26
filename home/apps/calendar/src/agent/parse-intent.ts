/**
 * Defensive parsing of the model's reply into a `CalendarIntent`.
 *
 * The reply is untrusted text. It may wrap the JSON in prose or a code fence,
 * be cut off, or contain fields we never asked for. We take the first complete
 * JSON object, validate every field against the shapes we accept, cap every
 * string and list, and drop event aliases the prompt did not offer. Anything
 * that does not fit becomes null, which the caller turns into a fixed message.
 */
import {
  MAX_RECURRENCE_COUNT,
  MAX_RECURRENCE_INTERVAL,
  RECURRENCE_FREQUENCIES,
  WEEKDAYS,
  type RecurrenceFrequency,
  type Weekday,
} from "../../../_shared/office-accounts/types/calendar";
import { MINUTES_PER_DAY } from "../model/dates";
import { cleanText as cleanModelText } from "../model/proposals";
import { parseDateRef, parseWallTime, parseWindowRef } from "./relative-dates";
import type { CalendarIntent, PeopleRef, RecurrenceRef } from "./types";

/** Replies longer than the bridge's cap are cut before scanning. */
export const MAX_REPLY_CHARS = 64_000;
export const MAX_INTENT_ATTENDEES = 20;
export const MAX_SLOT_COUNT = 10;
export const MAX_TITLE_LENGTH = 200;
export const MAX_LOCATION_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_QUESTION_LENGTH = 300;
const MAX_JSON_DEPTH = 8;
const MAX_PARSE_ATTEMPTS = 20;

/**
 * The first balanced `{...}` in `text`, parsed. Strings are scanned so braces
 * inside them do not count. Returns null when there is none or it does not parse.
 */
export function extractJsonObject(text: unknown): unknown {
  if (typeof text !== "string") return null;
  const source = text.slice(0, MAX_REPLY_CHARS);
  let attempts = 0;
  for (let start = source.indexOf("{"); start !== -1 && attempts < MAX_PARSE_ATTEMPTS; start = source.indexOf("{", start + 1)) {
    attempts += 1;
    const end = matchingBrace(source, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(source.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

function matchingBrace(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return -1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Plain one-line text: line breaks become spaces, control and direction characters go, length is capped. */
export function cleanText(value: unknown, maxLength: number): string {
  return cleanModelText(typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ") : value, maxLength);
}

function wholeIn(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value === "string" && /^\d{1,5}$/.test(value.trim())) value = Number(value.trim());
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function people(value: Record<string, unknown>, aliases: Readonly<Record<string, string>>): PeopleRef {
  const list = Array.isArray(value.attendees) ? value.attendees : [];
  const attendees = new Set<string>();
  let cut = false;
  for (const item of list.slice(0, MAX_INTENT_ATTENDEES * 5)) {
    const raw = typeof item === "string" ? item : item && typeof item === "object" ? (item as { address?: unknown; name?: unknown }).address ?? (item as { name?: unknown }).name : null;
    const text = cleanText(raw, 254);
    if (!text || attendees.has(text)) continue;
    // A person past the cap is reported as left out, never dropped silently.
    if (attendees.size >= MAX_INTENT_ATTENDEES) {
      cut = true;
      break;
    }
    attendees.add(text);
  }
  if (list.length > MAX_INTENT_ATTENDEES * 5) cut = true;
  return { attendees: [...attendees], attendeesFromEvent: alias(value.attendeesFromEvent, aliases), ...(cut ? { attendeesCut: true } : {}) };
}

function alias(value: unknown, aliases: Readonly<Record<string, string>>): string | null {
  return typeof value === "string" && /^e\d{1,3}$/.test(value) && Object.hasOwn(aliases, value) ? value : null;
}

function duration(value: unknown): number | null {
  return wholeIn(value, 5, MINUTES_PER_DAY);
}

function count(value: unknown): number | null {
  return wholeIn(value, 1, MAX_SLOT_COUNT);
}

function recurrence(raw: unknown): RecurrenceRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const freq = typeof value.freq === "string" ? value.freq.toLowerCase() : "";
  if (!RECURRENCE_FREQUENCIES.includes(freq as RecurrenceFrequency)) return null;
  const result: RecurrenceRef = { freq: freq as RecurrenceFrequency, interval: wholeIn(value.interval, 1, MAX_RECURRENCE_INTERVAL) ?? 1 };
  if (result.freq === "weekly" && Array.isArray(value.byDay)) {
    const days = [...new Set(value.byDay.slice(0, 7).map((day) => (typeof day === "string" ? day.toUpperCase().slice(0, 2) : "")))]
      .filter((day): day is Weekday => WEEKDAYS.includes(day as Weekday));
    if (days.length > 0) result.byDay = days;
  }
  const until = parseDateRef(value.until);
  const times = wholeIn(value.count, 1, MAX_RECURRENCE_COUNT);
  if (until) result.until = until;
  else if (times !== null) result.count = times;
  return result;
}

/**
 * Validates a parsed reply. `aliases` are the event aliases the prompt offered;
 * an intent that needs an event the prompt did not list becomes a question.
 */
export function validateIntent(raw: unknown, aliases: Readonly<Record<string, string>>): CalendarIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const intent = typeof value.intent === "string" ? value.intent : typeof value.type === "string" ? value.type : "";
  switch (intent) {
    case "agenda":
      return { type: "agenda", window: parseWindowRef(value.window) };
    case "find_slots":
      return {
        type: "find_slots",
        ...people(value, aliases),
        durationMinutes: duration(value.durationMinutes),
        window: parseWindowRef(value.window),
        count: count(value.count),
      };
    case "propose_times":
      return {
        type: "propose_times",
        title: cleanText(value.title, MAX_TITLE_LENGTH),
        ...people(value, aliases),
        durationMinutes: duration(value.durationMinutes),
        window: parseWindowRef(value.window),
        count: count(value.count),
      };
    case "draft_event":
      return {
        type: "draft_event",
        title: cleanText(value.title, MAX_TITLE_LENGTH),
        date: parseDateRef(value.date),
        time: parseWallTime(value.time) === null ? null : (value.time as string).trim(),
        durationMinutes: duration(value.durationMinutes),
        window: parseWindowRef(value.window),
        ...people(value, aliases),
        recurrence: recurrence(value.recurrence),
        location: cleanText(value.location, MAX_LOCATION_LENGTH),
        description: cleanText(value.description, MAX_DESCRIPTION_LENGTH),
        onlineMeeting: value.onlineMeeting === true,
      };
    case "reschedule": {
      const event = alias(value.event ?? value.eventId, aliases);
      if (!event) return { type: "clarify", question: "Which event should I move? I could not find it on your calendar." };
      return {
        type: "reschedule",
        event,
        date: parseDateRef(value.date),
        time: parseWallTime(value.time) === null ? null : (value.time as string).trim(),
        window: parseWindowRef(value.window),
        count: count(value.count),
        // A move keeps the event's length and guests; the answer says so when they were asked for.
        ...(duration(value.durationMinutes) !== null || (Array.isArray(value.attendees) && value.attendees.length > 0) ? { asksForChanges: true } : {}),
      };
    }
    case "clarify": {
      const question = cleanText(value.question, MAX_QUESTION_LENGTH);
      return { type: "clarify", question: question || "Could you say that another way?" };
    }
    default:
      return null;
  }
}

/** `extractJsonObject` then `validateIntent`. */
export function parseIntentReply(text: unknown, aliases: Readonly<Record<string, string>>): CalendarIntent | null {
  return validateIntent(extractJsonObject(text), aliases);
}
