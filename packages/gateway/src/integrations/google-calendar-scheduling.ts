import { z } from "zod/v4";
import type { CatalogField } from "./catalog-fields.js";
import type { DirectApi, ServiceAction } from "./types.js";

// Google Calendar API v3 scheduling (specs/2710-office-mail-suite/spec.md):
// https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
// https://developers.google.com/workspace/calendar/api/v3/reference/events/patch
// https://developers.google.com/workspace/calendar/api/v3/reference/events/delete
// https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
const api = "https://www.googleapis.com/calendar/v3";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FREE_BUSY_DAYS = 62;
/** Leaves room for the request envelope inside the 64 KiB app request limit. */
const MAX_REQUEST_BYTES = 60_000;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ZONE = /^[A-Za-z0-9_+/-]{1,64}$/;
const NO_CONTROL = /^[^\x00-\x1f\x7f]+$/;
const RRULE = /^RRULE:[A-Z0-9=;,]{1,480}$/;
const CONFERENCE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

function isRealDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
const withinBytes = (params: unknown) => Buffer.byteLength(JSON.stringify(params), "utf8") <= MAX_REQUEST_BYTES;

// Same calendar and event id rules as calendar-depth.ts, which owns the existing reads.
const calendarIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.@:+#-]+$/).refine(value => value !== "." && value !== "..");
const eventIdSchema = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
const sendUpdatesSchema = z.enum(["all", "none"]);
const offsetTime = z.iso.datetime({ offset: true }).max(40);
const dateSchema = z.string().regex(DATE).refine(isRealDate);

const field = (schema: z.ZodType, param: CatalogField["param"]): CatalogField => ({ schema, param });
const opt = (schema: z.ZodType, param: CatalogField["param"]): CatalogField => field(schema.optional(), { ...param, required: false });

const calendarId = opt(calendarIdSchema, { type: "string", maxLength: 256, description: "Calendar id from list_calendars; primary by default" });
const eventId = field(eventIdSchema, { type: "string", required: true, minLength: 1, maxLength: 1024 });
const sendUpdates = field(sendUpdatesSchema, { type: "string", required: true,
  description: "all emails attendees about this change; none sends nothing. Always an explicit choice" });

const attendeeBase = {
  email: z.email().max(254),
  displayName: z.string().min(1).max(128).regex(NO_CONTROL).optional(),
  optional: z.boolean().optional(),
};
const createAttendee = z.strictObject(attendeeBase);
const updateAttendee = z.strictObject({ ...attendeeBase,
  responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional() });
const reminder = z.strictObject({ method: z.enum(["popup", "email"]), minutes: z.number().int().min(0).max(40320) });

function eventFields(attendee: z.ZodType, attendeeHint: string): Record<string, CatalogField> {
  return {
    calendarId,
    summary: field(z.string().min(1).max(1024).refine(value => value.trim().length > 0), { type: "string", required: true, minLength: 1, maxLength: 1024 }),
    start: opt(offsetTime, { type: "string", maxLength: 40, description: "Timed start: ISO 8601 instant with Z or an offset; give with end" }),
    end: opt(offsetTime, { type: "string", maxLength: 40, description: "Timed end, after start" }),
    startDate: opt(dateSchema, { type: "string", pattern: DATE.source, description: "All-day start YYYY-MM-DD; give with endDate" }),
    endDate: opt(dateSchema, { type: "string", pattern: DATE.source, description: "All-day end YYYY-MM-DD, exclusive" }),
    timeZone: opt(z.string().regex(TIME_ZONE), { type: "string", maxLength: 64, pattern: TIME_ZONE.source,
      description: "IANA time zone for a timed event; required with recurrence" }),
    description: opt(z.string().max(8192), { type: "string", maxLength: 8192 }),
    location: opt(z.string().max(1024), { type: "string", maxLength: 1024 }),
    attendees: opt(z.array(attendee).max(100), { type: "array", description: attendeeHint }),
    conferenceRequestId: opt(z.string().regex(CONFERENCE_REQUEST_ID), { type: "string", minLength: 8, maxLength: 64,
      pattern: CONFERENCE_REQUEST_ID.source, description: "Caller-generated id that adds one Google Meet link; reuse it on retry" }),
    recurrence: opt(z.array(z.string().regex(RRULE)).min(1).max(4), { type: "array", description: "1 to 4 RRULE: lines" }),
    reminders: opt(z.array(reminder).max(5), { type: "array", description: "Up to 5 { method: popup | email, minutes }" }),
    sendUpdates,
  };
}
const createFields = eventFields(createAttendee, "Up to 100 { email, displayName?, optional? }; sendUpdates=all invites them");
const updateFields: Record<string, CatalogField> = {
  ...eventFields(updateAttendee, "Replaces the stored list: up to 100 { email, displayName?, optional?, responseStatus? }"),
  eventId,
  summary: opt(z.string().min(1).max(1024).refine(value => value.trim().length > 0), { type: "string", minLength: 1, maxLength: 1024 }),
};

type Params = Record<string, unknown>;
const present = (p: Params, key: string) => p[key] !== undefined;
const pairState = (p: Params, a: string, b: string) => present(p, a) && present(p, b) ? "both" : present(p, a) || present(p, b) ? "half" : "none";

/** Checks the time pairs; `required` demands exactly one pair (create). */
function validTimes(p: Params, required: boolean): boolean {
  const timed = pairState(p, "start", "end");
  const allDay = pairState(p, "startDate", "endDate");
  if (timed === "half" || allDay === "half" || (timed === "both" && allDay === "both")) return false;
  if (required && timed === "none" && allDay === "none") return false;
  if (timed === "both" && !(Date.parse(String(p.start)) < Date.parse(String(p.end)))) return false;
  if (allDay === "both" && !(String(p.startDate) < String(p.endDate))) return false;
  if (present(p, "timeZone") && timed !== "both") return false;
  if (timed === "both" && present(p, "recurrence") && !present(p, "timeZone")) return false;
  return true;
}
const OWN_KEYS = new Set(["calendarId", "eventId", "sendUpdates"]);
const changesSomething = (p: Params) => Object.keys(p).some(key => !OWN_KEYS.has(key) && p[key] !== undefined);

const fieldsSchema = (fields: Record<string, CatalogField>) =>
  z.strictObject(Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.schema])));
const createSchema = fieldsSchema(createFields).refine(p => validTimes(p, true)).refine(withinBytes);
const updateSchema = fieldsSchema(updateFields).refine(changesSomething).refine(p => validTimes(p, false)).refine(withinBytes);

const events = (p: Params) => `${api}/calendars/${encodeURIComponent(calendarIdSchema.parse(p.calendarId ?? "primary"))}/events`;
const eventUrl = (p: Params) => `${events(p)}/${encodeURIComponent(eventIdSchema.parse(p.eventId))}`;
const notify = (p: Params) => `sendUpdates=${sendUpdatesSchema.parse(p.sendUpdates)}`;

type Attendee = z.infer<typeof updateAttendee>;
function eventBody(p: Params): Record<string, unknown> {
  const zone = present(p, "timeZone") ? { timeZone: p.timeZone } : {};
  const people = p.attendees as Attendee[] | undefined;
  const reminders = p.reminders as z.infer<typeof reminder>[] | undefined;
  return {
    ...(present(p, "summary") ? { summary: p.summary } : {}),
    ...(present(p, "start") ? { start: { dateTime: p.start, ...zone }, end: { dateTime: p.end, ...zone } } : {}),
    ...(present(p, "startDate") ? { start: { date: p.startDate }, end: { date: p.endDate } } : {}),
    ...(present(p, "description") ? { description: p.description } : {}),
    ...(present(p, "location") ? { location: p.location } : {}),
    ...(people ? { attendees: people.map(person => ({ email: person.email,
      ...(person.displayName !== undefined ? { displayName: person.displayName } : {}),
      ...(person.optional !== undefined ? { optional: person.optional } : {}),
      ...(person.responseStatus !== undefined ? { responseStatus: person.responseStatus } : {}) })) } : {}),
    ...(present(p, "conferenceRequestId") ? { conferenceData: { createRequest: {
      requestId: p.conferenceRequestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    ...(present(p, "recurrence") ? { recurrence: p.recurrence } : {}),
    ...(reminders ? { reminders: { useDefault: false, overrides: reminders.map(r => ({ method: r.method, minutes: r.minutes })) } } : {}),
  };
}

const respondFields = {
  calendarId,
  eventId,
  selfEmail: field(z.email().max(254), { type: "string", required: true, minLength: 3, maxLength: 254,
    description: "The connected account's own address as it appears in the attendee list" }),
  response: field(z.enum(["accepted", "declined", "tentative"]), { type: "string", required: true }),
  comment: opt(z.string().max(1024), { type: "string", maxLength: 1024 }),
  sendUpdates,
};
const deleteFields = { calendarId, eventId, sendUpdates };
const freeBusyItem = z.union([calendarIdSchema, z.email().max(254)]);
const freeBusyFields = {
  items: field(z.array(freeBusyItem).min(1).max(20).refine(list => new Set(list).size === list.length),
    { type: "array", required: true, description: "1 to 20 unique calendar ids or email addresses" }),
  timeMin: field(offsetTime, { type: "string", required: true, maxLength: 40 }),
  timeMax: field(offsetTime, { type: "string", required: true, maxLength: 40 }),
};
const freeBusySchema = fieldsSchema(freeBusyFields).refine(p => {
  const duration = Date.parse(String(p.timeMax)) - Date.parse(String(p.timeMin));
  return duration > 0 && duration <= MAX_FREE_BUSY_DAYS * DAY_MS;
});

function scheduling(description: string, risk: "read" | "write", fields: Record<string, CatalogField>, directApi: DirectApi, paramsSchema: z.ZodType): ServiceAction {
  return { description, risk, directApi, paramsSchema,
    params: Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.param])) };
}

/** Writes for `google_calendar`; every one needs owner approval. */
export const GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = {
  google_calendar: {
    create_event_with_attendees: scheduling(
      "Create an event with attendees, an optional Meet link and recurrence after approval; sendUpdates=all emails invitations",
      "write", createFields, {
        method: "POST",
        url: p => `${events(p)}?${notify(p)}&conferenceDataVersion=1`,
        mapBody: eventBody,
      }, createSchema),
    update_event_details: scheduling(
      "Change explicit fields of one event after approval; attendees replaces the list; sendUpdates=all emails attendees",
      "write", updateFields, {
        method: "PATCH",
        url: p => `${eventUrl(p)}?${notify(p)}&conferenceDataVersion=1`,
        mapBody: eventBody,
      }, updateSchema),
    delete_event: scheduling(
      "Move one event to the calendar's trash after approval; sendUpdates=all emails a cancellation",
      "write", deleteFields, {
        method: "DELETE",
        url: eventUrl,
        mapParams: p => ({ sendUpdates: sendUpdatesSchema.parse(p.sendUpdates) }),
      }, fieldsSchema(deleteFields)),
    respond_event: scheduling(
      "Answer one invitation as accepted, declined or tentative after approval; changes only your own response",
      "write", respondFields, {
        method: "PATCH",
        url: p => `${eventUrl(p)}?${notify(p)}`,
        mapBody: p => ({ attendeesOmitted: true, attendees: [{ email: p.selfEmail, responseStatus: p.response,
          ...(present(p, "comment") ? { comment: p.comment } : {}) }] }),
      }, fieldsSchema(respondFields)),
  },
};

/** Reads for `google_calendar`. */
export const GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS: Record<string, ServiceAction> = {
  free_busy: scheduling(
    "Read busy times for up to 20 calendars or people over at most 62 days",
    "read", freeBusyFields, {
      method: "POST",
      url: `${api}/freeBusy`,
      mapBody: p => ({ timeMin: p.timeMin, timeMax: p.timeMax, items: (p.items as string[]).map(id => ({ id })) }),
    }, freeBusySchema),
};
