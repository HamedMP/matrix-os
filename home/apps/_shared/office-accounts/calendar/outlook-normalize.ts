/**
 * Microsoft Graph v1.0 calendar JSON to the provider-neutral calendar contract.
 * Everything read here is untrusted text from other people.
 */
import { composeEventId, instantFromWallTime, instantInZone, instantToMs, isIsoInstant, localDateOf } from "../types/calendar.js";
import type {
  AttendeeResponse,
  CalendarAccount,
  CalendarAttendee,
  CalendarEvent,
  CalendarInfo,
  IsoInstant,
  OnlineMeeting,
} from "../types/calendar.js";
import { DEFAULT_CALENDAR_COLOR, allDayRange, hexColor, isHttpsUrl, parseProviderDateTime } from "./common.js";
import type { CachedEvent } from "./common.js";
import { descriptionToText } from "./description.js";
import { GENERIC_RECURRENCE_TEXT, describeGraphRecurrence } from "./recurrence.js";
import { asArray, asRecord, asString } from "./service.js";
import type { JsonRecord } from "./service.js";
import { ianaZone } from "./zones.js";

/** Graph's ids: the same rule the gateway applies to path segments. */
export const GRAPH_ID = /^[A-Za-z0-9_+=-]{1,512}$/;

/** Colours for Graph's named calendar colours; `auto` uses the default. */
const GRAPH_CALENDAR_COLORS: Readonly<Record<string, string>> = {
  lightBlue: "#71afe5", lightGreen: "#5fbe7d", lightOrange: "#f7a35c", lightGray: "#a19f9d", lightYellow: "#f2d75b",
  lightTeal: "#4bc1c0", lightPink: "#ee8dc0", lightBrown: "#c19c6b", lightRed: "#e86a6a",
};

const RESPONSES: Readonly<Record<string, AttendeeResponse>> = {
  accepted: "accepted", organizer: "accepted", declined: "declined", tentativelyAccepted: "tentative",
};

export function normalizeOutlookCalendar(raw: JsonRecord, account: CalendarAccount): CalendarInfo | undefined {
  const id = asString(raw.id);
  if (!GRAPH_ID.test(id)) return undefined;
  return {
    id,
    accountId: account.id,
    name: asString(raw.name) || "Calendar",
    color: hexColor(raw.hexColor) ?? GRAPH_CALENDAR_COLORS[asString(raw.color)] ?? DEFAULT_CALENDAR_COLOR,
    primary: raw.isDefaultCalendar === true,
    writable: raw.canEdit === true,
    // Graph has no show or hide setting for calendars.
    visible: true,
  };
}

/**
 * A Graph `{ dateTime, timeZone }` as an instant. UTC values keep the `Z`
 * form; values in another zone carry that zone's offset at that moment.
 */
export function graphInstant(value: unknown): IsoInstant | undefined {
  const raw = asRecord(value);
  const parsed = parseProviderDateTime(raw.dateTime);
  if (!parsed) return undefined;
  if (parsed.offset) {
    const instant = `${parsed.wall}${parsed.fraction}${parsed.offset}`;
    return isIsoInstant(instant) ? instant : undefined;
  }
  const zone = ianaZone(raw.timeZone);
  if (zone === "UTC") {
    const instant = `${parsed.wall}${parsed.fraction}Z`;
    return isIsoInstant(instant) ? instant : undefined;
  }
  try {
    return instantFromWallTime(parsed.wall, zone);
  } catch (error: unknown) {
    if (!(error instanceof RangeError)) throw error;
    return undefined;
  }
}

/**
 * The calendar date of an all-day boundary. Graph normally sends midnight wall
 * time; a value that is not midnight is the moment of midnight in the event's
 * own zone, so it is read in that zone instead of being shifted.
 */
function allDayBoundary(value: unknown, originalZone: unknown): string | undefined {
  const parsed = parseProviderDateTime(asRecord(value).dateTime);
  if (!parsed) return undefined;
  if (parsed.wall.endsWith("T00:00:00") && !parsed.offset) return parsed.wall.slice(0, 10);
  const instant = graphInstant(value);
  if (!instant) return undefined;
  const local = instantInZone(instantToMs(instant), ianaZone(originalZone));
  // Round to the nearest midnight so a few minutes of zone drift cannot move the date.
  const date = localDateOf(local);
  return Number(local.slice(11, 13)) >= 12 ? nextDate(date) : date;
}

function nextDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function times(raw: JsonRecord): { start: IsoInstant; end: IsoInstant; allDay: boolean } | undefined {
  if (raw.isAllDay === true) {
    const startDate = allDayBoundary(raw.start, raw.originalStartTimeZone);
    const endDate = allDayBoundary(raw.end, raw.originalEndTimeZone ?? raw.originalStartTimeZone);
    if (!startDate || !endDate) return undefined;
    try {
      return { ...allDayRange(startDate, endDate), allDay: true };
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      return undefined;
    }
  }
  const start = graphInstant(raw.start);
  const end = graphInstant(raw.end);
  return start && end ? { start, end, allDay: false } : undefined;
}

function onlineMeeting(raw: JsonRecord): OnlineMeeting | undefined {
  const joinUrl = asString(asRecord(raw.onlineMeeting).joinUrl) || asString(raw.onlineMeetingUrl);
  if (!joinUrl || !isHttpsUrl(joinUrl)) return undefined;
  const named = asString(raw.onlineMeetingProvider).toLowerCase().includes("teams");
  const host = new URL(joinUrl).hostname.toLowerCase();
  const teams = named || host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com");
  return { provider: teams ? "microsoft_teams" : "other", joinUrl };
}

function emailAddress(value: unknown): { address: string; name: string } {
  const email = asRecord(asRecord(value).emailAddress);
  return { address: asString(email.address).trim().toLowerCase(), name: asString(email.name) };
}

function attendees(raw: JsonRecord): { list: CalendarAttendee[]; resources: CachedEvent["resources"] } {
  const organizer = emailAddress(raw.organizer);
  const list: CalendarAttendee[] = [];
  const resources: CachedEvent["resources"] = [];
  for (const entry of asArray(raw.attendees)) {
    const person = asRecord(entry);
    const { address, name } = emailAddress(person);
    if (!address) continue;
    const answer = RESPONSES[asString(asRecord(person.status).response)] ?? "needsAction";
    if (person.type === "resource") {
      resources.push({ address, name, response: answer });
      continue;
    }
    const isOrganizer = address === organizer.address;
    const attendee: CalendarAttendee = { address, name, response: isOrganizer ? "accepted" : answer, organizer: isOrganizer };
    if (person.type === "optional") attendee.optional = true;
    list.push(attendee);
  }
  // Graph leaves the organiser out of the list; show them like other providers do.
  if (list.length > 0 && organizer.address && !list.some((attendee) => attendee.organizer)) {
    list.unshift({ address: organizer.address, name: organizer.name, response: "accepted", organizer: true });
  }
  return { list, resources };
}

function myResponse(raw: JsonRecord): AttendeeResponse | null {
  if (raw.isOrganizer === true) return null;
  const answer = asString(asRecord(raw.responseStatus).response);
  if (!answer || answer === "organizer") return null;
  return RESPONSES[answer] ?? "needsAction";
}

function description(raw: JsonRecord): string {
  const body = asRecord(raw.body);
  if (typeof body.content === "string") return descriptionToText(body.content, asString(body.contentType) || "text");
  return descriptionToText(asString(raw.bodyPreview), "text");
}

/** One raw event as a cached `CalendarEvent`, or undefined for cancelled or unreadable events. */
export function normalizeOutlookEvent(raw: JsonRecord, calendarId: string): CachedEvent | undefined {
  const providerId = asString(raw.id);
  if (!GRAPH_ID.test(providerId) || raw.isCancelled === true) return undefined;
  const time = times(raw);
  if (!time) return undefined;
  const people = attendees(raw);
  const master = asString(raw.seriesMasterId);
  const type = asString(raw.type);
  const recurrenceText = master || type === "occurrence" || type === "exception"
    ? GENERIC_RECURRENCE_TEXT
    : describeGraphRecurrence(raw.recurrence);
  const meeting = onlineMeeting(raw);
  const event: CalendarEvent = {
    id: composeEventId(calendarId, providerId),
    calendarId,
    title: asString(raw.subject),
    start: time.start,
    end: time.end,
    allDay: time.allDay,
    timeZone: time.allDay ? "UTC" : ianaZone(raw.originalStartTimeZone ?? asRecord(raw.start).timeZone),
    location: asString(asRecord(raw.location).displayName),
    descriptionText: description(raw),
    attendees: people.list,
    myResponse: myResponse(raw),
  };
  if (recurrenceText) event.recurrenceText = recurrenceText;
  if (master && GRAPH_ID.test(master)) event.seriesId = composeEventId(calendarId, master);
  if (meeting) event.onlineMeeting = meeting;
  return { event, resources: people.resources };
}
