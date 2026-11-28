/**
 * Writes that depend on what the provider holds now rather than on the
 * adapter's bounded event cache, plus the list limits.
 */
import { describe, expect, it } from "vitest";
import { createGoogleCalendarProvider } from "../../../../home/apps/_shared/office-accounts/calendar/index";
import {
  ProviderError,
  calendarAccountId,
  instantFromWallTime,
  type CalendarAccount,
  type EventDraft,
} from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { FakeBridge } from "./fake-bridge";
import {
  GOOGLE_CALENDAR_LIST_PAGE_1,
  GOOGLE_CALENDAR_LIST_PAGE_2,
  GOOGLE_RECURRING_OCCURRENCE,
  GOOGLE_TIMED_EVENT,
} from "./google-fixtures";

const SERVICE = "google_calendar";
const PRIMARY = "owner@example.com";
const ACCOUNT: CalendarAccount = { id: calendarAccountId("google", PRIMARY), provider: "google", address: PRIMARY, displayName: "Owner" };
/** An account whose own address the host did not share. */
const UNKNOWN_ADDRESS: CalendarAccount = { id: calendarAccountId("google", "label:work"), provider: "google", address: "", displayName: "Work" };
const WEEK = { start: "2026-11-23T00:00:00Z", end: "2026-11-30T00:00:00Z" };
const ALL_DAY_SERIES = {
  kind: "calendar#event", id: "yearlyseries", status: "confirmed", summary: "Anniversary",
  start: { date: "2026-12-24" }, end: { date: "2026-12-25" }, recurrence: ["RRULE:FREQ=YEARLY"],
};
const people = (count: number) => Array.from({ length: count }, (_, index) => ({ address: `p${index}@example.com` }));

function setup(account: CalendarAccount = ACCOUNT) {
  const bridge = new FakeBridge();
  const provider = createGoogleCalendarProvider({ account, label: "Work", bridge });
  return { bridge, provider };
}

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    calendarId: PRIMARY,
    title: "Planning",
    start: instantFromWallTime("2026-11-23T09:00:00", "Europe/Berlin"),
    end: instantFromWallTime("2026-11-23T10:00:00", "Europe/Berlin"),
    allDay: false,
    timeZone: "Europe/Berlin",
    location: "",
    descriptionText: "",
    attendees: [],
    addOnlineMeeting: false,
    ...overrides,
  };
}

describe("Google calendar adapter: updates read the stored event when the cache does not hold it", () => {
  it("reads the stored event for the parts of a time change it was not given", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "get_event", GOOGLE_TIMED_EVENT);
    bridge.reply(SERVICE, "update_event_details", GOOGLE_TIMED_EVENT, GOOGLE_TIMED_EVENT);
    const id = `${PRIMARY}/${GOOGLE_TIMED_EVENT.id}`;

    await provider.updateEvent(id, { start: "2026-11-23T10:30:00+01:00" }, { sendInvites: true });
    // The reply is held now, so the next change reads nothing.
    await provider.updateEvent(id, { allDay: false, start: "2026-11-23T12:00:00+01:00", end: "2026-11-23T13:00:00+01:00" }, { sendInvites: false });

    expect(bridge.calls.map(({ action, params }) => ({ action, params }))).toEqual([
      { action: "get_event", params: { calendarId: PRIMARY, eventId: GOOGLE_TIMED_EVENT.id } },
      { action: "update_event_details", params: {
        calendarId: PRIMARY, eventId: GOOGLE_TIMED_EVENT.id, start: "2026-11-23T10:30:00+01:00", end: "2026-11-23T11:00:00+01:00",
        timeZone: "Europe/Berlin", sendUpdates: "all",
      } },
      { action: "update_event_details", params: {
        calendarId: PRIMARY, eventId: GOOGLE_TIMED_EVENT.id, start: "2026-11-23T12:00:00+01:00", end: "2026-11-23T13:00:00+01:00",
        timeZone: "Europe/Berlin", sendUpdates: "none",
      } },
    ]);
  });

  it("keeps the stored time zone of an event it no longer holds when a move names none", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "get_event", GOOGLE_TIMED_EVENT);
    bridge.reply(SERVICE, "update_event_details", GOOGLE_TIMED_EVENT);

    await provider.updateEvent(`${PRIMARY}/${GOOGLE_TIMED_EVENT.id}`, {
      allDay: false, start: "2026-11-24T10:00:00+01:00", end: "2026-11-24T11:00:00+01:00",
    }, { sendInvites: false });

    expect(bridge.callsTo("get_event")).toHaveLength(1);
    expect(bridge.callsTo("update_event_details")[0].params).toMatchObject({ timeZone: "Europe/Berlin" });
  });

  it("reads the guest list and rooms of an event it no longer holds before replacing its guests", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "get_event", GOOGLE_TIMED_EVENT);
    bridge.reply(SERVICE, "update_event_details", GOOGLE_TIMED_EVENT);

    await provider.updateEvent(`${PRIMARY}/${GOOGLE_TIMED_EVENT.id}`, { attendees: [{ address: "ana@example.com" }] }, { sendInvites: true });

    expect(bridge.calls.map((call) => call.action)).toEqual(["get_event", "update_event_details"]);
    expect(bridge.callsTo("update_event_details")[0].params.attendees).toEqual([
      { email: "ana@example.com", responseStatus: "tentative" },
      { email: "c_room4@resource.calendar.google.com", displayName: "Room 4", responseStatus: "accepted" },
    ]);
  });

  it("reads the full event when the listed copy left guests out", async () => {
    const { bridge, provider } = setup();
    const partial = { ...GOOGLE_TIMED_EVENT, attendeesOmitted: true, attendees: GOOGLE_TIMED_EVENT.attendees.slice(0, 1) };
    bridge.reply(SERVICE, "list_events", { items: [partial], timeZone: "Europe/Berlin" });
    bridge.reply(SERVICE, "get_event", GOOGLE_TIMED_EVENT);
    bridge.reply(SERVICE, "update_event_details", GOOGLE_TIMED_EVENT);
    const [event] = await provider.listEvents({ calendarIds: [PRIMARY], ...WEEK });

    await provider.updateEvent(event.id, { attendees: [{ address: "cy@example.com" }] }, { sendInvites: true });

    expect(bridge.callsTo("get_event")).toHaveLength(1);
    expect(bridge.callsTo("update_event_details")[0].params.attendees).toContainEqual(
      { email: "c_room4@resource.calendar.google.com", displayName: "Room 4", responseStatus: "accepted" });
  });

  it("refuses to change guests when the provider still leaves some out", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "get_event", { ...GOOGLE_TIMED_EVENT, attendeesOmitted: true });
    await expect(provider.updateEvent(`${PRIMARY}/${GOOGLE_TIMED_EVENT.id}`, { attendees: [{ address: "cy@example.com" }] }, { sendInvites: true }))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.callsTo("update_event_details")).toEqual([]);
  });

  it("refuses guests that would leave no room for the booked rooms instead of dropping a booking", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", { items: [GOOGLE_TIMED_EVENT], timeZone: "Europe/Berlin" });
    const [event] = await provider.listEvents({ calendarIds: [PRIMARY], ...WEEK });

    await expect(provider.updateEvent(event.id, { attendees: people(100) }, { sendInvites: true }))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.callsTo("update_event_details")).toEqual([]);
  });

  it("reads whether an uncached series lasts all day before changing its repeat rule", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "get_event", ALL_DAY_SERIES);
    bridge.reply(SERVICE, "update_event_details", { ...ALL_DAY_SERIES, recurrence: ["RRULE:FREQ=YEARLY;UNTIL=20301224"] });

    await provider.updateEvent(`${PRIMARY}/yearlyseries`, { recurrence: { freq: "yearly", interval: 1, until: "2030-12-24T00:00:00Z" } }, { sendInvites: false });

    expect(bridge.callsTo("get_event")[0].params).toEqual({ calendarId: PRIMARY, eventId: "yearlyseries" });
    expect(bridge.callsTo("update_event_details")[0].params).toEqual({
      calendarId: PRIMARY, eventId: "yearlyseries", recurrence: ["RRULE:FREQ=YEARLY;UNTIL=20301224"], sendUpdates: "none",
    });
  });

  it("changes a repeat rule only on the whole series, never on one occurrence", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", { items: [GOOGLE_RECURRING_OCCURRENCE], timeZone: "Europe/Berlin" });
    const [occurrence] = await provider.listEvents({ calendarIds: [PRIMARY], ...WEEK });

    await expect(provider.updateEvent(occurrence.id, { recurrence: { freq: "daily", interval: 1, count: 3 } }, { sendInvites: false }))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.callsTo("update_event_details")).toEqual([]);
  });

  it.each([
    ["an invalid repeat rule", { recurrence: { freq: "weekly", interval: 0 } }],
    ["a repeat rule with BYDAY on a daily series", { recurrence: { freq: "daily", interval: 1, byDay: ["MO"] } }],
    ["a reminder too far ahead", { reminders: [{ minutesBefore: 40_321, method: "popup" }] }],
    ["too many reminders", { reminders: Array.from({ length: 6 }, () => ({ minutesBefore: 5, method: "popup" })) }],
    ["an unknown reminder method", { reminders: [{ minutesBefore: 5, method: "sms" }] }],
    ["an unknown time zone", { allDay: false, start: "2026-11-23T09:00:00Z", end: "2026-11-23T10:00:00Z", timeZone: "Mars Standard Time" }],
  ] as const)("refuses %s on update with a provider error and no provider call", async (_what, changes) => {
    const { bridge, provider } = setup();
    const error = await provider.updateEvent(`${PRIMARY}/evt1`, changes as never, { sendInvites: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toEqual([]);
  });

  it("refuses an unknown time zone on create without a provider call", async () => {
    const { bridge, provider } = setup();
    await expect(provider.createEvent(draft({ timeZone: "Mars Standard Time" }), { sendInvites: false })).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toEqual([]);
  });
});

describe("Google calendar adapter: answering invitations", () => {
  it("answers with the address Google marks as the owner's own attendee entry", async () => {
    const { bridge, provider } = setup();
    const alias = { ...GOOGLE_RECURRING_OCCURRENCE, attendees: [
      { email: "boss@example.com", organizer: true, responseStatus: "accepted" },
      { email: "Owner.Alias@Example.com", self: true, responseStatus: "needsAction" },
    ] };
    bridge.reply(SERVICE, "list_events", { items: [alias], timeZone: "Europe/Berlin" });
    bridge.reply(SERVICE, "respond_event", alias);
    const [event] = await provider.listEvents({ calendarIds: [PRIMARY], ...WEEK });

    await provider.respond(event.id, "tentative");

    expect(event.myResponse).toBe("needsAction");
    expect(bridge.callsTo("respond_event")[0].params).toMatchObject({ selfEmail: "owner.alias@example.com", response: "tentative" });
  });

  it("reads the event for the owner's address when the host did not share it", async () => {
    const { bridge, provider } = setup(UNKNOWN_ADDRESS);
    bridge.reply(SERVICE, "get_event", GOOGLE_RECURRING_OCCURRENCE);
    bridge.reply(SERVICE, "respond_event", GOOGLE_RECURRING_OCCURRENCE);

    await provider.respond(`${PRIMARY}/${GOOGLE_RECURRING_OCCURRENCE.id}`, "accepted");

    expect(bridge.calls.map((call) => call.action)).toEqual(["get_event", "respond_event"]);
    expect(bridge.callsTo("respond_event")[0].params).toMatchObject({ selfEmail: "owner@example.com" });
  });

  it("learns the owner's address from the primary calendar", async () => {
    const { bridge, provider } = setup(UNKNOWN_ADDRESS);
    bridge.reply(SERVICE, "list_calendars", GOOGLE_CALENDAR_LIST_PAGE_1, GOOGLE_CALENDAR_LIST_PAGE_2);
    bridge.reply(SERVICE, "respond_event", GOOGLE_TIMED_EVENT);
    await provider.listCalendars();

    await provider.respond(`${PRIMARY}/uncached1`, "declined");

    expect(bridge.callsTo("respond_event")[0].params).toMatchObject({ selfEmail: "owner@example.com" });
  });

  it("refuses to answer rather than guess the owner's address from an account label", async () => {
    const { bridge, provider } = setup(UNKNOWN_ADDRESS);
    bridge.reply(SERVICE, "get_event", { ...GOOGLE_TIMED_EVENT, attendees: [{ email: "work@example.com", responseStatus: "needsAction" }] });

    const error = await provider.respond(`${PRIMARY}/${GOOGLE_TIMED_EVENT.id}`, "accepted").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "not_supported" });
    expect((error as Error).message).toMatch(/email address/);
    expect(bridge.callsTo("respond_event")).toEqual([]);
  });
});

describe("Google calendar adapter: list limits", () => {
  const page = (index: number) => ({ items: [], nextPageToken: `page-${index + 1}` });

  it("refuses a range with more events than it reads rather than returning part of it", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", ...Array.from({ length: 10 }, (_, index) => page(index)));
    await expect(provider.listEvents({ calendarIds: [PRIMARY], ...WEEK })).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.callsTo("list_events")).toHaveLength(10);
  });

  it("refuses a calendar list longer than it reads rather than returning part of it", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_calendars", ...Array.from({ length: 10 }, (_, index) => page(index)));
    await expect(provider.listCalendars()).rejects.toMatchObject({ code: "not_supported" });
  });
});
