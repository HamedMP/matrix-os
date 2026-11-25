/**
 * Types for the Calendar agent: plain-language requests become a typed intent,
 * the intent runs against the calendar model, and the result is an answer the
 * UI can render. Write intents only ever produce an `EventDraft` or proposals;
 * nothing here creates, changes or deletes an event or sends an invite.
 */
import type {
  BusyBlock,
  CalendarEvent,
  CalendarInfo,
  EventDraft,
  IsoInstant,
  RecurrenceFrequency,
  Weekday,
} from "../../../_shared/office-accounts/types/calendar";
import type { Proposal } from "../model/proposals";
import type { WorkingHours } from "../model/slots";

// ---------------------------------------------------------------- relative references

export const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

/**
 * A day as the owner said it. The model returns these; code turns them into
 * calendar dates from "now" and the time zone, so the model never does date maths.
 */
export type DateRef =
  | { type: "today" }
  | { type: "tomorrow" }
  | { type: "yesterday" }
  /** In `days` days (negative for the past). */
  | { type: "offset"; days: number }
  /** "Thursday" (`which` absent or "this": the nearest one from today) or "next Thursday" (in next week). */
  | { type: "weekday"; day: WeekdayName; which?: "this" | "next" }
  /** "the 30th" or "March 3": the next such date on or after today. */
  | { type: "day_of_month"; day: number; month?: number }
  /** A date the owner wrote out in full, `YYYY-MM-DD`. */
  | { type: "date"; date: string };

/** A stretch of time as the owner said it. */
export type WindowRef =
  | { type: "this_week" }
  | { type: "next_week" }
  | { type: "this_month" }
  | { type: "day"; date: DateRef }
  /** From now until the start of that day. */
  | { type: "before"; date: DateRef }
  /** Both days included. */
  | { type: "between"; from: DateRef; to: DateRef }
  /** Today and the following `days` days. */
  | { type: "next_days"; days: number };

export interface RecurrenceRef {
  freq: RecurrenceFrequency;
  interval: number;
  byDay?: Weekday[];
  until?: DateRef;
  count?: number;
}

// ---------------------------------------------------------------- intents

/** People named in a request: addresses or names, plus "the same people as event eN". */
export interface PeopleRef {
  attendees: string[];
  /** Prompt alias of an event (`e3`) whose attendees to use. */
  attendeesFromEvent: string | null;
}

export interface AgendaIntent {
  type: "agenda";
  window: WindowRef | null;
}

export interface FindSlotsIntent extends PeopleRef {
  type: "find_slots";
  durationMinutes: number | null;
  window: WindowRef | null;
  count: number | null;
}

export interface ProposeTimesIntent extends PeopleRef {
  type: "propose_times";
  title: string;
  durationMinutes: number | null;
  window: WindowRef | null;
  count: number | null;
}

export interface DraftEventIntent extends PeopleRef {
  type: "draft_event";
  title: string;
  date: DateRef | null;
  /** Wall-clock `HH:MM` in the owner's zone. */
  time: string | null;
  durationMinutes: number | null;
  window: WindowRef | null;
  recurrence: RecurrenceRef | null;
  location: string;
  description: string;
  onlineMeeting: boolean;
}

export interface RescheduleIntent {
  type: "reschedule";
  /** Prompt alias of the event to move. */
  event: string;
  date: DateRef | null;
  time: string | null;
  window: WindowRef | null;
  count: number | null;
}

export interface ClarifyIntent {
  type: "clarify";
  /** Plain text, cleaned and capped; shown as text only. */
  question: string;
}

export type CalendarIntent =
  | AgendaIntent
  | FindSlotsIntent
  | ProposeTimesIntent
  | DraftEventIntent
  | RescheduleIntent
  | ClarifyIntent;

export type CalendarIntentType = CalendarIntent["type"];

// ---------------------------------------------------------------- execution

/** What the agent may read about the calendar. Built from the store's state. */
export interface CalendarAgentContext {
  /** Epoch ms. */
  now: number;
  timeZone: string;
  /** 0 Sunday to 6 Saturday. */
  weekStart: number;
  workingHours: WorkingHours;
  defaultDurationMinutes: number;
  /** The owner's own address, lower-cased; null when unknown. */
  ownerAddress: string | null;
  calendars: readonly CalendarInfo[];
  /** Events the owner already sees; used to name events in the prompt. */
  events: readonly CalendarEvent[];
  /** People already in the scheduling assistant, used when a request says "we" without names. */
  assistantAttendees: readonly string[];
}

/** Read-only access the agent needs. There is deliberately no write method here. */
export interface CalendarAgentDeps {
  /** One model call; resolves with the reply text. */
  generate(prompt: string): Promise<string>;
  /** Events of visible calendars that overlap `[start, end)`. */
  listEvents(start: IsoInstant, end: IsoInstant): Promise<CalendarEvent[]>;
  getFreeBusy(addresses: string[], start: IsoInstant, end: IsoInstant): Promise<BusyBlock[]>;
  /** Where real errors go; answers only ever hold fixed sentences. */
  log?(action: string, error: unknown): void;
}

export interface EventRef {
  id: string;
  title: string;
  start: IsoInstant;
  end: IsoInstant;
  allDay: boolean;
}

export interface SlotRef {
  /** `slot-<startMs>-<endMs>`; stable for the same slot. */
  id: string;
  start: IsoInstant;
  end: IsoInstant;
}

export interface ResolvedWindow {
  start: IsoInstant;
  /** Exclusive. */
  end: IsoInstant;
}

interface AnswerBase {
  /** One or two plain sentences written by code, never by the model. */
  text: string;
  /** Things the owner should know (unknown availability, names not found). Plain text. */
  notes: string[];
  events: EventRef[];
  slots: SlotRef[];
}

export type CalendarAgentAnswer =
  | (AnswerBase & { kind: "agenda"; window: ResolvedWindow })
  | (AnswerBase & { kind: "slots"; window: ResolvedWindow; attendees: string[] })
  /** Candidate times to place on the grid as "agent" proposals. */
  | (AnswerBase & { kind: "proposals"; window: ResolvedWindow; proposals: Proposal[] })
  /** A new event for the composer. The owner edits and sends it. */
  | (AnswerBase & { kind: "draft"; draft: EventDraft })
  /** New times for an existing event; each opens the event's edit draft at that slot. */
  | (AnswerBase & { kind: "reschedule"; eventId: string; durationMinutes: number })
  | (AnswerBase & { kind: "clarify" })
  | (AnswerBase & { kind: "error" });

export type CalendarAgentAnswerKind = CalendarAgentAnswer["kind"];
