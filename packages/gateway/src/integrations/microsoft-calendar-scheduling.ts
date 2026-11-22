import { z } from "zod/v4";
import { GRAPH_ID, optional, segment, type CatalogField } from "./catalog-fields.js";
import { email, nonblank, utcDateTime } from "./bounded-writes.js";
import type { DirectApi, ServiceAction } from "./types.js";

// Microsoft Graph v1.0 calendar scheduling (spec 2710, integration-actions.md section 7):
// https://learn.microsoft.com/graph/api/user-post-events
// https://learn.microsoft.com/graph/api/event-update
// https://learn.microsoft.com/graph/api/event-delete
// https://learn.microsoft.com/graph/api/event-accept (decline, tentativelyaccept)
// https://learn.microsoft.com/graph/api/calendar-getschedule
const graph = "https://graph.microsoft.com/v1.0/me";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_DAYS = 366;
const MAX_SCHEDULE_DAYS = 62;
/** Leaves room for the request envelope inside the 64 KiB app request limit. */
const MAX_REQUEST_BYTES = 60_000;

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ZONE = /^[A-Za-z0-9_+/-]{1,64}$/;
const NO_CONTROL = /^[^\x00-\x1f\x7f]+$/;

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function isRealWallTime(value: string): boolean {
  const m = WALL_TIME.exec(value);
  return m !== null && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))
    && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60;
}
function isRealCalendarDate(value: string): boolean {
  const m = DATE.exec(value);
  return m !== null && isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}
/** Wall times in one time zone compare as if they were UTC: only the difference matters. */
const wallMs = (value: unknown) => Date.parse(`${String(value)}Z`);
const withinBytes = (params: unknown) => Buffer.byteLength(JSON.stringify(params), "utf8") <= MAX_REQUEST_BYTES;

const wallTimeSchema = z.string().regex(WALL_TIME).refine(isRealWallTime);
const dateSchema = z.string().regex(DATE).refine(isRealCalendarDate);
const field = (schema: z.ZodType, param: CatalogField["param"]): CatalogField => ({ schema, param });

const wallTime = field(wallTimeSchema, { type: "string", required: true, pattern: WALL_TIME.source,
  description: "Local wall-clock time YYYY-MM-DDTHH:mm:ss without an offset, read in timeZone" });
const timeZone = field(z.string().regex(TIME_ZONE), { type: "string", required: true, minLength: 1, maxLength: 64,
  pattern: TIME_ZONE.source, description: "IANA time zone name, for example Europe/Stockholm" });
const attendee = z.strictObject({
  address: z.email().max(254),
  name: z.string().min(1).max(128).regex(NO_CONTROL).optional(),
  type: z.enum(["required", "optional"]).optional(),
});
const attendees = field(z.array(attendee).max(100), { type: "array",
  description: "Up to 100 attendees { address, name?, type?: required | optional }; Outlook emails each one" });

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const pattern = z.strictObject({
  type: z.enum(["daily", "weekly", "absoluteMonthly", "absoluteYearly"]),
  interval: z.number().int().min(1).max(99),
  daysOfWeek: z.array(z.enum(DAYS)).min(1).max(7).refine(days => new Set(days).size === days.length).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  month: z.number().int().min(1).max(12).optional(),
}).refine(p => {
  const has = { days: p.daysOfWeek !== undefined, day: p.dayOfMonth !== undefined, month: p.month !== undefined };
  switch (p.type) {
    case "daily": return !has.days && !has.day && !has.month;
    case "weekly": return has.days && !has.day && !has.month;
    case "absoluteMonthly": return !has.days && has.day && !has.month;
    case "absoluteYearly": return !has.days && has.day && has.month;
  }
});
const range = z.strictObject({
  type: z.enum(["noEnd", "endDate", "numbered"]),
  startDate: dateSchema,
  endDate: dateSchema.optional(),
  numberOfOccurrences: z.number().int().min(1).max(730).optional(),
}).refine(r => {
  switch (r.type) {
    case "noEnd": return r.endDate === undefined && r.numberOfOccurrences === undefined;
    case "endDate": return r.endDate !== undefined && r.numberOfOccurrences === undefined && r.endDate >= r.startDate;
    case "numbered": return r.endDate === undefined && r.numberOfOccurrences !== undefined;
  }
});
const recurrenceSchema = z.strictObject({ pattern, range });
const recurrenceParam = { type: "object", description:
  "{ pattern: { type: daily | weekly | absoluteMonthly | absoluteYearly, interval, daysOfWeek?, dayOfMonth?, month? }, range: { type: noEnd | endDate | numbered, startDate, endDate?, numberOfOccurrences? } }" } as const;

const eventFields = {
  subject: nonblank(255),
  startDateTime: wallTime,
  endDateTime: wallTime,
  timeZone,
  isAllDay: optional(field(z.boolean(), { type: "boolean", required: true })),
  attendees: optional(attendees),
  body: optional(field(z.string().max(8192), { type: "string", required: true, maxLength: 8192, description: "Plain-text event description" })),
  location: optional(field(z.string().max(255), { type: "string", required: true, maxLength: 255 })),
  isOnlineMeeting: optional(field(z.boolean(), { type: "boolean", required: true,
    description: "Add an online meeting link from the calendar's default provider" })),
  recurrence: optional(field(recurrenceSchema, { ...recurrenceParam, required: true })),
  reminderMinutesBeforeStart: optional(field(z.number().int().min(0).max(40320), { type: "number", required: true, minimum: 0, maximum: 40320 })),
};
const createFields = { calendarId: GRAPH_ID, ...eventFields };
const updateFields: Record<string, CatalogField> = {
  eventId: GRAPH_ID,
  ...Object.fromEntries(Object.entries(eventFields).map(([name, f]) => [name, f.param.required ? optional(f) : f])),
  recurrence: field(recurrenceSchema.nullable().optional(), { ...recurrenceParam,
    description: `${recurrenceParam.description}; null ends the series` }),
};

type Params = Record<string, unknown>;
const TIME_KEYS = ["startDateTime", "endDateTime", "timeZone"] as const;
function validTimes(p: Params): boolean {
  const duration = wallMs(p.endDateTime) - wallMs(p.startDateTime);
  if (!(duration > 0 && duration <= MAX_EVENT_DAYS * DAY_MS)) return false;
  return p.isAllDay !== true || (String(p.startDateTime).endsWith("T00:00:00") && String(p.endDateTime).endsWith("T00:00:00"));
}
function validUpdate(p: Params): boolean {
  const given = TIME_KEYS.filter(key => p[key] !== undefined).length;
  if (given !== 0 && given !== TIME_KEYS.length) return false;
  if (p.isAllDay === true && given === 0) return false;
  if (given !== 0 && !validTimes(p)) return false;
  return Object.keys(p).some(key => key !== "eventId" && p[key] !== undefined);
}

const fieldsSchema = (fields: Record<string, CatalogField>) =>
  z.strictObject(Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.schema])));
const createSchema = fieldsSchema(createFields).refine(validTimes).refine(withinBytes);
const updateSchema = fieldsSchema(updateFields).refine(validUpdate).refine(withinBytes);

const present = (p: Params, key: string) => p[key] !== undefined;
function eventBody(p: Params): Record<string, unknown> {
  const people = p.attendees as z.infer<typeof attendee>[] | undefined;
  const zone = p.timeZone;
  return {
    ...(present(p, "subject") ? { subject: p.subject } : {}),
    ...(present(p, "isAllDay") ? { isAllDay: p.isAllDay } : {}),
    ...(present(p, "startDateTime") ? {
      start: { dateTime: p.startDateTime, timeZone: zone },
      end: { dateTime: p.endDateTime, timeZone: zone },
    } : {}),
    ...(people ? { attendees: people.map(person => ({
      emailAddress: { address: person.address, ...(person.name !== undefined ? { name: person.name } : {}) },
      type: person.type ?? "required",
    })) } : {}),
    ...(present(p, "body") ? { body: { contentType: "Text", content: p.body } } : {}),
    ...(present(p, "location") ? { location: { displayName: p.location } } : {}),
    ...(present(p, "isOnlineMeeting") ? { isOnlineMeeting: p.isOnlineMeeting } : {}),
    ...(present(p, "recurrence") ? { recurrence: p.recurrence } : {}),
    ...(present(p, "reminderMinutesBeforeStart") ? { isReminderOn: true, reminderMinutesBeforeStart: p.reminderMinutesBeforeStart } : {}),
  };
}

const RESPONSE_PATHS = { accepted: "accept", declined: "decline", tentative: "tentativelyAccept" } as const;
const responseSchema = z.enum(["accepted", "declined", "tentative"]);
const respondFields = {
  eventId: GRAPH_ID,
  response: field(responseSchema, { type: "string", required: true, description: "accepted, declined or tentative" }),
  comment: optional(field(z.string().max(1024), { type: "string", required: true, maxLength: 1024 })),
  sendResponse: field(z.boolean(), { type: "boolean", required: true, description: "Whether the organiser is emailed the answer" }),
};

const scheduleFields = {
  schedules: field(z.array(email.schema).min(1).max(20)
    .refine(list => new Set(list.map(address => String(address).toLowerCase())).size === list.length),
  { type: "array", required: true, description: "1 to 20 unique email addresses" }),
  startDateTime: utcDateTime,
  endDateTime: utcDateTime,
  intervalMinutes: optional(field(z.number().int().min(5).max(1440), { type: "number", required: true, minimum: 5, maximum: 1440 })),
};
const scheduleSchema = fieldsSchema(scheduleFields).refine(p => {
  const duration = Date.parse(String(p.endDateTime)) - Date.parse(String(p.startDateTime));
  return duration > 0 && duration <= MAX_SCHEDULE_DAYS * DAY_MS;
});
const utcWall = (value: unknown) => String(value).slice(0, -1);

function scheduling(description: string, risk: "read" | "write", fields: Record<string, CatalogField>, directApi: DirectApi, paramsSchema: z.ZodType): ServiceAction {
  return { description, risk, directApi, paramsSchema,
    params: Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.param])) };
}

/** Writes for `microsoft_outlook_calendar`; every one needs owner approval. */
export const MICROSOFT_CALENDAR_SCHEDULING_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = {
  microsoft_outlook_calendar: {
    create_event_with_attendees: scheduling(
      "Create an event in one selected calendar after approval; Outlook emails an invitation to every attendee",
      "write", createFields, {
        method: "POST",
        url: p => `${graph}/calendars/${segment(p, "calendarId", GRAPH_ID)}/events`,
        mapBody: eventBody,
      }, createSchema),
    update_event: scheduling(
      "Change explicit fields of one event after approval; Outlook emails an update to the attendees",
      "write", updateFields, {
        method: "PATCH",
        url: p => `${graph}/events/${segment(p, "eventId", GRAPH_ID)}`,
        mapBody: eventBody,
      }, updateSchema),
    delete_event: scheduling(
      "Delete one event after approval; when you organise it, Outlook emails a cancellation to the attendees",
      "write", { eventId: GRAPH_ID }, {
        method: "DELETE",
        url: p => `${graph}/events/${segment(p, "eventId", GRAPH_ID)}`,
      }, fieldsSchema({ eventId: GRAPH_ID })),
    respond_event: scheduling(
      "Accept, decline or tentatively accept one invitation after approval; sendResponse emails the organiser",
      "write", respondFields, {
        method: "POST",
        url: p => `${graph}/events/${segment(p, "eventId", GRAPH_ID)}/${RESPONSE_PATHS[responseSchema.parse(p.response)]}`,
        mapBody: p => ({ ...(present(p, "comment") ? { comment: p.comment } : {}), sendResponse: p.sendResponse }),
      }, fieldsSchema(respondFields)),
  },
};

/** Reads for `microsoft_outlook_calendar`. */
export const MICROSOFT_CALENDAR_SCHEDULING_READ_ACTIONS: Record<string, ServiceAction> = {
  get_schedule: scheduling(
    "Read free and busy times for up to 20 people over at most 62 days, in UTC",
    "read", scheduleFields, {
      method: "POST",
      url: `${graph}/calendar/getSchedule`,
      staticHeaders: { Prefer: 'outlook.timezone="UTC"' },
      mapBody: p => ({
        schedules: p.schedules,
        startTime: { dateTime: utcWall(p.startDateTime), timeZone: "UTC" },
        endTime: { dateTime: utcWall(p.endDateTime), timeZone: "UTC" },
        availabilityViewInterval: p.intervalMinutes ?? 30,
      }),
    }, scheduleSchema),
};
