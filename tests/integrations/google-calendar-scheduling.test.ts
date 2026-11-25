import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS,
  GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS,
} from "../../packages/gateway/src/integrations/google-calendar-scheduling.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction, ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const SERVICE = "google_calendar";
const api = "https://www.googleapis.com/calendar/v3";
const writes = GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS[SERVICE]!;
const reads = GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS;
const all: Record<string, ServiceAction> = { ...writes, ...reads };

function fakeClient() {
  const proxyGet = vi.fn(async () => ({ ok: "get" }));
  const proxyPost = vi.fn(async () => ({ id: "posted" }));
  const proxyPatch = vi.fn(async () => ({ id: "patched" }));
  const proxyDelete = vi.fn(async () => ({}));
  const proxyPut = vi.fn(async () => ({ id: "put" }));
  return { proxyGet, proxyPost, proxyPatch, proxyDelete, proxyPut,
    client: { proxyGet, proxyPost, proxyPatch, proxyDelete, proxyPut } as unknown as PipedreamConnectClient };
}

async function run(actionId: string, params: Record<string, unknown>) {
  const fake = fakeClient();
  const result = await executeIntegrationAction({ pipedream: fake.client, externalUserId: "owner",
    connection: { pipedream_account_id: "account" }, def: { id: SERVICE, actions: all } as ServiceDefinition,
    actionDef: all[actionId]!, serviceId: SERVICE, actionId, params });
  return { fake, result };
}

const createParams = {
  calendarId: "team#ops@group.calendar.google.com",
  summary: "Planning",
  start: "2026-10-19T10:00:00+02:00",
  end: "2026-10-19T11:00:00+02:00",
  timeZone: "Europe/Stockholm",
  description: "Agenda",
  location: "Room 1",
  attendees: [{ email: "ada@example.com", displayName: "Ada", optional: true }, { email: "bob@example.com" }],
  conferenceRequestId: "draft-1234abcd",
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"],
  reminders: [{ method: "popup", minutes: 10 }, { method: "email", minutes: 1440 }],
  sendUpdates: "all",
};
const teamEvents = `${api}/calendars/team%23ops%40group.calendar.google.com/events`;

type Case = [string, Record<string, unknown>, "POST" | "PATCH" | "DELETE", string, Record<string, unknown>];
const cases: Case[] = [
  ["create_event_with_attendees", createParams, "POST", `${teamEvents}?sendUpdates=all&conferenceDataVersion=1`, { body: {
    summary: "Planning",
    start: { dateTime: "2026-10-19T10:00:00+02:00", timeZone: "Europe/Stockholm" },
    end: { dateTime: "2026-10-19T11:00:00+02:00", timeZone: "Europe/Stockholm" },
    description: "Agenda",
    location: "Room 1",
    attendees: [{ email: "ada@example.com", displayName: "Ada", optional: true }, { email: "bob@example.com" }],
    conferenceData: { createRequest: { requestId: "draft-1234abcd", conferenceSolutionKey: { type: "hangoutsMeet" } } },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }, { method: "email", minutes: 1440 }] },
  } }],
  ["create_event_with_attendees", { summary: "Holiday", startDate: "2026-12-24", endDate: "2026-12-26", sendUpdates: "none" },
    "POST", `${api}/calendars/primary/events?sendUpdates=none&conferenceDataVersion=1`, { body: {
      summary: "Holiday", start: { date: "2026-12-24" }, end: { date: "2026-12-26" },
    } }],
  ["create_event_with_attendees", { summary: "Call", start: "2026-10-19T08:00:00Z", end: "2026-10-19T08:30:00Z", sendUpdates: "none" },
    "POST", `${api}/calendars/primary/events?sendUpdates=none&conferenceDataVersion=1`, { body: {
      summary: "Call", start: { dateTime: "2026-10-19T08:00:00Z" }, end: { dateTime: "2026-10-19T08:30:00Z" },
    } }],
  ["update_event_details", { eventId: "abc123_20261019T080000Z", sendUpdates: "all",
    attendees: [{ email: "ada@example.com", responseStatus: "accepted" }, { email: "new@example.com" }], description: "" },
    "PATCH", `${api}/calendars/primary/events/abc123_20261019T080000Z?sendUpdates=all&conferenceDataVersion=1`, { body: {
      description: "",
      attendees: [{ email: "ada@example.com", responseStatus: "accepted" }, { email: "new@example.com" }],
    } }],
  ["update_event_details", { calendarId: "c@x.com", eventId: "evt", sendUpdates: "none", startDate: "2026-10-19", endDate: "2026-10-20", summary: "Off" },
    "PATCH", `${api}/calendars/c%40x.com/events/evt?sendUpdates=none&conferenceDataVersion=1`, { body: {
      summary: "Off", start: { date: "2026-10-19" }, end: { date: "2026-10-20" },
    } }],
  ["update_event_details", { eventId: "evt", sendUpdates: "none", conferenceRequestId: "retry-safe-1" },
    "PATCH", `${api}/calendars/primary/events/evt?sendUpdates=none&conferenceDataVersion=1`, { body: {
      conferenceData: { createRequest: { requestId: "retry-safe-1", conferenceSolutionKey: { type: "hangoutsMeet" } } },
    } }],
  ["delete_event", { eventId: "evt", sendUpdates: "all" }, "DELETE", `${api}/calendars/primary/events/evt`, { params: { sendUpdates: "all" } }],
  ["delete_event", { calendarId: "c@x.com", eventId: "evt", sendUpdates: "none" }, "DELETE", `${api}/calendars/c%40x.com/events/evt`, { params: { sendUpdates: "none" } }],
  ["respond_event", { eventId: "evt", selfEmail: "me@example.com", response: "tentative", comment: "Maybe late", sendUpdates: "all" },
    "PATCH", `${api}/calendars/primary/events/evt?sendUpdates=all`, { body: {
      attendeesOmitted: true, attendees: [{ email: "me@example.com", responseStatus: "tentative", comment: "Maybe late" }],
    } }],
  ["respond_event", { eventId: "evt", selfEmail: "me@example.com", response: "declined", sendUpdates: "none" },
    "PATCH", `${api}/calendars/primary/events/evt?sendUpdates=none`, { body: {
      attendeesOmitted: true, attendees: [{ email: "me@example.com", responseStatus: "declined" }],
    } }],
  ["free_busy", { items: ["primary", "ada@example.com", "team#ops@group.calendar.google.com"], timeMin: "2026-10-19T00:00:00+02:00", timeMax: "2026-10-26T00:00:00Z" },
    "POST", `${api}/freeBusy`, { body: {
      timeMin: "2026-10-19T00:00:00+02:00", timeMax: "2026-10-26T00:00:00Z",
      items: [{ id: "primary" }, { id: "ada@example.com" }, { id: "team#ops@group.calendar.google.com" }],
    } }],
];

describe("Google Calendar scheduling actions", () => {
  it("exports exactly the four writes and the one read with their risk", () => {
    expect(Object.keys(GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS)).toEqual([SERVICE]);
    expect(Object.keys(writes).sort()).toEqual(["create_event_with_attendees", "delete_event", "respond_event", "update_event_details"]);
    expect(Object.keys(reads)).toEqual(["free_busy"]);
    for (const action of Object.values(writes)) expect(action.risk).toBe("write");
    expect(reads.free_busy!.risk).toBe("read");
    for (const action of Object.values(all)) {
      expect(action.paramsSchema).toBeDefined();
      expect(action.directApi).toBeDefined();
      expect(action.componentKey).toBeUndefined();
    }
  });

  it.each(cases)("maps %s to the exact Calendar API request", async (actionId, params, method, url, payload) => {
    const action = all[actionId]!;
    expect(action.directApi!.method).toBe(method);
    expect(action.paramsSchema!.safeParse(params).success).toBe(true);
    for (const key of Object.keys(params)) expect(action.params[key], `${actionId}.${key} metadata`).toBeDefined();
    const { fake, result } = await run(actionId, params);
    expect(result.data).toBeDefined();
    const spy = method === "POST" ? fake.proxyPost : method === "PATCH" ? fake.proxyPatch : fake.proxyDelete;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toStrictEqual({ externalUserId: "owner", accountId: "account", url, ...payload });
    for (const other of [fake.proxyGet, fake.proxyPost, fake.proxyPatch, fake.proxyDelete, fake.proxyPut].filter(s => s !== spy)) {
      expect(other).not.toHaveBeenCalled();
    }
  });

  it.each(cases)("rejects unknown keys on %s before any provider call", async (actionId, params) => {
    await expect(run(actionId, { ...params, url: "https://evil.example" })).rejects.toThrow("Invalid action parameters");
    expect(all[actionId]!.paramsSchema!.safeParse({}).success).toBe(false);
  });

  const unsafeEventIds = ["", "../x", "?q", "\n", "a/b", "evt?x=1", "evt#frag", "evt%2F", "evt\u0000", "a".repeat(1025)];
  const eventBases: Record<string, Record<string, unknown>> = {
    update_event_details: { sendUpdates: "none", summary: "x" },
    delete_event: { sendUpdates: "none" },
    respond_event: { sendUpdates: "none", selfEmail: "me@example.com", response: "accepted" },
  };
  it.each(Object.keys(eventBases))("rejects path-injection ids for %s at the schema and in url()", (actionId) => {
    const action = all[actionId]!;
    const url = action.directApi!.url as (p: Record<string, unknown>) => string;
    for (const eventId of unsafeEventIds) {
      expect(action.paramsSchema!.safeParse({ ...eventBases[actionId], eventId }).success, JSON.stringify(eventId)).toBe(false);
      expect(() => url({ ...eventBases[actionId], eventId })).toThrow();
    }
    for (const calendarId of ["", "..", ".", "../x", "?q", "\n", "a/b", "c%2F", "x".repeat(257)]) {
      expect(action.paramsSchema!.safeParse({ ...eventBases[actionId], eventId: "evt", calendarId }).success, JSON.stringify(calendarId)).toBe(false);
      expect(() => url({ ...eventBases[actionId], eventId: "evt", calendarId })).toThrow();
    }
  });

  it("rejects path-injection calendar ids and query injection through sendUpdates on create", () => {
    const action = writes.create_event_with_attendees!;
    const url = action.directApi!.url as (p: Record<string, unknown>) => string;
    for (const calendarId of ["..", "../x", "?q", "\n", "a/b"]) {
      expect(action.paramsSchema!.safeParse({ ...createParams, calendarId }).success).toBe(false);
      expect(() => url({ ...createParams, calendarId })).toThrow();
    }
    expect(() => url({ ...createParams, sendUpdates: "all&conferenceDataVersion=0" })).toThrow();
    expect(() => (writes.respond_event!.directApi!.url as (p: Record<string, unknown>) => string)({ eventId: "evt", sendUpdates: "externalOnly" })).toThrow();
  });

  const timed = { summary: "x", start: "2026-10-19T10:00:00Z", end: "2026-10-19T11:00:00Z", sendUpdates: "none" };
  const invalidCreate: Record<string, unknown>[] = [
    { ...timed, sendUpdates: undefined },
    { ...timed, sendUpdates: "externalOnly" },
    { ...timed, summary: "" },
    { ...timed, summary: "x".repeat(1025) },
    { summary: "x", sendUpdates: "none" },
    { ...timed, start: undefined },
    { ...timed, start: "2026-10-19T10:00:00" },
    { ...timed, start: "2026-02-30T10:00:00Z" },
    { ...timed, end: "2026-10-19T10:00:00Z" },
    { ...timed, end: "2026-10-19T09:00:00Z" },
    { ...timed, end: "2026-10-19T11:30:00+02:00" },
    { ...timed, startDate: "2026-10-19", endDate: "2026-10-20" },
    { summary: "x", startDate: "2026-10-19", endDate: "2026-10-19", sendUpdates: "none" },
    { summary: "x", startDate: "2026-10-19", sendUpdates: "none" },
    { summary: "x", startDate: "2026-02-30", endDate: "2026-03-02", sendUpdates: "none" },
    { summary: "x", startDate: "2026-10-19T00:00:00Z", endDate: "2026-10-20", sendUpdates: "none" },
    { ...timed, timeZone: "Europe/Stockholm\n" },
    { ...timed, timeZone: "Central European Time" },
    { ...timed, recurrence: ["RRULE:FREQ=DAILY"] },
    { ...timed, timeZone: "UTC", recurrence: [] },
    { ...timed, timeZone: "UTC", recurrence: ["FREQ=DAILY"] },
    { ...timed, timeZone: "UTC", recurrence: ["RRULE:FREQ=DAILY\nEXDATE:x"] },
    { ...timed, timeZone: "UTC", recurrence: ["RRULE:freq=daily"] },
    { ...timed, timeZone: "UTC", recurrence: Array.from({ length: 5 }, () => "RRULE:FREQ=DAILY") },
    { ...timed, timeZone: "UTC", recurrence: [`RRULE:${"A".repeat(481)}`] },
    { ...timed, description: "x".repeat(8193) },
    { ...timed, location: "x".repeat(1025) },
    { ...timed, attendees: [{ email: "not-an-email" }] },
    { ...timed, attendees: [{ email: "a@example.com", displayName: "x".repeat(129) }] },
    { ...timed, attendees: [{ email: "a@example.com", displayName: "A\r\nB" }] },
    { ...timed, attendees: [{ email: "a@example.com", responseStatus: "accepted" }] },
    { ...timed, attendees: [{ email: "a@example.com", optional: "yes" }] },
    { ...timed, attendees: Array.from({ length: 101 }, (_, i) => ({ email: `p${i}@example.com` })) },
    { ...timed, conferenceRequestId: "short" },
    { ...timed, conferenceRequestId: "has space 123" },
    { ...timed, conferenceRequestId: "x".repeat(65) },
    { ...timed, reminders: [{ method: "sms", minutes: 10 }] },
    { ...timed, reminders: [{ method: "popup", minutes: 40321 }] },
    { ...timed, reminders: [{ method: "popup", minutes: -1 }] },
    { ...timed, reminders: Array.from({ length: 6 }, () => ({ method: "popup", minutes: 5 })) },
    { ...timed, calendarId: ".." },
    { ...timed, description: "€".repeat(8192), attendees: Array.from({ length: 100 }, (_, i) => ({ email: `p${i}@example.com`, displayName: "€".repeat(128) })) },
  ];
  it.each(invalidCreate.map((params, index) => [index, params] as const))("rejects invalid create_event_with_attendees parameters (#%i)", async (_index, raw) => {
    const params = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
    expect(writes.create_event_with_attendees!.paramsSchema!.safeParse(params).success).toBe(false);
    const probe = fakeClient();
    await expect(executeIntegrationAction({ pipedream: probe.client, externalUserId: "owner", connection: { pipedream_account_id: "account" },
      def: { id: SERVICE } as ServiceDefinition, actionDef: writes.create_event_with_attendees!, serviceId: SERVICE,
      actionId: "create_event_with_attendees", params })).rejects.toThrow("Invalid action parameters");
    expect(probe.proxyPost).not.toHaveBeenCalled();
  });

  it("accepts a timed recurring event with an explicit time zone and an all-day recurring event without one", () => {
    const schema = writes.create_event_with_attendees!.paramsSchema!;
    expect(schema.safeParse({ ...timed, timeZone: "UTC", recurrence: ["RRULE:FREQ=DAILY;COUNT=5"] }).success).toBe(true);
    expect(schema.safeParse({ summary: "x", startDate: "2026-10-19", endDate: "2026-10-20", sendUpdates: "none", recurrence: ["RRULE:FREQ=YEARLY"] }).success).toBe(true);
  });

  it.each([
    [{ eventId: "evt", sendUpdates: "none" }],
    [{ eventId: "evt", summary: "x" }],
    [{ eventId: "evt", sendUpdates: "none", start: "2026-10-19T10:00:00Z" }],
    [{ eventId: "evt", sendUpdates: "none", startDate: "2026-10-19" }],
    [{ eventId: "evt", sendUpdates: "none", start: "2026-10-19T10:00:00Z", end: "2026-10-19T09:00:00Z" }],
    [{ eventId: "evt", sendUpdates: "none", start: "2026-10-19T10:00:00Z", end: "2026-10-19T11:00:00Z", startDate: "2026-10-19", endDate: "2026-10-20" }],
    [{ eventId: "evt", sendUpdates: "none", timeZone: "UTC" }],
    [{ eventId: "evt", sendUpdates: "none", start: "2026-10-19T10:00:00Z", end: "2026-10-19T11:00:00Z", recurrence: ["RRULE:FREQ=DAILY"] }],
    [{ eventId: "evt", sendUpdates: "none", attendees: [{ email: "a@example.com", responseStatus: "maybe" }] }],
    [{ eventId: "evt", sendUpdates: "none", summary: "" }],
  ] satisfies [Record<string, unknown>][])("rejects invalid update_event_details parameters %j", (params) => {
    expect(writes.update_event_details!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  it("accepts a recurrence-only update because the stored event keeps its time zone", () => {
    expect(writes.update_event_details!.paramsSchema!.safeParse({ eventId: "evt", sendUpdates: "none", recurrence: ["RRULE:FREQ=DAILY;COUNT=3"] }).success).toBe(true);
  });

  it.each([
    [{ eventId: "evt", selfEmail: "me@example.com", response: "accepted" }],
    [{ eventId: "evt", selfEmail: "not-an-email", response: "accepted", sendUpdates: "none" }],
    [{ eventId: "evt", selfEmail: "me@example.com", response: "needsAction", sendUpdates: "none" }],
    [{ eventId: "evt", selfEmail: "me@example.com", response: "accepted", sendUpdates: "none", comment: "x".repeat(1025) }],
    [{ eventId: "evt", response: "accepted", sendUpdates: "none" }],
  ] satisfies [Record<string, unknown>][])("rejects invalid respond_event parameters %j", (params) => {
    expect(writes.respond_event!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  it.each([
    [{ eventId: "evt" }],
    [{ eventId: "evt", sendUpdates: "externalOnly" }],
  ] satisfies [Record<string, unknown>][])("rejects invalid delete_event parameters %j", (params) => {
    expect(writes.delete_event!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  const window = { timeMin: "2026-10-19T00:00:00Z", timeMax: "2026-10-20T00:00:00Z" };
  it.each([
    [{ ...window, items: [] }],
    [{ ...window, items: ["primary", "primary"] }],
    [{ ...window, items: ["../x"] }],
    [{ ...window, items: [".."] }],
    [{ ...window, items: ["a b"] }],
    [{ ...window, items: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }],
    [{ ...window, items: [{ id: "primary" }] }],
    [{ items: ["primary"], timeMin: "2026-10-19T00:00:00", timeMax: "2026-10-20T00:00:00Z" }],
    [{ items: ["primary"], timeMin: "2026-10-20T00:00:00Z", timeMax: "2026-10-19T00:00:00Z" }],
    [{ items: ["primary"], timeMin: "2026-10-19T00:00:00Z", timeMax: "2026-10-19T00:00:00Z" }],
    [{ items: ["primary"], timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-12-03T00:00:00Z" }],
  ] satisfies [Record<string, unknown>][])("rejects invalid free_busy parameters %j", (params) => {
    expect(reads.free_busy!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  it("accepts the maximum 62 day window for 20 calendars", () => {
    expect(reads.free_busy!.paramsSchema!.safeParse({ items: Array.from({ length: 20 }, (_, i) => `p${i}@example.com`),
      timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-12-02T00:00:00Z" }).success).toBe(true);
  });

  it("publishes metadata for every schema key so the app route accepts it", () => {
    const createKeys = ["attendees", "calendarId", "conferenceRequestId", "description", "end", "endDate", "location", "recurrence",
      "reminders", "sendUpdates", "start", "startDate", "summary", "timeZone"];
    expect(Object.keys(writes.create_event_with_attendees!.params).sort()).toEqual(createKeys);
    expect(Object.keys(writes.update_event_details!.params).sort()).toEqual([...createKeys, "eventId"].sort());
    expect(writes.create_event_with_attendees!.params.sendUpdates).toMatchObject({ type: "string", required: true });
    expect(writes.create_event_with_attendees!.params.attendees!.type).toBe("array");
    expect(writes.create_event_with_attendees!.params.reminders!.type).toBe("array");
    expect(Object.keys(writes.respond_event!.params).sort()).toEqual(["calendarId", "comment", "eventId", "response", "selfEmail", "sendUpdates"]);
    expect(reads.free_busy!.params.items).toMatchObject({ type: "array", required: true });
  });
});
