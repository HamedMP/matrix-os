import { beforeEach, describe, expect, it } from "vitest";
import { createGoogleCalendarProvider } from "../../../../home/apps/_shared/office-accounts/calendar/index";
import {
  ProviderError,
  allDayDate,
  allDayInstant,
  calendarAccountId,
  instantFromWallTime,
  type CalendarAccount,
  type EventDraft,
} from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { FakeBridge, statusError } from "./fake-bridge";
import {
  GOOGLE_ALL_DAY_TRIP,
  GOOGLE_CALENDAR_LIST_PAGE_1,
  GOOGLE_CALENDAR_LIST_PAGE_2,
  GOOGLE_CREATED_SERIES,
  GOOGLE_EVENTS_PAGE_1,
  GOOGLE_EVENTS_PAGE_2,
  GOOGLE_FREE_BUSY,
  GOOGLE_TEAM_EVENTS,
  GOOGLE_TIMED_EVENT,
} from "./google-fixtures";

const SERVICE = "google_calendar";
const ACCOUNT: CalendarAccount = {
  id: calendarAccountId("google", "owner@example.com"),
  provider: "google",
  address: "owner@example.com",
  displayName: "Owner",
};
const PRIMARY = "owner@example.com";
const TEAM = "c_team1234@group.calendar.google.com";

function setup() {
  const bridge = new FakeBridge();
  const provider = createGoogleCalendarProvider({ account: ACCOUNT, label: "owner@example.com", bridge });
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
    descriptionText: "Bring numbers",
    attendees: [],
    addOnlineMeeting: false,
    ...overrides,
  };
}

describe("Google calendar adapter: listCalendars", () => {
  it("pages through the calendar list and normalises colour, writability and visibility", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_calendars", GOOGLE_CALENDAR_LIST_PAGE_1, GOOGLE_CALENDAR_LIST_PAGE_2);

    const calendars = await provider.listCalendars();

    expect(bridge.calls).toEqual([
      { service: SERVICE, action: "list_calendars", params: { maxResults: 250 }, label: "owner@example.com" },
      { service: SERVICE, action: "list_calendars", params: { maxResults: 250, pageToken: GOOGLE_CALENDAR_LIST_PAGE_1.nextPageToken }, label: "owner@example.com" },
    ]);
    expect(calendars).toEqual([
      { id: PRIMARY, accountId: ACCOUNT.id, name: "owner@example.com", color: "#9fe1e7", primary: true, writable: true, visible: true },
      { id: TEAM, accountId: ACCOUNT.id, name: "Team (shared)", color: "#42d692", primary: false, writable: true, visible: true },
      { id: "en.german#holiday@group.v.calendar.google.com", accountId: ACCOUNT.id, name: "Holidays in Germany", color: "#16a765", primary: false, writable: false, visible: false },
      { id: "boss@example.com", accountId: ACCOUNT.id, name: "boss@example.com", color: "#3366cc", primary: false, writable: false, visible: false },
    ]);
  });
});

describe("Google calendar adapter: listEvents", () => {
  it("lists every page of every calendar and normalises events, ordered by start", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", GOOGLE_EVENTS_PAGE_1, GOOGLE_EVENTS_PAGE_2, GOOGLE_TEAM_EVENTS);
    const start = "2026-11-23T00:00:00+01:00";
    const end = "2026-11-30T00:00:00+01:00";

    const events = await provider.listEvents({ calendarIds: [PRIMARY, TEAM], start, end });

    expect(bridge.calls.map((call) => call.params)).toEqual([
      { calendarId: PRIMARY, timeMin: start, timeMax: end, maxResults: 250 },
      { calendarId: PRIMARY, timeMin: start, timeMax: end, maxResults: 250, pageToken: GOOGLE_EVENTS_PAGE_1.nextPageToken },
      { calendarId: TEAM, timeMin: start, timeMax: end, maxResults: 250 },
    ]);
    expect(events.map((event) => event.title)).toEqual(["Design review", "1:1", "Vendor call", "Trip to Lisbon"]);

    expect(events[0]).toEqual({
      id: `${PRIMARY}/${GOOGLE_TIMED_EVENT.id}`,
      calendarId: PRIMARY,
      title: "Design review",
      start: "2026-11-23T10:00:00+01:00",
      end: "2026-11-23T11:00:00+01:00",
      allDay: false,
      timeZone: "Europe/Berlin",
      location: "Room 4",
      descriptionText: "Agenda:\n1. Specs & risks\nNext steps",
      attendees: [
        { address: "owner@example.com", name: "", response: "accepted", organizer: true },
        { address: "ana@example.com", name: "Ana Lima", response: "tentative", organizer: false },
        { address: "bo@example.com", name: "", response: "needsAction", organizer: false, optional: true },
      ],
      onlineMeeting: { provider: "google_meet", joinUrl: "https://meet.google.com/abc-defg-hij" },
      myResponse: null,
    });

    expect(events[1]).toMatchObject({
      id: `${PRIMARY}/7weekly1on1abc_20261124T080000Z`,
      seriesId: `${PRIMARY}/7weekly1on1abc`,
      recurrenceText: "Repeats",
      timeZone: "Europe/Berlin",
      myResponse: "needsAction",
      onlineMeeting: { provider: "other", joinUrl: "https://video.example.net/j/998877" },
      attendees: [
        { address: "boss@example.com", name: "The Boss", response: "accepted", organizer: true },
        { address: "owner@example.com", name: "", response: "needsAction", organizer: false },
      ],
    });

    expect(events[2].calendarId).toBe(TEAM);
    expect(events[2].onlineMeeting).toBeUndefined();
    expect(events[2].start).toBe("2026-11-25T15:00:00Z");
  });

  it("keeps all-day events on their calendar dates with an exclusive end", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", { items: [GOOGLE_ALL_DAY_TRIP], timeZone: "Pacific/Kiritimati" });

    const [trip] = await provider.listEvents({ calendarIds: [PRIMARY], start: "2026-11-23T00:00:00Z", end: "2026-12-07T00:00:00Z" });

    expect(trip).toMatchObject({ allDay: true, start: "2026-11-27T00:00:00Z", end: "2026-11-30T00:00:00Z", timeZone: "UTC" });
    expect(allDayDate(trip.start)).toBe("2026-11-27");
    expect(allDayDate(trip.end)).toBe("2026-11-30");
  });

  it("rejects ranges the contract does not allow without calling the provider", async () => {
    const { bridge, provider } = setup();
    await expect(provider.listEvents({ calendarIds: [PRIMARY], start: "2026-11-23T00:00:00Z", end: "2027-02-23T00:00:00Z" }))
      .rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.listEvents({ calendarIds: [PRIMARY], start: "2026-11-23T00:00:00Z", end: "2026-11-23T00:00:00Z" }))
      .rejects.toBeInstanceOf(ProviderError);
    expect(await provider.listEvents({ calendarIds: [], start: "2026-11-23T00:00:00Z", end: "2026-11-24T00:00:00Z" })).toEqual([]);
    expect(bridge.calls).toEqual([]);
  });
});

describe("Google calendar adapter: writes", () => {
  it("creates a timed series with attendees, a meeting link, reminders and invitations", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_event_with_attendees", GOOGLE_CREATED_SERIES, GOOGLE_CREATED_SERIES);
    const series = draft({
      attendees: [{ address: "Ana@Example.com", name: "Ana Lima" }, { address: "bo@example.com", optional: true }],
      addOnlineMeeting: true,
      recurrence: { freq: "weekly", interval: 2, byDay: ["MO", "WE"], count: 10 },
      reminders: [{ minutesBefore: 10, method: "popup" }],
    });

    const created = await provider.createEvent(series, { sendInvites: true });
    await provider.createEvent(series, { sendInvites: true });

    const [call, retry] = bridge.callsTo("create_event_with_attendees");
    const { conferenceRequestId, ...params } = call.params;
    expect(params).toEqual({
      calendarId: PRIMARY,
      summary: "Planning",
      start: "2026-11-23T09:00:00+01:00",
      end: "2026-11-23T10:00:00+01:00",
      timeZone: "Europe/Berlin",
      description: "Bring numbers",
      attendees: [{ email: "ana@example.com", displayName: "Ana Lima" }, { email: "bo@example.com", optional: true }],
      recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10"],
      reminders: [{ method: "popup", minutes: 10 }],
      sendUpdates: "all",
    });
    expect(conferenceRequestId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(retry.params.conferenceRequestId).toBe(conferenceRequestId);
    expect(call.label).toBe("owner@example.com");

    expect(created).toMatchObject({
      id: `${PRIMARY}/newseries01`,
      recurrenceText: "Every 2 weeks on Monday, Wednesday, 10 times",
      onlineMeeting: { provider: "google_meet", joinUrl: "https://meet.google.com/new-link-xyz" },
      myResponse: null,
    });
    expect(created.seriesId).toBeUndefined();
  });

  it("gives different drafts different meeting request ids", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_event_with_attendees", GOOGLE_CREATED_SERIES, GOOGLE_CREATED_SERIES);
    await provider.createEvent(draft({ addOnlineMeeting: true }), { sendInvites: false });
    await provider.createEvent(draft({ addOnlineMeeting: true, title: "Other" }), { sendInvites: false });
    const [a, b] = bridge.callsTo("create_event_with_attendees");
    expect(a.params.conferenceRequestId).not.toBe(b.params.conferenceRequestId);
    expect(a.params.sendUpdates).toBe("none");
  });

  it("creates an all-day yearly event by date, silently when invites are off", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_event_with_attendees", {
      id: "xmas", status: "confirmed", summary: "Holiday", start: { date: "2026-12-24" }, end: { date: "2026-12-26" },
      recurrence: ["RRULE:FREQ=YEARLY;UNTIL=20301224"],
    });

    const created = await provider.createEvent(draft({
      title: "Holiday", allDay: true, timeZone: "UTC", descriptionText: "",
      start: allDayInstant("2026-12-24"), end: allDayInstant("2026-12-26"),
      recurrence: { freq: "yearly", interval: 1, until: "2030-12-24T00:00:00Z" },
    }), { sendInvites: false });

    expect(bridge.calls[0].params).toEqual({
      calendarId: PRIMARY, summary: "Holiday", startDate: "2026-12-24", endDate: "2026-12-26",
      recurrence: ["RRULE:FREQ=YEARLY;UNTIL=20301224"], sendUpdates: "none",
    });
    expect(created).toMatchObject({ allDay: true, start: "2026-12-24T00:00:00Z", end: "2026-12-26T00:00:00Z", recurrenceText: "Every year until 2030-12-24" });
  });

  it("refuses an invalid draft before any provider call", async () => {
    const { bridge, provider } = setup();
    await expect(provider.createEvent(draft({ end: "2026-11-23T08:00:00+01:00" }), { sendInvites: true }))
      .rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.createEvent(draft({ attendees: [{ address: "not an address" }] }), { sendInvites: true }))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toEqual([]);
  });

  it("updates an event, keeping the attendees' existing answers and the booked room", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", { items: [GOOGLE_TIMED_EVENT], timeZone: "Europe/Berlin" });
    bridge.reply(SERVICE, "update_event_details", { ...GOOGLE_TIMED_EVENT, summary: "Design review v2" });
    const [event] = await provider.listEvents({ calendarIds: [PRIMARY], start: "2026-11-23T00:00:00Z", end: "2026-11-24T00:00:00Z" });

    const updated = await provider.updateEvent(event.id, {
      title: "Design review v2",
      attendees: [{ address: "ana@example.com" }, { address: "cy@example.com", name: "Cy" }],
    }, { sendInvites: true });

    expect(bridge.callsTo("update_event_details")[0].params).toEqual({
      calendarId: PRIMARY,
      eventId: GOOGLE_TIMED_EVENT.id,
      summary: "Design review v2",
      attendees: [
        { email: "ana@example.com", responseStatus: "tentative" },
        { email: "cy@example.com", displayName: "Cy" },
        { email: "c_room4@resource.calendar.google.com", displayName: "Room 4", responseStatus: "accepted" },
      ],
      sendUpdates: "all",
    });
    expect(updated.title).toBe("Design review v2");
  });

  it("moves an event with both times, reading the all-day flag from the cached event", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", { items: [GOOGLE_ALL_DAY_TRIP] });
    bridge.reply(SERVICE, "update_event_details", { ...GOOGLE_ALL_DAY_TRIP, start: { date: "2026-12-01" }, end: { date: "2026-12-04" } });
    const [trip] = await provider.listEvents({ calendarIds: [PRIMARY], start: "2026-11-23T00:00:00Z", end: "2026-12-07T00:00:00Z" });

    const moved = await provider.updateEvent(trip.id, { start: allDayInstant("2026-12-01"), end: allDayInstant("2026-12-04") }, { sendInvites: false });

    expect(bridge.callsTo("update_event_details")[0].params).toEqual({
      calendarId: PRIMARY, eventId: "tripnov2026", startDate: "2026-12-01", endDate: "2026-12-04", sendUpdates: "none",
    });
    expect(moved.start).toBe("2026-12-01T00:00:00Z");
  });

  it("asks for start, end and the all-day flag together when it cannot tell them", async () => {
    const { bridge, provider } = setup();
    await expect(provider.updateEvent(`${PRIMARY}/unknown1`, { start: "2026-11-23T09:00:00Z" }, { sendInvites: true }))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toEqual([]);
  });

  it("deletes and responds with the stated notification choice", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "delete_event", undefined);
    bridge.reply(SERVICE, "respond_event", GOOGLE_TIMED_EVENT, GOOGLE_TIMED_EVENT);

    await expect(provider.deleteEvent(`${TEAM}/insecure01`, { sendInvites: false })).resolves.toBeUndefined();
    await provider.respond(`${PRIMARY}/7weekly1on1abc_20261124T080000Z`, "accepted", { comment: "See you" });
    await provider.respond(`${PRIMARY}/7weekly1on1abc`, "declined", { notifyOrganizer: false });

    expect(bridge.calls.map(({ action, params }) => ({ action, params }))).toEqual([
      { action: "delete_event", params: { calendarId: TEAM, eventId: "insecure01", sendUpdates: "none" } },
      { action: "respond_event", params: { calendarId: PRIMARY, eventId: "7weekly1on1abc_20261124T080000Z", selfEmail: "owner@example.com", response: "accepted", comment: "See you", sendUpdates: "all" } },
      { action: "respond_event", params: { calendarId: PRIMARY, eventId: "7weekly1on1abc", selfEmail: "owner@example.com", response: "declined", sendUpdates: "none" } },
    ]);
  });

  it("rejects an id that is not a calendar event id", async () => {
    const { provider } = setup();
    await expect(provider.deleteEvent("no-slash", { sendInvites: true })).rejects.toMatchObject({ code: "not_supported" });
  });
});

describe("Google calendar adapter: getFreeBusy", () => {
  it("asks once for several people, merges overlaps and marks unreadable people unknown", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "free_busy", GOOGLE_FREE_BUSY);
    const start = "2026-11-23T00:00:00Z";
    const end = "2026-11-24T00:00:00Z";

    const blocks = await provider.getFreeBusy(["Ana@Example.com", "bo@other.org", "cy@example.com", "ana@example.com"], start, end);

    expect(bridge.calls).toEqual([{
      service: SERVICE, action: "free_busy", label: "owner@example.com",
      params: { items: ["ana@example.com", "bo@other.org", "cy@example.com"], timeMin: start, timeMax: end },
    }]);
    expect(blocks).toEqual([
      { address: "ana@example.com", start: "2026-11-23T09:00:00Z", end: "2026-11-23T11:30:00Z", status: "busy" },
      { address: "ana@example.com", start: "2026-11-23T14:00:00Z", end: "2026-11-23T15:00:00Z", status: "busy" },
      { address: "bo@other.org", start, end, status: "unknown" },
      { address: "cy@example.com", start, end, status: "unknown" },
    ]);
  });

  it("refuses too many people, bad addresses and long ranges", async () => {
    const { bridge, provider } = setup();
    const many = Array.from({ length: 21 }, (_, index) => `p${index}@example.com`);
    await expect(provider.getFreeBusy(many, "2026-11-23T00:00:00Z", "2026-11-24T00:00:00Z")).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.getFreeBusy(["nope"], "2026-11-23T00:00:00Z", "2026-11-24T00:00:00Z")).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.getFreeBusy(["a@example.com"], "2026-11-23T00:00:00Z", "2027-01-30T00:00:00Z")).rejects.toMatchObject({ code: "not_supported" });
    expect(await provider.getFreeBusy([], "2026-11-23T00:00:00Z", "2026-11-24T00:00:00Z")).toEqual([]);
    expect(bridge.calls).toEqual([]);
  });
});

describe("Google calendar adapter: errors", () => {
  let bridge: FakeBridge;
  let provider: ReturnType<typeof setup>["provider"];
  beforeEach(() => ({ bridge, provider } = setup()));

  it.each([
    [404, "not_connected"],
    [409, "multiple_accounts"],
    [429, "rate_limited"],
    [502, "failed"],
  ])("maps a %i bridge failure to %s without provider text", async (status, code) => {
    bridge.fail(SERVICE, "list_calendars", statusError(status));
    const error = await provider.listCalendars().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain("tenant");
  });

  it("treats a plain bridge failure and a malformed reply as failed", async () => {
    bridge.fail(SERVICE, "list_calendars", new Error("MatrixOS bridge fetch failed"));
    bridge.reply(SERVICE, "list_events", "not an object");
    await expect(provider.listCalendars()).rejects.toMatchObject({ code: "failed" });
    await expect(provider.listEvents({ calendarIds: [PRIMARY], start: "2026-11-23T00:00:00Z", end: "2026-11-24T00:00:00Z" }))
      .rejects.toMatchObject({ code: "failed" });
  });
});
