/**
 * Checks and small pieces calendar adapters share: argument validation,
 * the bounded event cache, meeting request ids and time conversions.
 */
import {
  MAX_EVENT_ATTENDEES,
  MAX_EVENT_RANGE_DAYS,
  MAX_FREE_BUSY_ADDRESSES,
  ProviderError,
  allDayDate,
  allDayInstant,
  eventDraftIssues,
  instantFromMs,
  instantToMs,
  isIsoInstant,
  splitEventId,
} from "../types/calendar.js";
import { isValidMailAddress } from "../types/addresses.js";
import type {
  AttendeeResponse,
  CalendarEvent,
  EventChanges,
  EventDraft,
  EventDraftAttendee,
  IsoInstant,
} from "../types/calendar.js";

export const DAY_MS = 86_400_000;
/** The adapters accept the same IANA-style names the gateway does. */
export const TIME_ZONE_NAME = /^[A-Za-z0-9_+/-]{1,64}$/;
export const DEFAULT_CALENDAR_COLOR = "#3366cc";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MIDNIGHT_UTC = "T00:00:00Z";

export function notSupported(message?: string): ProviderError {
  return new ProviderError("not_supported", message);
}

/** A CSS hex colour, lower-cased, or undefined for anything else. */
export function hexColor(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

/** Join links are opened only when they are `https:`. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch (error: unknown) {
    // An unparsable URL is a TypeError; anything else is a real fault.
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}

/** Positive and at most `MAX_EVENT_RANGE_DAYS` long. */
export function requireRange(start: IsoInstant, end: IsoInstant): { startMs: number; endMs: number } {
  if (!isIsoInstant(start) || !isIsoInstant(end)) throw notSupported("Choose a valid time range.");
  const startMs = instantToMs(start);
  const endMs = instantToMs(end);
  if (endMs <= startMs || endMs - startMs > MAX_EVENT_RANGE_DAYS * DAY_MS) throw notSupported("Choose a range of at most 62 days.");
  return { startMs, endMs };
}

/** Trimmed, lower-cased, de-duplicated addresses; refuses bad ones and too many. */
export function freeBusyAddresses(addresses: readonly string[]): string[] {
  const unique = [...new Set(addresses.map((address) => String(address).trim().toLowerCase()))];
  if (unique.some((address) => !isValidMailAddress(address))) throw notSupported("One of the addresses is not valid.");
  if (unique.length > MAX_FREE_BUSY_ADDRESSES) throw notSupported("Check availability for at most 20 people at a time.");
  return unique;
}

export function requireEventId(eventId: string): { calendarId: string; providerEventId: string } {
  try {
    return splitEventId(eventId);
  } catch (error: unknown) {
    if (error instanceof RangeError) throw notSupported("This event cannot be found.");
    throw error;
  }
}

export function requireDraft(draft: EventDraft): void {
  if (!draft.calendarId || draft.calendarId.includes("/")) throw notSupported("Choose a calendar.");
  if (eventDraftIssues(draft).length > 0) throw notSupported("Check the event details.");
  requireTitle(draft.title);
}

export function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw notSupported("Add a title.");
  return trimmed;
}

export function requireAttendees(attendees: readonly EventDraftAttendee[]): void {
  if (attendees.length > MAX_EVENT_ATTENDEES) throw notSupported("An event can have at most 100 guests.");
  if (attendees.some((attendee) => !isValidMailAddress(attendee.address.trim().toLowerCase()))) {
    throw notSupported("One of the guest addresses is not valid.");
  }
}

export function requireLength(value: string, maximum: number, what: string): string {
  if (value.length > maximum) throw notSupported(`The ${what} is too long.`);
  return value;
}

/** Guests other than the owner, with addresses normalised. Duplicates keep the first. */
export function normalizeAttendees(attendees: readonly EventDraftAttendee[], ownerAddress: string): EventDraftAttendee[] {
  const seen = new Set<string>([ownerAddress]);
  const result: EventDraftAttendee[] = [];
  for (const attendee of attendees) {
    const address = attendee.address.trim().toLowerCase();
    if (seen.has(address)) continue;
    seen.add(address);
    const name = attendee.name?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 128);
    result.push({ address, ...(name ? { name } : {}), ...(attendee.optional ? { optional: true } : {}) });
  }
  return result;
}

export interface ResolvedTimes {
  allDay: boolean;
  start: IsoInstant;
  end: IsoInstant;
  timeZone: string;
}

const TIME_KEYS = ["start", "end", "allDay", "timeZone"] as const;

/**
 * The full time of an updated event, or undefined when the change does not
 * touch time. Providers take start, end and zone together, so a part that
 * the change leaves out comes from the cached event; without one it fails.
 */
export function resolveChangedTimes(changes: EventChanges, cached: CalendarEvent | undefined): ResolvedTimes | undefined {
  if (!TIME_KEYS.some((key) => changes[key] !== undefined)) return undefined;
  const allDay = changes.allDay ?? cached?.allDay;
  const start = changes.start ?? cached?.start;
  const end = changes.end ?? cached?.end;
  if (allDay === undefined || start === undefined || end === undefined) {
    throw notSupported("Give the start, the end and whether the event lasts all day.");
  }
  const timeZone = allDay ? "UTC" : (changes.timeZone ?? cached?.timeZone ?? "UTC");
  requireTimes({ allDay, start, end, timeZone });
  return { allDay, start, end, timeZone };
}

export function requireTimes(times: ResolvedTimes): void {
  if (!isIsoInstant(times.start) || !isIsoInstant(times.end) || instantToMs(times.end) <= instantToMs(times.start)) {
    throw notSupported("The event must end after it starts.");
  }
  if (times.allDay && !(times.start.endsWith(MIDNIGHT_UTC) && times.end.endsWith(MIDNIGHT_UTC))) {
    throw notSupported("An all-day event runs from midnight to midnight.");
  }
  if (!times.allDay && !TIME_ZONE_NAME.test(times.timeZone)) throw notSupported("Choose a valid time zone.");
}

/** An all-day `end` that is not after `start` becomes the next day. */
export function allDayRange(startDate: string, endDate: string): { start: IsoInstant; end: IsoInstant } {
  const start = allDayInstant(startDate);
  let end = allDayInstant(endDate);
  if (instantToMs(end) <= instantToMs(start)) end = instantFromMs(instantToMs(start) + DAY_MS, 0);
  return { start, end };
}

export function allDayDates(start: IsoInstant, end: IsoInstant): { startDate: string; endDate: string } {
  return { startDate: allDayDate(start), endDate: allDayDate(end) };
}

const FRACTION = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Splits a provider date-time into wall-clock text and an optional offset,
 * trimming fractions to milliseconds. Undefined for anything else.
 */
export function parseProviderDateTime(value: unknown): { wall: string; fraction: string; offset: string | undefined } | undefined {
  if (typeof value !== "string") return undefined;
  const match = FRACTION.exec(value.trim());
  if (!match) return undefined;
  const millis = (match[2] ?? "").slice(0, 3).padEnd(3, "0");
  return { wall: match[1], fraction: millis === "000" ? "" : `.${millis}`, offset: match[3] };
}

/** A provider date-time that already carries an offset, as an `IsoInstant`. */
export function instantWithOffset(value: unknown): IsoInstant | undefined {
  const parsed = parseProviderDateTime(value);
  if (!parsed?.offset) return undefined;
  const instant = `${parsed.wall}${parsed.fraction}${parsed.offset}`;
  return isIsoInstant(instant) ? instant : undefined;
}

/**
 * A short, stable id for a meeting-link request: the same draft gives the
 * same id (so a retried create cannot add a second link), different drafts
 * give different ids.
 */
export function meetingRequestId(salt: string, value: unknown): string {
  const text = `${salt}\u0000${JSON.stringify(value)}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
    b ^= b >>> 15;
  }
  return `mx-${a.toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/** A per-provider random salt for meeting request ids. */
export function randomSalt(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What the adapters remember about an event they returned, for later writes. */
export interface CachedEvent {
  event: CalendarEvent;
  /** Rooms and other resources the normalised attendee list leaves out. */
  resources: { address: string; name: string; response: AttendeeResponse }[];
}

export const MAX_CACHED_EVENTS = 1000;

/** A size-capped map of recently seen events; the least recently used is evicted first. */
export class EventCache {
  private readonly entries = new Map<string, CachedEvent>();

  constructor(private readonly capacity = MAX_CACHED_EVENTS) {}

  get(id: string): CachedEvent | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      this.entries.set(id, entry);
    }
    return entry;
  }

  set(entry: CachedEvent): void {
    this.entries.delete(entry.event.id);
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(entry.event.id, entry);
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Events ordered by start, then end; the sort is stable. */
export function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events
    .map((event) => ({ event, start: instantToMs(event.start), end: instantToMs(event.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(({ event }) => event);
}
