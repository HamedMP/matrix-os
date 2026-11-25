/**
 * Provider-neutral calendar contract for the Calendar app.
 *
 * The Calendar app and the agent's calendar tools talk to a `CalendarProvider`.
 * One adapter per provider (Google Calendar today) turns these shapes into
 * integration actions (`packages/gateway/src/integrations`).
 *
 * Times follow the rule in `time.ts`: every `start` and `end` is an ISO
 * date-time with an offset. Two additions apply to events:
 *
 * - Timed events. `timeZone` is the IANA zone the event was scheduled in. A
 *   draft's `start` and `end` must carry the offset that zone has at that
 *   moment (use `instantFromWallTime`), because providers store wall-clock time
 *   plus zone and recurring events follow that zone's daylight saving.
 * - All-day events. `allDay` is true, `start` is midnight UTC of the first day
 *   and `end` is midnight UTC of the day after the last day (exclusive). Only
 *   the date part means anything: read it with `allDayDate` and never shift it
 *   into the viewer's zone.
 *
 * Titles, descriptions, locations, names and join links come from other people
 * and are untrusted text. Open a join link only after checking it is `https:`.
 */
import { isValidMailAddress } from "./addresses.js";
import { instantToMs, isIsoInstant, localDateOf, toUtcInstant } from "./time.js";
import type { IsoInstant } from "./time.js";

export * from "./errors.js";
export * from "./time.js";

export type CalendarProviderId = "google";

/** The integration service that serves each calendar provider. */
export const CALENDAR_SERVICE_IDS: Readonly<Record<CalendarProviderId, string>> = Object.freeze({
  google: "google_calendar",
});

export interface CalendarAccount {
  /** Stable and opaque. Build it with `calendarAccountId`. */
  id: string;
  provider: CalendarProviderId;
  /** The owner's address on this account, lower-cased. */
  address: string;
  displayName: string;
}

export interface CalendarInfo {
  id: string;
  accountId: string;
  name: string;
  /** A CSS hex colour such as `#3366cc`. Adapters supply a default when the provider has none. */
  color: string;
  /** The account's default calendar. Exactly one per account. */
  primary: boolean;
  /** False for calendars the owner can only read (holidays, shared read-only). */
  writable: boolean;
  /** The owner's show or hide choice; a hidden calendar is not queried. */
  visible: boolean;
}

export const ATTENDEE_RESPONSES = ["accepted", "declined", "tentative", "needsAction"] as const;
export type AttendeeResponse = (typeof ATTENDEE_RESPONSES)[number];
/** What the owner can answer an invitation with. */
export type EventResponse = Exclude<AttendeeResponse, "needsAction">;

export interface CalendarAttendee {
  address: string;
  /** Empty when the provider has no name. */
  name: string;
  response: AttendeeResponse;
  organizer: boolean;
  optional?: boolean;
}

export type OnlineMeetingProvider = "google_meet" | "microsoft_teams" | "other";

export interface OnlineMeeting {
  provider: OnlineMeetingProvider;
  joinUrl: string;
}

export interface CalendarEvent {
  /**
   * Opaque and unique within the account. It carries everything the adapter
   * needs to find the event again (see `composeEventId`), so no method takes a
   * separate calendar id. For a recurring event this is one occurrence.
   */
  id: string;
  calendarId: string;
  title: string;
  start: IsoInstant;
  /** Exclusive. */
  end: IsoInstant;
  allDay: boolean;
  /** IANA zone the event was scheduled in; `UTC` for all-day events and when unknown. */
  timeZone: string;
  /** Empty when there is none. */
  location: string;
  /** Plain text. Adapters convert an HTML description to text. */
  descriptionText: string;
  attendees: CalendarAttendee[];
  /** A short description such as "Every 2 weeks on Monday"; set on recurring events. */
  recurrenceText?: string;
  /** Id of the recurring series this occurrence belongs to; usable wherever an event id is. */
  seriesId?: string;
  onlineMeeting?: OnlineMeeting;
  /** The owner's own answer, or null when the owner is not an invitee (for example their own event). */
  myResponse: AttendeeResponse | null;
}

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A series ends on a date, after a number of occurrences, or never; not both. */
export type RecurrenceEnd =
  | { until: IsoInstant; count?: never }
  | { count: number; until?: never }
  | { until?: never; count?: never };

export type Recurrence = {
  freq: RecurrenceFrequency;
  /** Every `interval` days, weeks, months or years; 1 to `MAX_RECURRENCE_INTERVAL`. */
  interval: number;
  /** Weekly series only: the days it falls on. Defaults to the weekday of `start`. */
  byDay?: Weekday[];
} & RecurrenceEnd;

export interface EventReminder {
  minutesBefore: number;
  method: "popup" | "email";
}

export interface EventDraftAttendee {
  address: string;
  name?: string;
  optional?: boolean;
}

export interface EventDraft {
  calendarId: string;
  title: string;
  start: IsoInstant;
  /** Exclusive. */
  end: IsoInstant;
  allDay: boolean;
  timeZone: string;
  location: string;
  descriptionText: string;
  attendees: EventDraftAttendee[];
  /** Ask the provider to attach a video meeting link. */
  addOnlineMeeting: boolean;
  recurrence?: Recurrence;
  /** Absent means the calendar's default reminders. Providers that hold one reminder use the first. */
  reminders?: EventReminder[];
}

/** Fields to change on an existing event. Absent fields are left as they are. */
export type EventChanges = Partial<Omit<EventDraft, "calendarId">>;

export type BusyStatus = "busy" | "tentative" | "outOfOffice" | "unknown";

export interface BusyBlock {
  address: string;
  start: IsoInstant;
  /** Exclusive. */
  end: IsoInstant;
  /**
   * Defaults to `busy`. When a person's availability cannot be read, the
   * adapter returns one `unknown` block that covers the whole requested range,
   * so "free" and "no information" never look the same.
   */
  status?: BusyStatus;
}

export interface ListEventsRequest {
  calendarIds: string[];
  start: IsoInstant;
  /** Exclusive. At most `MAX_EVENT_RANGE_DAYS` after `start`. */
  end: IsoInstant;
}

export interface InviteOptions {
  /**
   * Whether attendees are told. True only after the owner has confirmed in the
   * app (or approved an agent tool call). With false, an adapter whose provider
   * cannot stay silent rejects with `not_supported` instead of notifying anyone.
   */
  sendInvites: boolean;
}

export interface RespondOptions {
  comment?: string;
  /** Tell the organiser. Defaults to true. */
  notifyOrganizer?: boolean;
}

/**
 * Every method rejects with a `ProviderError`. No method retries on its own.
 * `createEvent`, `updateEvent`, `deleteEvent` and `respond` are only called
 * from an explicit owner action or an owner-approved agent tool call.
 */
export interface CalendarProvider {
  listCalendars(): Promise<CalendarInfo[]>;
  /** Occurrences of recurring events are returned as separate events, ordered by start. */
  listEvents(request: ListEventsRequest): Promise<CalendarEvent[]>;
  createEvent(draft: EventDraft, options: InviteOptions): Promise<CalendarEvent>;
  /** An occurrence id changes that occurrence; a `seriesId` changes the whole series. */
  updateEvent(eventId: string, changes: EventChanges, options: InviteOptions): Promise<CalendarEvent>;
  /** Moves the event to the provider's trash where one exists. Same id rule as `updateEvent`. */
  deleteEvent(eventId: string, options: InviteOptions): Promise<void>;
  respond(eventId: string, response: EventResponse, options?: RespondOptions): Promise<void>;
  /** Busy time for up to `MAX_FREE_BUSY_ADDRESSES` people. A person with no blocks is free. */
  getFreeBusy(addresses: string[], start: IsoInstant, end: IsoInstant): Promise<BusyBlock[]>;
}

export const MAX_EVENT_ATTENDEES = 100;
export const MAX_FREE_BUSY_ADDRESSES = 20;
export const MAX_EVENT_RANGE_DAYS = 62;
export const MAX_EVENT_REMINDERS = 5;
export const MAX_REMINDER_MINUTES = 40_320;
export const MAX_RECURRENCE_INTERVAL = 99;
export const MAX_RECURRENCE_COUNT = 730;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EVENT_ID_SEPARATOR = "/";

export function calendarAccountId(provider: CalendarProviderId, address: string): string {
  return `${provider}:${address.trim().toLowerCase()}`;
}

/** Midnight UTC of a `YYYY-MM-DD` calendar date: the start or exclusive end of an all-day event. */
export function allDayInstant(date: string): IsoInstant {
  const instant = `${date}T00:00:00Z`;
  if (!DATE.test(date) || !isIsoInstant(instant)) throw new RangeError("Expected a calendar date as YYYY-MM-DD");
  return instant;
}

/** The calendar date of an all-day `start` or `end`. */
export function allDayDate(instant: IsoInstant): string {
  return localDateOf(instant);
}

/**
 * Packs a calendar id and the provider's own event id into one `CalendarEvent.id`.
 * Neither part may be empty or contain `/`.
 */
export function composeEventId(calendarId: string, providerEventId: string): string {
  if (!calendarId || !providerEventId || calendarId.includes(EVENT_ID_SEPARATOR) || providerEventId.includes(EVENT_ID_SEPARATOR)) {
    throw new RangeError("Calendar and event ids must be non-empty and must not contain a slash");
  }
  return `${calendarId}${EVENT_ID_SEPARATOR}${providerEventId}`;
}

export function splitEventId(eventId: string): { calendarId: string; providerEventId: string } {
  const parts = eventId.split(EVENT_ID_SEPARATOR);
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new RangeError("Not a calendar event id");
  return { calendarId: parts[0], providerEventId: parts[1] };
}

/** True when two half-open ranges share any time. Back-to-back ranges do not overlap. */
export function instantsOverlap(aStart: IsoInstant, aEnd: IsoInstant, bStart: IsoInstant, bEnd: IsoInstant): boolean {
  return instantToMs(aStart) < instantToMs(bEnd) && instantToMs(bStart) < instantToMs(aEnd);
}

function isWholeNumberIn(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function isValidRecurrence(recurrence: Recurrence): boolean {
  if (!RECURRENCE_FREQUENCIES.includes(recurrence.freq)) return false;
  if (!isWholeNumberIn(recurrence.interval, 1, MAX_RECURRENCE_INTERVAL)) return false;
  if (recurrence.until !== undefined && recurrence.count !== undefined) return false;
  if (recurrence.until !== undefined && !isIsoInstant(recurrence.until)) return false;
  if (recurrence.count !== undefined && !isWholeNumberIn(recurrence.count, 1, MAX_RECURRENCE_COUNT)) return false;
  if (recurrence.byDay !== undefined) {
    const days = recurrence.byDay;
    if (recurrence.freq !== "weekly" || days.length === 0 || new Set(days).size !== days.length) return false;
    if (days.some((day) => !WEEKDAYS.includes(day))) return false;
  }
  return true;
}

/** The recurrence as one RFC 5545 line, for example `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10`. */
export function recurrenceToRRule(recurrence: Recurrence): string {
  if (!isValidRecurrence(recurrence)) throw new RangeError("Invalid recurrence");
  const parts = [`FREQ=${recurrence.freq.toUpperCase()}`];
  if (recurrence.interval > 1) parts.push(`INTERVAL=${recurrence.interval}`);
  if (recurrence.byDay) parts.push(`BYDAY=${recurrence.byDay.join(",")}`);
  if (recurrence.count !== undefined) parts.push(`COUNT=${recurrence.count}`);
  if (recurrence.until !== undefined) parts.push(`UNTIL=${toUtcInstant(recurrence.until).slice(0, 19).replace(/[-:]/g, "")}Z`);
  return `RRULE:${parts.join(";")}`;
}

const UNIT: Record<RecurrenceFrequency, string> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
const DAY_NAME: Record<Weekday, string> = {
  MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday",
};

/** A short English description, suitable for `CalendarEvent.recurrenceText`. */
export function describeRecurrence(recurrence: Recurrence): string {
  if (!isValidRecurrence(recurrence)) throw new RangeError("Invalid recurrence");
  const unit = UNIT[recurrence.freq];
  let text = recurrence.interval === 1 ? `Every ${unit}` : `Every ${recurrence.interval} ${unit}s`;
  if (recurrence.byDay) text += ` on ${recurrence.byDay.map((day) => DAY_NAME[day]).join(", ")}`;
  if (recurrence.count !== undefined) text += `, ${recurrence.count} times`;
  if (recurrence.until !== undefined) text += ` until ${localDateOf(recurrence.until)}`;
  return text;
}

export type EventDraftIssue =
  | "invalid_time"
  | "end_not_after_start"
  | "all_day_not_midnight_utc"
  | "too_many_attendees"
  | "invalid_attendee"
  | "invalid_recurrence"
  | "invalid_reminder";

const MIDNIGHT_UTC = "T00:00:00Z";

/**
 * Problems that would make a provider or the gateway reject the draft, found
 * before any provider call. An empty list means the draft can be created.
 */
export function eventDraftIssues(draft: EventDraft): EventDraftIssue[] {
  if (!isIsoInstant(draft.start) || !isIsoInstant(draft.end)) return ["invalid_time"];
  const issues: EventDraftIssue[] = [];
  if (instantToMs(draft.end) <= instantToMs(draft.start)) issues.push("end_not_after_start");
  if (draft.allDay && !(draft.start.endsWith(MIDNIGHT_UTC) && draft.end.endsWith(MIDNIGHT_UTC))) {
    issues.push("all_day_not_midnight_utc");
  }
  if (draft.attendees.length > MAX_EVENT_ATTENDEES) issues.push("too_many_attendees");
  if (draft.attendees.some((attendee) => !isValidMailAddress(attendee.address))) issues.push("invalid_attendee");
  if (draft.recurrence && !isValidRecurrence(draft.recurrence)) issues.push("invalid_recurrence");
  const reminders = draft.reminders ?? [];
  if (reminders.length > MAX_EVENT_REMINDERS
    || reminders.some((reminder) => !isWholeNumberIn(reminder.minutesBefore, 0, MAX_REMINDER_MINUTES)
      || (reminder.method !== "popup" && reminder.method !== "email"))) {
    issues.push("invalid_reminder");
  }
  return issues;
}
