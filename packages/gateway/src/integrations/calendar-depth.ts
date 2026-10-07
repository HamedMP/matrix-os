import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";
import { listValidation } from "./list-validation.js";

const calendarId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.@:+#-]+$/).refine((value) => value !== "." && value !== "..");
const calendar = calendarId.optional();
const root = (p: Record<string, unknown>) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId.parse(p.calendarId ?? "primary"))}/events`;
const time = z.iso.datetime({ offset: true });
const eventId = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
export const CALENDAR_DEPTH_ACTIONS: Record<string, ServiceAction> = {
  list_calendars: {
    description: "Discover authorized calendars; choose a returned calendarId for event actions", risk: "read",
    params: { pageToken: { type: "string" }, maxResults: { type: "number" } },
    paramsSchema: z.strictObject({ pageToken: z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(), maxResults: z.number().int().min(1).max(250).optional() }),
    directApi: { method: "GET", url: "https://www.googleapis.com/calendar/v3/users/me/calendarList", mapParams: (p) => ({ maxResults: String(p.maxResults ?? 100), ...(p.pageToken ? { pageToken: String(p.pageToken) } : {}) }) },
  },
  list_events: {
    description: "Read one page of events from a selected calendar (primary by default)", risk: "read",
    params: { calendarId: { type: "string" }, pageToken: { type: "string" }, timeMin: { type: "string" }, timeMax: { type: "string" }, maxResults: { type: "number" } },
    paramsSchema: listValidation.calendar.extend({ calendarId: calendar }),
    directApi: { method: "GET", url: root, mapParams: (p) => ({ singleEvents: "true", orderBy: "startTime", maxResults: String(p.maxResults ?? 50), ...(p.pageToken ? { pageToken: String(p.pageToken) } : {}), ...(p.timeMin ? { timeMin: String(p.timeMin) } : {}), ...(p.timeMax ? { timeMax: String(p.timeMax) } : {}) }) },
  },
  create_event: {
    description: "Create an event in the explicitly selected calendar after approval", risk: "write",
    params: { calendarId: { type: "string" }, summary: { type: "string", required: true }, start: { type: "string", required: true }, end: { type: "string", required: true }, description: { type: "string" }, location: { type: "string" } },
    paramsSchema: z.strictObject({ calendarId: calendar, summary: z.string().min(1).max(1024), start: time, end: time, description: z.string().max(8192).optional(), location: z.string().max(1024).optional() }).refine((p) => Date.parse(p.start) < Date.parse(p.end)),
    directApi: { method: "POST", url: root, mapBody: (p) => ({ summary: p.summary, start: { dateTime: p.start }, end: { dateTime: p.end }, ...(p.description !== undefined ? { description: p.description } : {}), ...(p.location !== undefined ? { location: p.location } : {}) }) },
  },
  update_event: {
    description: "Update explicit fields of one selected calendar event after approval", risk: "write",
    params: { calendarId: { type: "string" }, eventId: { type: "string", required: true }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" } },
    paramsSchema: z.strictObject({ calendarId: calendar, eventId, summary: z.string().min(1).max(1024).optional(), start: time.optional(), end: time.optional() }).refine((p) => p.summary !== undefined || p.start !== undefined || p.end !== undefined).refine((p) => !(p.start && p.end) || Date.parse(p.start!) < Date.parse(p.end!)),
    directApi: { method: "PATCH", url: (p) => `${root(p)}/${eventId.parse(p.eventId)}`, mapBody: (p) => ({ ...(p.summary !== undefined ? { summary: p.summary } : {}), ...(p.start !== undefined ? { start: { dateTime: p.start } } : {}), ...(p.end !== undefined ? { end: { dateTime: p.end } } : {}) }) },
  },
};
