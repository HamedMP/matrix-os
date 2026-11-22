import { describe, expect, it, vi } from "vitest";
import {
  MICROSOFT_CALENDAR_SCHEDULING_READ_ACTIONS,
  MICROSOFT_CALENDAR_SCHEDULING_WRITE_ACTIONS,
} from "../../packages/gateway/src/integrations/microsoft-calendar-scheduling.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction, ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const SERVICE = "microsoft_outlook_calendar";
const graph = "https://graph.microsoft.com/v1.0/me";
const writes = MICROSOFT_CALENDAR_SCHEDULING_WRITE_ACTIONS[SERVICE]!;
const reads = MICROSOFT_CALENDAR_SCHEDULING_READ_ACTIONS;
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
  const def = { id: SERVICE, actions: all } as ServiceDefinition;
  const result = await executeIntegrationAction({ pipedream: fake.client, externalUserId: "owner",
    connection: { pipedream_account_id: "account" }, def, actionDef: all[actionId]!, serviceId: SERVICE, actionId, params });
  return { fake, result };
}

const recurrence = {
  pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "wednesday"] },
  range: { type: "endDate", startDate: "2026-10-19", endDate: "2026-12-31" },
};
const createParams = {
  calendarId: "AAMkAD+cal=",
  subject: "Planning",
  startDateTime: "2026-10-19T10:00:00",
  endDateTime: "2026-10-19T11:00:00",
  timeZone: "Europe/Stockholm",
  attendees: [{ address: "ada@example.com", name: "Ada", type: "optional" }, { address: "bob@example.com" }],
  body: "Agenda",
  location: "Room 1",
  isOnlineMeeting: true,
  recurrence,
  reminderMinutesBeforeStart: 15,
};

type Case = [string, Record<string, unknown>, "POST" | "PATCH" | "DELETE", string, Record<string, unknown> | undefined, Record<string, string> | undefined];
const cases: Case[] = [
  ["create_event_with_attendees", createParams, "POST", `${graph}/calendars/AAMkAD%2Bcal%3D/events`, {
    subject: "Planning",
    start: { dateTime: "2026-10-19T10:00:00", timeZone: "Europe/Stockholm" },
    end: { dateTime: "2026-10-19T11:00:00", timeZone: "Europe/Stockholm" },
    attendees: [
      { emailAddress: { address: "ada@example.com", name: "Ada" }, type: "optional" },
      { emailAddress: { address: "bob@example.com" }, type: "required" },
    ],
    body: { contentType: "Text", content: "Agenda" },
    location: { displayName: "Room 1" },
    isOnlineMeeting: true,
    recurrence,
    isReminderOn: true,
    reminderMinutesBeforeStart: 15,
  }, undefined],
  ["create_event_with_attendees", { calendarId: "cal", subject: "Holiday", startDateTime: "2026-12-24T00:00:00", endDateTime: "2026-12-26T00:00:00", timeZone: "UTC", isAllDay: true },
    "POST", `${graph}/calendars/cal/events`, {
      subject: "Holiday", isAllDay: true,
      start: { dateTime: "2026-12-24T00:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-12-26T00:00:00", timeZone: "UTC" },
    }, undefined],
  ["update_event", { eventId: "evt_1=", subject: "Renamed", recurrence: null, attendees: [] }, "PATCH", `${graph}/events/evt_1%3D`,
    { subject: "Renamed", attendees: [], recurrence: null }, undefined],
  ["update_event", { eventId: "evt", startDateTime: "2026-10-20T09:30:00", endDateTime: "2026-10-20T10:00:00", timeZone: "America/New_York", isOnlineMeeting: false, reminderMinutesBeforeStart: 0, location: "", body: "" },
    "PATCH", `${graph}/events/evt`, {
      start: { dateTime: "2026-10-20T09:30:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-20T10:00:00", timeZone: "America/New_York" },
      body: { contentType: "Text", content: "" },
      location: { displayName: "" },
      isOnlineMeeting: false, isReminderOn: true, reminderMinutesBeforeStart: 0,
    }, undefined],
  ["delete_event", { eventId: "evt-1" }, "DELETE", `${graph}/events/evt-1`, undefined, undefined],
  ["respond_event", { eventId: "evt", response: "accepted", sendResponse: true }, "POST", `${graph}/events/evt/accept`, { sendResponse: true }, undefined],
  ["respond_event", { eventId: "evt", response: "declined", comment: "Away", sendResponse: false }, "POST", `${graph}/events/evt/decline`, { comment: "Away", sendResponse: false }, undefined],
  ["respond_event", { eventId: "evt", response: "tentative", sendResponse: true }, "POST", `${graph}/events/evt/tentativelyAccept`, { sendResponse: true }, undefined],
  ["get_schedule", { schedules: ["ada@example.com", "bob@example.com"], startDateTime: "2026-10-19T00:00:00Z", endDateTime: "2026-10-26T00:00:00.000Z", intervalMinutes: 15 },
    "POST", `${graph}/calendar/getSchedule`, {
      schedules: ["ada@example.com", "bob@example.com"],
      startTime: { dateTime: "2026-10-19T00:00:00", timeZone: "UTC" },
      endTime: { dateTime: "2026-10-26T00:00:00.000", timeZone: "UTC" },
      availabilityViewInterval: 15,
    }, { Prefer: 'outlook.timezone="UTC"' }],
  ["get_schedule", { schedules: ["ada@example.com"], startDateTime: "2026-10-19T00:00:00Z", endDateTime: "2026-10-20T00:00:00Z" },
    "POST", `${graph}/calendar/getSchedule`, {
      schedules: ["ada@example.com"],
      startTime: { dateTime: "2026-10-19T00:00:00", timeZone: "UTC" },
      endTime: { dateTime: "2026-10-20T00:00:00", timeZone: "UTC" },
      availabilityViewInterval: 30,
    }, { Prefer: 'outlook.timezone="UTC"' }],
];

describe("Outlook calendar scheduling actions", () => {
  it("exports exactly the four writes and the one read with their risk", () => {
    expect(Object.keys(MICROSOFT_CALENDAR_SCHEDULING_WRITE_ACTIONS)).toEqual([SERVICE]);
    expect(Object.keys(writes).sort()).toEqual(["create_event_with_attendees", "delete_event", "respond_event", "update_event"]);
    expect(Object.keys(reads)).toEqual(["get_schedule"]);
    for (const action of Object.values(writes)) expect(action.risk).toBe("write");
    expect(reads.get_schedule!.risk).toBe("read");
    for (const action of Object.values(all)) {
      expect(action.paramsSchema).toBeDefined();
      expect(action.directApi).toBeDefined();
      expect(action.componentKey).toBeUndefined();
    }
  });

  it("says that the provider sends invitations, updates and cancellations", () => {
    expect(writes.create_event_with_attendees!.description).toMatch(/invitation/i);
    expect(writes.update_event!.description).toMatch(/update/i);
    expect(writes.delete_event!.description).toMatch(/cancellation/i);
  });

  it.each(cases)("maps %s to the exact Graph request", async (actionId, params, method, url, body, headers) => {
    const action = all[actionId]!;
    expect(action.directApi!.method).toBe(method);
    expect(action.paramsSchema!.safeParse(params).success).toBe(true);
    for (const key of Object.keys(params)) expect(action.params[key], `${actionId}.${key} metadata`).toBeDefined();
    const { fake, result } = await run(actionId, params);
    expect(result.data).toBeDefined();
    const expected = { externalUserId: "owner", accountId: "account", url,
      ...(method === "DELETE" ? { params: undefined } : { body }), ...(headers ? { headers } : {}) };
    const spy = method === "POST" ? fake.proxyPost : method === "PATCH" ? fake.proxyPatch : fake.proxyDelete;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expected);
    const others = [fake.proxyGet, fake.proxyPost, fake.proxyPatch, fake.proxyDelete, fake.proxyPut].filter(s => s !== spy);
    for (const other of others) expect(other).not.toHaveBeenCalled();
  });

  it.each(cases)("rejects unknown keys on %s before any provider call", async (actionId, params) => {
    await expect(run(actionId, { ...params, url: "https://evil.example" })).rejects.toThrow("Invalid action parameters");
    expect(all[actionId]!.paramsSchema!.safeParse({}).success).toBe(false);
  });

  const unsafeIds = ["", "../x", "?q", "\n", "a/b", "evt?x=1", "evt#frag", "evt\u0000", "evt%2F", "a".repeat(513)];
  it.each(["update_event", "delete_event", "respond_event"])("rejects path-injection event ids for %s at the schema and in url()", (actionId) => {
    const base = actionId === "update_event" ? { subject: "x" } : actionId === "respond_event" ? { response: "accepted", sendResponse: true } : {};
    const url = all[actionId]!.directApi!.url as (p: Record<string, unknown>) => string;
    for (const eventId of unsafeIds) {
      expect(all[actionId]!.paramsSchema!.safeParse({ ...base, eventId }).success, JSON.stringify(eventId)).toBe(false);
      expect(() => url({ ...base, eventId })).toThrow();
    }
  });

  it("rejects path-injection calendar ids at the schema and in url()", () => {
    const url = writes.create_event_with_attendees!.directApi!.url as (p: Record<string, unknown>) => string;
    for (const calendarId of unsafeIds) {
      expect(writes.create_event_with_attendees!.paramsSchema!.safeParse({ ...createParams, calendarId }).success).toBe(false);
      expect(() => url({ ...createParams, calendarId })).toThrow();
    }
  });

  it("rejects an unknown response before choosing a provider path", () => {
    const url = writes.respond_event!.directApi!.url as (p: Record<string, unknown>) => string;
    expect(() => url({ eventId: "evt", response: "../delete", sendResponse: true })).toThrow();
  });

  const base = { calendarId: "cal", subject: "x", startDateTime: "2026-10-19T10:00:00", endDateTime: "2026-10-19T11:00:00", timeZone: "UTC" };
  const invalidCreate: Record<string, unknown>[] = [
    { ...base, subject: "" },
    { ...base, subject: "   " },
    { ...base, subject: "x".repeat(256) },
    { ...base, startDateTime: "2026-10-19T10:00:00Z" },
    { ...base, startDateTime: "2026-10-19T10:00:00+02:00" },
    { ...base, startDateTime: "2026-02-30T10:00:00" },
    { ...base, startDateTime: "2026-10-19T24:00:00" },
    { ...base, startDateTime: "2026-10-19 10:00:00" },
    { ...base, endDateTime: "2026-10-19T10:00:00" },
    { ...base, endDateTime: "2026-10-19T09:00:00" },
    { ...base, endDateTime: "2027-10-21T10:00:00" },
    { ...base, timeZone: "" },
    { ...base, timeZone: "Pacific Standard Time" },
    { ...base, timeZone: "x".repeat(65) },
    { ...base, timeZone: "UTC\n" },
    { calendarId: "cal", subject: "x", startDateTime: "2026-10-19T10:00:00", endDateTime: "2026-10-19T11:00:00" },
    { ...base, isAllDay: true },
    { ...base, isAllDay: "yes" },
    { ...base, attendees: [{ address: "not-an-email" }] },
    { ...base, attendees: [{ address: "ada@example.com", type: "resource" }] },
    { ...base, attendees: [{ address: "ada@example.com", name: "Ada\nBcc: x" }] },
    { ...base, attendees: [{ address: "ada@example.com", extra: true }] },
    { ...base, attendees: Array.from({ length: 101 }, (_, i) => ({ address: `p${i}@example.com` })) },
    { ...base, body: "x".repeat(8193) },
    { ...base, location: "x".repeat(256) },
    { ...base, isOnlineMeeting: "true" },
    { ...base, reminderMinutesBeforeStart: -1 },
    { ...base, reminderMinutesBeforeStart: 40321 },
    { ...base, reminderMinutesBeforeStart: 1.5 },
    { ...base, recurrence: null },
    { ...base, recurrence: { pattern: { type: "relativeMonthly", interval: 1 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 0 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 100 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "weekly", interval: 1 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["Monday"] }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "monday"] }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "absoluteMonthly", interval: 1 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 32 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: 1 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: 1, month: 13 }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 1, index: "first" }, range: { type: "noEnd", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "endDate", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "endDate", startDate: "2026-10-19", endDate: "2026-10-18" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", startDate: "2026-10-19" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", startDate: "2026-10-19", numberOfOccurrences: 731 } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2026-02-30" } } },
    { ...base, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2026-10-19", numberOfOccurrences: 3 } } },
    // Each field is within its own bound, but the request exceeds the 60,000 byte budget.
    { ...base, body: "€".repeat(8192), attendees: Array.from({ length: 100 }, (_, i) => ({ address: `p${i}@example.com`, name: "€".repeat(128) })) },
  ];
  it.each(invalidCreate.map((params, index) => [index, params] as const))("rejects invalid create_event_with_attendees parameters (#%i)", async (_index, params) => {
    expect(writes.create_event_with_attendees!.paramsSchema!.safeParse(params).success).toBe(false);
    const probe = fakeClient();
    await expect(executeIntegrationAction({ pipedream: probe.client, externalUserId: "owner", connection: { pipedream_account_id: "account" },
      def: { id: SERVICE } as ServiceDefinition, actionDef: writes.create_event_with_attendees!, serviceId: SERVICE,
      actionId: "create_event_with_attendees", params })).rejects.toThrow("Invalid action parameters");
    expect(probe.proxyPost).not.toHaveBeenCalled();
  });

  it.each([
    [{ eventId: "evt" }],
    [{ eventId: "evt", calendarId: "cal", subject: "x" }],
    [{ eventId: "evt", startDateTime: "2026-10-19T10:00:00" }],
    [{ eventId: "evt", startDateTime: "2026-10-19T10:00:00", endDateTime: "2026-10-19T11:00:00" }],
    [{ eventId: "evt", timeZone: "UTC" }],
    [{ eventId: "evt", startDateTime: "2026-10-19T11:00:00", endDateTime: "2026-10-19T10:00:00", timeZone: "UTC" }],
    [{ eventId: "evt", isAllDay: true }],
    [{ eventId: "evt", isAllDay: true, startDateTime: "2026-10-19T10:00:00", endDateTime: "2026-10-20T00:00:00", timeZone: "UTC" }],
    [{ eventId: "evt", subject: "" }],
    [{ eventId: "evt", recurrence: { pattern: { type: "daily", interval: 1 } } }],
  ] satisfies [Record<string, unknown>][])("rejects invalid update_event parameters %j", (params) => {
    expect(writes.update_event!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  it("accepts an all-day update with midnight times", () => {
    expect(writes.update_event!.paramsSchema!.safeParse({ eventId: "evt", isAllDay: true, startDateTime: "2026-10-19T00:00:00", endDateTime: "2026-10-20T00:00:00", timeZone: "UTC" }).success).toBe(true);
  });

  it.each([
    [{ eventId: "evt", response: "maybe", sendResponse: true }],
    [{ eventId: "evt", response: "accepted" }],
    [{ eventId: "evt", response: "accepted", sendResponse: "yes" }],
    [{ eventId: "evt", response: "accepted", sendResponse: true, comment: "x".repeat(1025) }],
  ] satisfies [Record<string, unknown>][])("rejects invalid respond_event parameters %j", (params) => {
    expect(writes.respond_event!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  const window = { startDateTime: "2026-10-19T00:00:00Z", endDateTime: "2026-10-20T00:00:00Z" };
  it.each([
    [{ ...window, schedules: [] }],
    [{ ...window, schedules: ["not-an-email"] }],
    [{ ...window, schedules: ["ada@example.com", "ADA@example.com"] }],
    [{ ...window, schedules: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }],
    [{ schedules: ["ada@example.com"], startDateTime: "2026-10-19T00:00:00+02:00", endDateTime: "2026-10-20T00:00:00Z" }],
    [{ schedules: ["ada@example.com"], startDateTime: "2026-10-19T00:00:00", endDateTime: "2026-10-20T00:00:00Z" }],
    [{ schedules: ["ada@example.com"], startDateTime: "2026-10-20T00:00:00Z", endDateTime: "2026-10-19T00:00:00Z" }],
    [{ schedules: ["ada@example.com"], startDateTime: "2026-10-19T00:00:00Z", endDateTime: "2026-10-19T00:00:00Z" }],
    [{ schedules: ["ada@example.com"], startDateTime: "2026-10-01T00:00:00Z", endDateTime: "2026-12-03T00:00:00Z" }],
    [{ ...window, schedules: ["ada@example.com"], intervalMinutes: 4 }],
    [{ ...window, schedules: ["ada@example.com"], intervalMinutes: 1441 }],
    [{ ...window, schedules: "ada@example.com" }],
  ] satisfies [Record<string, unknown>][])("rejects invalid get_schedule parameters %j", (params) => {
    expect(reads.get_schedule!.paramsSchema!.safeParse(params).success).toBe(false);
  });

  it("accepts the maximum 62 day free-busy window for 20 people", () => {
    expect(reads.get_schedule!.paramsSchema!.safeParse({ schedules: Array.from({ length: 20 }, (_, i) => `p${i}@example.com`),
      startDateTime: "2026-10-01T00:00:00Z", endDateTime: "2026-12-02T00:00:00Z" }).success).toBe(true);
  });

  it("publishes metadata for every schema key so the app route accepts it", () => {
    expect(Object.keys(writes.create_event_with_attendees!.params).sort()).toEqual(["attendees", "body", "calendarId", "endDateTime", "isAllDay",
      "isOnlineMeeting", "location", "recurrence", "reminderMinutesBeforeStart", "startDateTime", "subject", "timeZone"]);
    expect(Object.keys(writes.update_event!.params).sort()).toEqual(["attendees", "body", "endDateTime", "eventId", "isAllDay",
      "isOnlineMeeting", "location", "recurrence", "reminderMinutesBeforeStart", "startDateTime", "subject", "timeZone"]);
    expect(writes.create_event_with_attendees!.params.attendees!.type).toBe("array");
    expect(writes.create_event_with_attendees!.params.recurrence!.type).toBe("object");
    expect(writes.create_event_with_attendees!.params.isOnlineMeeting!.type).toBe("boolean");
    expect(writes.respond_event!.params.sendResponse).toMatchObject({ type: "boolean", required: true });
    expect(reads.get_schedule!.params.schedules).toMatchObject({ type: "array", required: true });
  });
});
