/** Hand-written Google Calendar API v3 replies, shaped like the live provider's JSON. */

export const GOOGLE_CALENDAR_LIST_PAGE_1 = {
  kind: "calendar#calendarList",
  etag: "\"p33k9lr0s0g6o0g\"",
  nextPageToken: "CkAKPmVuLmdlcm1hbiNob2xpZGF5QGdyb3VwLnYuY2FsZW5kYXIuZ29vZ2xlLmNvbQ==",
  items: [
    {
      kind: "calendar#calendarListEntry",
      id: "owner@example.com",
      summary: "owner@example.com",
      timeZone: "Europe/Berlin",
      colorId: "14",
      backgroundColor: "#9fe1e7",
      foregroundColor: "#000000",
      selected: true,
      accessRole: "owner",
      defaultReminders: [{ method: "popup", minutes: 10 }],
      primary: true,
    },
    {
      kind: "calendar#calendarListEntry",
      id: "c_team1234@group.calendar.google.com",
      summary: "Team",
      summaryOverride: "Team (shared)",
      timeZone: "Europe/Berlin",
      colorId: "7",
      backgroundColor: "#42D692",
      foregroundColor: "#000000",
      selected: true,
      accessRole: "writer",
    },
    {
      kind: "calendar#calendarListEntry",
      id: "en.german#holiday@group.v.calendar.google.com",
      summary: "Holidays in Germany",
      timeZone: "Europe/Berlin",
      colorId: "8",
      accessRole: "reader",
    },
  ],
};

export const GOOGLE_CALENDAR_LIST_PAGE_2 = {
  kind: "calendar#calendarList",
  etag: "\"p33k9lr0s0g6o1g\"",
  items: [
    {
      kind: "calendar#calendarListEntry",
      id: "boss@example.com",
      summary: "boss@example.com",
      timeZone: "America/New_York",
      colorId: "not-a-colour",
      backgroundColor: "red; background:url(x)",
      selected: true,
      hidden: true,
      accessRole: "freeBusyReader",
    },
  ],
};

export const GOOGLE_TIMED_EVENT = {
  kind: "calendar#event",
  etag: "\"3401234567890000\"",
  id: "4k1q2u8p3v9s7m6n5b4c3x2z1a",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=NGsxcTJ1",
  created: "2026-11-01T09:00:00.000Z",
  updated: "2026-11-02T09:00:00.000Z",
  summary: "Design review",
  description: "<p>Agenda:<br>1. Specs &amp; risks</p><ul><li>Next&nbsp;steps</li></ul>",
  location: "Room 4",
  colorId: "5",
  creator: { email: "owner@example.com", self: true },
  organizer: { email: "owner@example.com", self: true },
  start: { dateTime: "2026-11-23T10:00:00+01:00", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-11-23T11:00:00+01:00", timeZone: "Europe/Berlin" },
  iCalUID: "4k1q2u8p3v9s7m6n5b4c3x2z1a@google.com",
  sequence: 0,
  attendees: [
    { email: "owner@example.com", organizer: true, self: true, responseStatus: "accepted" },
    { email: "Ana@Example.com", displayName: "Ana Lima", responseStatus: "tentative" },
    { email: "bo@example.com", optional: true, responseStatus: "needsAction" },
    { email: "c_room4@resource.calendar.google.com", displayName: "Room 4", resource: true, responseStatus: "accepted" },
  ],
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  conferenceData: {
    entryPoints: [
      { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij", label: "meet.google.com/abc-defg-hij" },
      { entryPointType: "phone", uri: "tel:+49-30-1234-5678", label: "+49 30 1234 5678", pin: "123456" },
    ],
    conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
    conferenceId: "abc-defg-hij",
  },
  reminders: { useDefault: true },
  eventType: "default",
};

export const GOOGLE_RECURRING_OCCURRENCE = {
  kind: "calendar#event",
  id: "7weekly1on1abc_20261124T080000Z",
  status: "confirmed",
  summary: "1:1",
  organizer: { email: "boss@example.com", displayName: "The Boss" },
  // No timeZone on start: the calendar's zone from the list reply applies.
  start: { dateTime: "2026-11-24T09:00:00+01:00" },
  end: { dateTime: "2026-11-24T09:30:00+01:00" },
  recurringEventId: "7weekly1on1abc",
  originalStartTime: { dateTime: "2026-11-24T09:00:00+01:00", timeZone: "Europe/Berlin" },
  attendees: [
    { email: "boss@example.com", displayName: "The Boss", organizer: true, responseStatus: "accepted" },
    { email: "owner@example.com", self: true, responseStatus: "needsAction" },
  ],
  conferenceData: {
    entryPoints: [{ entryPointType: "video", uri: "https://video.example.net/j/998877" }],
    conferenceSolution: { key: { type: "addOn" }, name: "Video" },
  },
};

export const GOOGLE_ALL_DAY_TRIP = {
  kind: "calendar#event",
  id: "tripnov2026",
  status: "confirmed",
  summary: "Trip to Lisbon",
  start: { date: "2026-11-27" },
  end: { date: "2026-11-30" },
  transparency: "transparent",
};

export const GOOGLE_INSECURE_LINK_EVENT = {
  kind: "calendar#event",
  id: "insecure01",
  status: "confirmed",
  summary: "Vendor call",
  start: { dateTime: "2026-11-25T15:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-11-25T15:30:00Z", timeZone: "UTC" },
  conferenceData: {
    entryPoints: [{ entryPointType: "video", uri: "javascript:alert(1)" }, { entryPointType: "more", uri: "http://plain.example.com" }],
    conferenceSolution: { key: { type: "addOn" } },
  },
};

export const GOOGLE_CANCELLED_EVENT = { kind: "calendar#event", id: "cancelled01", status: "cancelled" };

export const GOOGLE_EVENTS_PAGE_1 = {
  kind: "calendar#events",
  summary: "owner@example.com",
  timeZone: "Europe/Berlin",
  nextPageToken: "EjYKKzR rest",
  items: [GOOGLE_RECURRING_OCCURRENCE, GOOGLE_TIMED_EVENT, GOOGLE_CANCELLED_EVENT],
};

export const GOOGLE_EVENTS_PAGE_2 = {
  kind: "calendar#events",
  summary: "owner@example.com",
  timeZone: "Europe/Berlin",
  items: [GOOGLE_ALL_DAY_TRIP],
};

export const GOOGLE_TEAM_EVENTS = {
  kind: "calendar#events",
  summary: "Team",
  timeZone: "Europe/Berlin",
  items: [GOOGLE_INSECURE_LINK_EVENT],
};

/** What the provider returns for a created weekly series. */
export const GOOGLE_CREATED_SERIES = {
  kind: "calendar#event",
  id: "newseries01",
  status: "confirmed",
  summary: "Planning",
  description: "Bring numbers",
  location: "",
  organizer: { email: "owner@example.com", self: true },
  start: { dateTime: "2026-11-23T09:00:00+01:00", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-11-23T10:00:00+01:00", timeZone: "Europe/Berlin" },
  recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10"],
  attendees: [
    { email: "owner@example.com", organizer: true, self: true, responseStatus: "accepted" },
    { email: "ana@example.com", displayName: "Ana Lima", responseStatus: "needsAction" },
  ],
  hangoutLink: "https://meet.google.com/new-link-xyz",
};

export const GOOGLE_FREE_BUSY = {
  kind: "calendar#freeBusy",
  timeMin: "2026-11-23T00:00:00.000Z",
  timeMax: "2026-11-24T00:00:00.000Z",
  calendars: {
    "ana@example.com": {
      busy: [
        { start: "2026-11-23T09:30:00Z", end: "2026-11-23T11:00:00Z" },
        { start: "2026-11-23T09:00:00Z", end: "2026-11-23T10:00:00Z" },
        { start: "2026-11-23T11:00:00Z", end: "2026-11-23T11:30:00Z" },
        { start: "2026-11-23T14:00:00Z", end: "2026-11-23T15:00:00Z" },
      ],
    },
    "bo@other.org": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
  },
};
