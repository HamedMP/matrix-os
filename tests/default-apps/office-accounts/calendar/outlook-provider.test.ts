import { describe, expect, it } from "vitest";
import { createOutlookCalendarProvider } from "../../../../home/apps/_shared/office-accounts/calendar/index";
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
  OUTLOOK_ALL_DAY_FLOATING,
  OUTLOOK_CALENDARS_PAGE_1,
  OUTLOOK_CALENDARS_PAGE_2,
  OUTLOOK_CREATED_SERIES,
  OUTLOOK_EVENTS_PAGE_1,
  OUTLOOK_EVENTS_PAGE_2,
  OUTLOOK_OCCURRENCE,
  OUTLOOK_SCHEDULE,
  OUTLOOK_TIMED_EVENT,
} from "./outlook-fixtures";

const SERVICE = "microsoft_outlook_calendar";
const ACCOUNT: CalendarAccount = {
  id: calendarAccountId("outlook", "owner@contoso.com"),
  provider: "outlook",
  address: "owner@contoso.com",
  displayName: "Owner Person",
};
const DEFAULT = "AAMkADdefault-cal_1=";
const RANGE = { start: "2026-11-23T00:00:00Z", end: "2026-11-30T00:00:00Z" };

function setup() {
  const bridge = new FakeBridge();
  const provider = createOutlookCalendarProvider({ account: ACCOUNT, label: "owner@contoso.com", bridge });
  return { bridge, provider };
}

async function listed(bridge: FakeBridge, provider: ReturnType<typeof setup>["provider"], ...events: unknown[]) {
  bridge.reply(SERVICE, "list_events", { value: events });
  return provider.listEvents({ calendarIds: [DEFAULT], ...RANGE });
}

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    calendarId: DEFAULT,
    title: "Planning",
    start: instantFromWallTime("2026-11-23T09:00:00", "America/Los_Angeles"),
    end: instantFromWallTime("2026-11-23T10:00:00", "America/Los_Angeles"),
    allDay: false,
    timeZone: "America/Los_Angeles",
    location: "",
    descriptionText: "",
    attendees: [],
    addOnlineMeeting: false,
    ...overrides,
  };
}

describe("Outlook calendar adapter: listCalendars", () => {
  it("follows the next link and normalises colour, default calendar and writability", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_calendars", OUTLOOK_CALENDARS_PAGE_1, OUTLOOK_CALENDARS_PAGE_2);

    const calendars = await provider.listCalendars();

    expect(bridge.calls).toEqual([
      { service: SERVICE, action: "list_calendars", params: { limit: 100 }, label: "owner@contoso.com" },
      { service: SERVICE, action: "list_calendars", params: { limit: 100, skip: 100 }, label: "owner@contoso.com" },
    ]);
    expect(calendars).toEqual([
      { id: DEFAULT, accountId: ACCOUNT.id, name: "Calendar", color: "#3366cc", primary: true, writable: true, visible: true },
      { id: "AAMkADholidays_2=", accountId: ACCOUNT.id, name: "United States holidays", color: "#5fbe7d", primary: false, writable: false, visible: true },
      { id: "AAMkADteam_3=", accountId: ACCOUNT.id, name: "Team", color: "#e3008c", primary: false, writable: true, visible: true },
    ]);
  });
});

describe("Outlook calendar adapter: listEvents", () => {
  it("asks in UTC, pages with skip and normalises every kind of event, ordered by start", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", OUTLOOK_EVENTS_PAGE_1, OUTLOOK_EVENTS_PAGE_2);

    const events = await provider.listEvents({ calendarIds: [DEFAULT], start: "2026-11-23T00:00:00+01:00", end: "2026-11-30T00:00:00+01:00" });

    expect(bridge.calls.map((call) => call.params)).toEqual([
      { calendarId: DEFAULT, startDateTime: "2026-11-22T23:00:00Z", endDateTime: "2026-11-29T23:00:00Z", limit: 50 },
      { calendarId: DEFAULT, startDateTime: "2026-11-22T23:00:00Z", endDateTime: "2026-11-29T23:00:00Z", limit: 50, skip: 100 },
    ]);
    expect(events.map((event) => event.title)).toEqual(["Quarterly planning", "Standup", "Public holiday", "Offsite"]);

    expect(events[0]).toEqual({
      id: `${DEFAULT}/${OUTLOOK_TIMED_EVENT.id}`,
      calendarId: DEFAULT,
      title: "Quarterly planning",
      start: "2026-11-23T14:00:00Z",
      end: "2026-11-23T15:30:00Z",
      allDay: false,
      timeZone: "America/Los_Angeles",
      location: "Conf room A",
      descriptionText: "Agenda\nBudget <Q4>",
      attendees: [
        { address: "owner@contoso.com", name: "Owner Person", response: "accepted", organizer: true },
        { address: "ana@contoso.com", name: "Ana Lima", response: "accepted", organizer: false },
        { address: "bo@contoso.com", name: "Bo", response: "needsAction", organizer: false, optional: true },
      ],
      onlineMeeting: { provider: "microsoft_teams", joinUrl: OUTLOOK_TIMED_EVENT.onlineMeeting.joinUrl },
      myResponse: null,
    });

    expect(events[1]).toEqual({
      id: `${DEFAULT}/${OUTLOOK_OCCURRENCE.id}`,
      calendarId: DEFAULT,
      title: "Standup",
      start: "2026-11-24T08:30:00Z",
      end: "2026-11-24T08:45:00Z",
      allDay: false,
      timeZone: "Europe/London",
      location: "",
      descriptionText: "Daily sync\nBring blockers",
      attendees: [
        { address: "lead@contoso.com", name: "Team Lead", response: "accepted", organizer: true },
        { address: "ana@contoso.com", name: "Ana Lima", response: "accepted", organizer: false },
        { address: "owner@contoso.com", name: "Owner Person", response: "tentative", organizer: false },
      ],
      recurrenceText: "Repeats",
      seriesId: `${DEFAULT}/AAMkSeries_standup=`,
      myResponse: "tentative",
    });
  });

  it("keeps all-day events on their calendar dates, even when sent as shifted UTC moments", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "list_events", OUTLOOK_EVENTS_PAGE_2);

    const [holiday, offsite] = await provider.listEvents({ calendarIds: [DEFAULT], ...RANGE });

    expect(holiday).toMatchObject({ title: "Public holiday", allDay: true, start: "2026-11-25T00:00:00Z", end: "2026-11-26T00:00:00Z", timeZone: "UTC" });
    expect(offsite).toMatchObject({ title: "Offsite", allDay: true, start: "2026-11-26T00:00:00Z", end: "2026-11-28T00:00:00Z", timeZone: "UTC" });
    expect([allDayDate(offsite.start), allDayDate(offsite.end)]).toEqual(["2026-11-26", "2026-11-28"]);
  });

  it("reads a timed event returned in a Windows zone as the right moment", async () => {
    const { bridge, provider } = setup();
    const [series] = await listed(bridge, provider, OUTLOOK_CREATED_SERIES);
    expect(series).toMatchObject({
      start: "2026-11-23T09:00:00-08:00",
      end: "2026-11-23T10:00:00-08:00",
      timeZone: "America/Los_Angeles",
      recurrenceText: "Every 2 weeks on Monday, Wednesday, 10 times",
    });
    expect(series.seriesId).toBeUndefined();
  });

  it("drops join links that are not https", async () => {
    const { bridge, provider } = setup();
    const [event] = await listed(bridge, provider, { ...OUTLOOK_TIMED_EVENT, onlineMeeting: { joinUrl: "javascript:alert(1)" } });
    expect(event.onlineMeeting).toBeUndefined();
  });

  it("rejects bad ranges without calling the provider", async () => {
    const { bridge, provider } = setup();
    await expect(provider.listEvents({ calendarIds: [DEFAULT], start: "2026-11-23T00:00:00Z", end: "2027-01-30T00:00:00Z" }))
      .rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.listEvents({ calendarIds: [DEFAULT], start: "2026-11-23T00:00:00", end: "2026-11-24T00:00:00Z" }))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toEqual([]);
  });
});

describe("Outlook calendar adapter: createEvent", () => {
  it("creates a series with guests, a meeting, a reminder and the scheduled zone's wall time", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_event_with_attendees", OUTLOOK_CREATED_SERIES);

    const created = await provider.createEvent(draft({
      location: "HQ",
      descriptionText: "Bring numbers",
      attendees: [{ address: "Ana@Contoso.com", name: "Ana Lima" }, { address: "owner@contoso.com" }],
      addOnlineMeeting: true,
      recurrence: { freq: "weekly", interval: 2, byDay: ["MO", "WE"], count: 10 },
      reminders: [{ minutesBefore: 15, method: "popup" }, { minutesBefore: 60, method: "email" }],
    }), { sendInvites: true });

    expect(bridge.calls).toEqual([{
      service: SERVICE, action: "create_event_with_attendees", label: "owner@contoso.com",
      params: {
        calendarId: DEFAULT,
        subject: "Planning",
        startDateTime: "2026-11-23T09:00:00",
        endDateTime: "2026-11-23T10:00:00",
        timeZone: "America/Los_Angeles",
        isAllDay: false,
        attendees: [{ address: "ana@contoso.com", name: "Ana Lima", type: "required" }],
        body: "Bring numbers",
        location: "HQ",
        isOnlineMeeting: true,
        recurrence: {
          pattern: { type: "weekly", interval: 2, daysOfWeek: ["monday", "wednesday"] },
          range: { type: "numbered", startDate: "2026-11-23", numberOfOccurrences: 10 },
        },
        reminderMinutesBeforeStart: 15,
      },
    }]);
    expect(created).toMatchObject({
      id: `${DEFAULT}/AAMkNewSeries=`,
      calendarId: DEFAULT,
      myResponse: null,
      onlineMeeting: { provider: "microsoft_teams", joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3anew" },
    });
  });

  it("uses the event's own zone for the wall time and the series' first day", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_event_with_attendees", { ...OUTLOOK_CREATED_SERIES, id: "AAMkTokyo=" });

    // 08:00 in Tokyo on Tuesday is still Monday in UTC.
    await provider.createEvent(draft({
      start: "2026-11-23T23:00:00Z",
      end: "2026-11-24T00:00:00Z",
      timeZone: "Asia/Tokyo",
      recurrence: { freq: "weekly", interval: 1, until: "2026-12-22T23:00:00Z" },
    }), { sendInvites: false });

    expect(bridge.calls[0].params).toMatchObject({
      startDateTime: "2026-11-24T08:00:00",
      endDateTime: "2026-11-24T09:00:00",
      timeZone: "Asia/Tokyo",
      recurrence: {
        pattern: { type: "weekly", interval: 1, daysOfWeek: ["tuesday"] },
        range: { type: "endDate", startDate: "2026-11-24", endDate: "2026-12-23" },
      },
    });
  });

  it("creates an all-day yearly event by date without shifting it", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "create_event_with_attendees", {
      ...OUTLOOK_ALL_DAY_FLOATING, id: "AAMkXmas=", subject: "Holiday",
      start: { dateTime: "2026-12-24T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-12-26T00:00:00.0000000", timeZone: "UTC" },
    });

    const created = await provider.createEvent(draft({
      title: "Holiday", allDay: true, timeZone: "UTC",
      start: allDayInstant("2026-12-24"), end: allDayInstant("2026-12-26"),
      recurrence: { freq: "yearly", interval: 1, until: "2030-12-24T00:00:00Z" },
    }), { sendInvites: false });

    expect(bridge.calls[0].params).toEqual({
      calendarId: DEFAULT, subject: "Holiday", startDateTime: "2026-12-24T00:00:00", endDateTime: "2026-12-26T00:00:00",
      timeZone: "UTC", isAllDay: true,
      recurrence: {
        pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: 24, month: 12 },
        range: { type: "endDate", startDate: "2026-12-24", endDate: "2030-12-24" },
      },
    });
    expect(created).toMatchObject({ allDay: true, start: "2026-12-24T00:00:00Z", end: "2026-12-26T00:00:00Z" });
  });

  it("refuses to invite guests silently, because the provider always notifies them", async () => {
    const { bridge, provider } = setup();
    const error = await provider.createEvent(draft({ attendees: [{ address: "ana@contoso.com" }] }), { sendInvites: false })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "not_supported" });
    await expect(provider.createEvent(draft({ title: "   " }), { sendInvites: true })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.createEvent(draft({ location: "x".repeat(256) }), { sendInvites: true })).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toEqual([]);
  });
});

describe("Outlook calendar adapter: updateEvent", () => {
  it("moves a meeting with times in its own zone and sends the booked room back", async () => {
    const { bridge, provider } = setup();
    const [meeting] = await listed(bridge, provider, OUTLOOK_TIMED_EVENT);
    bridge.reply(SERVICE, "update_event", { ...OUTLOOK_TIMED_EVENT, start: { dateTime: "2026-11-23T15:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T16:30:00.0000000", timeZone: "UTC" } });

    const moved = await provider.updateEvent(meeting.id, {
      start: "2026-11-23T15:00:00Z",
      end: "2026-11-23T16:30:00Z",
      attendees: [{ address: "ana@contoso.com" }, { address: "cy@contoso.com", name: "Cy", optional: true }],
    }, { sendInvites: true });

    expect(bridge.callsTo("update_event")[0].params).toEqual({
      eventId: OUTLOOK_TIMED_EVENT.id,
      startDateTime: "2026-11-23T07:00:00",
      endDateTime: "2026-11-23T08:30:00",
      timeZone: "America/Los_Angeles",
      isAllDay: false,
      attendees: [
        { address: "ana@contoso.com", type: "required" },
        { address: "cy@contoso.com", name: "Cy", type: "optional" },
        { address: "confa@contoso.com", name: "Conf room A", type: "required" },
      ],
    });
    expect(moved.start).toBe("2026-11-23T15:00:00Z");
  });

  it("refuses to change a meeting with guests silently, and changes an own event silently", async () => {
    const { bridge, provider } = setup();
    const [meeting, , offsite] = await listed(bridge, provider, OUTLOOK_TIMED_EVENT, OUTLOOK_OCCURRENCE, OUTLOOK_ALL_DAY_FLOATING);
    await expect(provider.updateEvent(meeting.id, { title: "Renamed" }, { sendInvites: false })).rejects.toMatchObject({ code: "not_supported" });
    await expect(provider.updateEvent(`${DEFAULT}/AAMkNeverSeen=`, { title: "Renamed" }, { sendInvites: false })).rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.callsTo("update_event")).toEqual([]);

    bridge.reply(SERVICE, "update_event", { ...OUTLOOK_ALL_DAY_FLOATING, start: { dateTime: "2026-12-01T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-12-02T00:00:00.0000000", timeZone: "UTC" } });
    const moved = await provider.updateEvent(offsite.id, { start: allDayInstant("2026-12-01"), end: allDayInstant("2026-12-02") }, { sendInvites: false });
    expect(bridge.callsTo("update_event")[0].params).toEqual({
      eventId: "AAMkAllDay_offsite=", startDateTime: "2026-12-01T00:00:00", endDateTime: "2026-12-02T00:00:00", timeZone: "UTC", isAllDay: true,
    });
    expect(moved).toMatchObject({ allDay: true, start: "2026-12-01T00:00:00Z", end: "2026-12-02T00:00:00Z" });
  });

  it("changes a whole series through its series id", async () => {
    const { bridge, provider } = setup();
    const [occurrence] = await listed(bridge, provider, OUTLOOK_OCCURRENCE);
    bridge.reply(SERVICE, "update_event", { ...OUTLOOK_OCCURRENCE, id: "AAMkSeries_standup=", type: "seriesMaster", seriesMasterId: null, subject: "Standup v2" });

    await provider.updateEvent(occurrence.seriesId!, { title: "Standup v2", descriptionText: "", location: "Room 2" }, { sendInvites: true });

    expect(bridge.callsTo("update_event")[0].params).toEqual({ eventId: "AAMkSeries_standup=", subject: "Standup v2", body: "", location: "Room 2" });
  });

  it("asks for the full time when it cannot tell the rest", async () => {
    const { bridge, provider } = setup();
    await expect(provider.updateEvent(`${DEFAULT}/AAMkNeverSeen=`, { start: "2026-11-23T09:00:00Z" }, { sendInvites: true }))
      .rejects.toMatchObject({ code: "not_supported" });
    expect(bridge.calls).toEqual([]);
  });
});

describe("Outlook calendar adapter: deleteEvent and respond", () => {
  it("deletes an own event silently but not a meeting with guests", async () => {
    const { bridge, provider } = setup();
    const [meeting, , offsite] = await listed(bridge, provider, OUTLOOK_TIMED_EVENT, OUTLOOK_OCCURRENCE, OUTLOOK_ALL_DAY_FLOATING);
    bridge.reply(SERVICE, "delete_event", undefined, undefined);

    await expect(provider.deleteEvent(meeting.id, { sendInvites: false })).rejects.toMatchObject({ code: "not_supported" });
    await provider.deleteEvent(offsite.id, { sendInvites: false });
    await provider.deleteEvent(meeting.id, { sendInvites: true });

    expect(bridge.callsTo("delete_event").map((call) => call.params)).toEqual([
      { eventId: "AAMkAllDay_offsite=" },
      { eventId: OUTLOOK_TIMED_EVENT.id },
    ]);
  });

  it("answers an invitation and tells the organiser unless asked not to", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "respond_event", undefined, undefined);

    await provider.respond(`${DEFAULT}/${OUTLOOK_OCCURRENCE.id}`, "tentative", { comment: "  Maybe  " });
    await provider.respond(`${DEFAULT}/AAMkSeries_standup=`, "declined", { notifyOrganizer: false });

    expect(bridge.callsTo("respond_event").map((call) => call.params)).toEqual([
      { eventId: OUTLOOK_OCCURRENCE.id, response: "tentative", comment: "Maybe", sendResponse: true },
      { eventId: "AAMkSeries_standup=", response: "declined", sendResponse: false },
    ]);
  });
});

describe("Outlook calendar adapter: getFreeBusy", () => {
  it("asks once in UTC, merges overlaps, keeps statuses and marks unreadable people unknown", async () => {
    const { bridge, provider } = setup();
    bridge.reply(SERVICE, "get_schedule", OUTLOOK_SCHEDULE);
    const start = "2026-11-23T01:00:00+01:00";
    const end = "2026-11-24T01:00:00+01:00";

    const blocks = await provider.getFreeBusy(["Ana@Contoso.com", "ext@fabrikam.com", "nobody@contoso.com"], start, end);

    expect(bridge.calls).toEqual([{
      service: SERVICE, action: "get_schedule", label: "owner@contoso.com",
      params: { schedules: ["ana@contoso.com", "ext@fabrikam.com", "nobody@contoso.com"], startDateTime: "2026-11-23T00:00:00Z", endDateTime: "2026-11-24T00:00:00Z" },
    }]);
    expect(blocks).toEqual([
      { address: "ana@contoso.com", start: "2026-11-23T09:00:00Z", end: "2026-11-23T10:30:00Z", status: "busy" },
      { address: "ana@contoso.com", start: "2026-11-23T11:00:00Z", end: "2026-11-23T11:30:00Z", status: "tentative" },
      { address: "ana@contoso.com", start: "2026-11-23T13:00:00Z", end: "2026-11-23T18:00:00Z", status: "outOfOffice" },
      { address: "ext@fabrikam.com", start, end, status: "unknown" },
      { address: "nobody@contoso.com", start, end, status: "unknown" },
    ]);
    expect(JSON.stringify(blocks)).not.toContain("Private thing");
  });
});

describe("Outlook calendar adapter: errors", () => {
  it.each([
    [404, "not_connected"],
    [409, "multiple_accounts"],
    [429, "rate_limited"],
    [503, "failed"],
  ])("maps a %i bridge failure to %s without provider text", async (status, code) => {
    const { bridge, provider } = setup();
    bridge.fail(SERVICE, "get_schedule", statusError(status));
    const error = await provider.getFreeBusy(["ana@contoso.com"], RANGE.start, "2026-11-24T00:00:00Z").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain("tenant");
  });

  it("never retries a write on its own", async () => {
    const { bridge, provider } = setup();
    bridge.fail(SERVICE, "create_event_with_attendees", statusError(502));
    await expect(provider.createEvent(draft(), { sendInvites: false })).rejects.toMatchObject({ code: "failed" });
    expect(bridge.callsTo("create_event_with_attendees")).toHaveLength(1);
  });
});
