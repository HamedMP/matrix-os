/**
 * Google Calendar API v3 JSON to the provider-neutral calendar contract.
 * Everything read here is untrusted text from other people.
 */
import { composeEventId } from "../types/calendar.js";
import type {
  AttendeeResponse,
  CalendarAccount,
  CalendarAttendee,
  CalendarEvent,
  CalendarInfo,
  OnlineMeeting,
} from "../types/calendar.js";
import { DEFAULT_CALENDAR_COLOR, allDayRange, hexColor, instantWithOffset, isHttpsUrl } from "./common.js";
import type { CachedEvent } from "./common.js";
import { descriptionToText } from "./description.js";
import { GENERIC_RECURRENCE_TEXT, describeRRuleLines } from "./recurrence.js";
import { asArray, asRecord, asString } from "./service.js";
import type { JsonRecord } from "./service.js";
import { ianaZone } from "./zones.js";

/** Google's calendar colour palette, by `colorId`. */
const GOOGLE_CALENDAR_COLORS: Readonly<Record<string, string>> = {
  1: "#ac725e", 2: "#d06b64", 3: "#f83a22", 4: "#fa573c", 5: "#ff7537", 6: "#ffad46", 7: "#42d692", 8: "#16a765",
  9: "#7bd148", 10: "#b3dc6c", 11: "#fbe983", 12: "#fad165", 13: "#92e1c0", 14: "#9fe1e7", 15: "#9fc6e7", 16: "#4986e7",
  17: "#9a9cff", 18: "#b99aff", 19: "#c2c2c2", 20: "#cabdbf", 21: "#cca6ac", 22: "#f691b2", 23: "#cd74e6", 24: "#a47ae2",
};

const RESPONSES: readonly AttendeeResponse[] = ["accepted", "declined", "tentative", "needsAction"];
const WRITABLE_ROLES = new Set(["owner", "writer"]);

export function normalizeGoogleCalendar(raw: JsonRecord, account: CalendarAccount): CalendarInfo | undefined {
  const id = asString(raw.id);
  if (!id || id.includes("/")) return undefined;
  return {
    id,
    accountId: account.id,
    name: asString(raw.summaryOverride) || asString(raw.summary) || id,
    color: hexColor(raw.backgroundColor) ?? GOOGLE_CALENDAR_COLORS[asString(raw.colorId)] ?? DEFAULT_CALENDAR_COLOR,
    primary: raw.primary === true,
    writable: WRITABLE_ROLES.has(asString(raw.accessRole)),
    visible: raw.selected === true && raw.hidden !== true,
  };
}

function response(value: unknown): AttendeeResponse {
  return RESPONSES.includes(value as AttendeeResponse) ? value as AttendeeResponse : "needsAction";
}

function onlineMeeting(raw: JsonRecord): OnlineMeeting | undefined {
  const conference = asRecord(raw.conferenceData);
  const solution = asString(asRecord(asRecord(conference.conferenceSolution).key).type);
  const hangout = asString(raw.hangoutLink);
  if (hangout && isHttpsUrl(hangout)) return { provider: "google_meet", joinUrl: hangout };
  for (const entry of asArray(conference.entryPoints)) {
    const point = asRecord(entry);
    const uri = asString(point.uri);
    if (asString(point.entryPointType) === "video" && uri && isHttpsUrl(uri)) {
      return { provider: solution === "hangoutsMeet" ? "google_meet" : "other", joinUrl: uri };
    }
  }
  return undefined;
}

interface GoogleTime {
  start: string;
  end: string;
  allDay: boolean;
}

function times(raw: JsonRecord): GoogleTime | undefined {
  const start = asRecord(raw.start);
  const end = asRecord(raw.end);
  const startDate = asString(start.date);
  const endDate = asString(end.date);
  if (startDate && endDate) {
    try {
      return { ...allDayRange(startDate, endDate), allDay: true };
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      return undefined;
    }
  }
  const startInstant = instantWithOffset(start.dateTime);
  const endInstant = instantWithOffset(end.dateTime);
  return startInstant && endInstant ? { start: startInstant, end: endInstant, allDay: false } : undefined;
}

/**
 * One raw event as a cached `CalendarEvent`, or undefined for cancelled or
 * unreadable events. `calendarZone` is the zone of the list reply, used when
 * the event names none.
 */
export function normalizeGoogleEvent(raw: JsonRecord, calendarId: string, account: CalendarAccount, calendarZone?: string): CachedEvent | undefined {
  const providerId = asString(raw.id);
  if (!providerId || providerId.includes("/") || raw.status === "cancelled") return undefined;
  const time = times(raw);
  if (!time) return undefined;

  const attendees: CalendarAttendee[] = [];
  const resources: CachedEvent["resources"] = [];
  let myResponse: AttendeeResponse | null = null;
  for (const entry of asArray(raw.attendees)) {
    const person = asRecord(entry);
    const address = asString(person.email).trim().toLowerCase();
    if (!address) continue;
    const name = asString(person.displayName);
    if (person.resource === true) {
      resources.push({ address, name, response: response(person.responseStatus) });
      continue;
    }
    const attendee: CalendarAttendee = { address, name, response: response(person.responseStatus), organizer: person.organizer === true };
    if (person.optional === true) attendee.optional = true;
    attendees.push(attendee);
    const isSelf = person.self === true || address === account.address;
    if (isSelf && !attendee.organizer) myResponse = attendee.response;
  }

  const zoneName = asString(asRecord(raw.start).timeZone) || calendarZone;
  const recurring = asString(raw.recurringEventId);
  const recurrenceText = recurring ? GENERIC_RECURRENCE_TEXT : describeRRuleLines(raw.recurrence);
  const meeting = onlineMeeting(raw);
  const event: CalendarEvent = {
    id: composeEventId(calendarId, providerId),
    calendarId,
    title: asString(raw.summary),
    start: time.start,
    end: time.end,
    allDay: time.allDay,
    timeZone: time.allDay ? "UTC" : ianaZone(zoneName),
    location: asString(raw.location),
    descriptionText: descriptionToText(asString(raw.description)),
    attendees,
    myResponse,
  };
  if (recurrenceText) event.recurrenceText = recurrenceText;
  if (recurring && !recurring.includes("/")) event.seriesId = composeEventId(calendarId, recurring);
  if (meeting) event.onlineMeeting = meeting;
  return { event, resources };
}
