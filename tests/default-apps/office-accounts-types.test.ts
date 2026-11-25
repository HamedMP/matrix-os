import { describe, expect, it } from "vitest";
import { isValidMailAddress, normalizeMailAddress, sameMailAddress } from "../../home/apps/_shared/office-accounts/types/addresses";
import {
  CALENDAR_SERVICE_IDS,
  ProviderError,
  allDayDate,
  calendarAccountId,
  allDayInstant,
  composeEventId,
  describeRecurrence,
  eventDraftIssues,
  instantsOverlap,
  recurrenceToRRule,
  splitEventId,
  type CalendarProvider,
  type EventDraft,
} from "../../home/apps/_shared/office-accounts/types/calendar";
import {
  compareInstants,
  instantFromMs,
  instantFromWallTime,
  instantInZone,
  instantToMs,
  isIsoInstant,
  localDateOf,
  offsetMinutesOf,
  toUtcInstant,
  wallTimeOf,
  zoneOffsetMinutes,
} from "../../home/apps/_shared/office-accounts/types/time";
import {
  PROVIDER_ERROR_CODES,
  isProviderError,
  isRetryableProviderError,
  providerErrorCodeForStatus,
  toProviderError,
} from "../../home/apps/_shared/office-accounts/types/errors";
import * as barrel from "../../home/apps/_shared/office-accounts/types/index";

describe("instants: ISO strings that always carry an offset", () => {
  it("accepts an explicit offset or Z and rejects anything a provider could misread", () => {
    expect(isIsoInstant("2026-11-23T09:00:00+01:00")).toBe(true);
    expect(isIsoInstant("2026-11-23T08:00:00Z")).toBe(true);
    expect(isIsoInstant("2026-11-23T08:00:00.250-05:30")).toBe(true);
    for (const bad of [
      "2026-11-23T09:00:00", // no offset: ambiguous
      "2026-11-23", // date only
      "2026-11-23T09:00+01:00", // no seconds
      "2026-02-30T09:00:00Z", // not a real day
      "2026-13-01T09:00:00Z",
      "2026-11-23T24:00:00Z",
      "2026-11-23T09:00:00+15:00",
      "2026-11-23 09:00:00Z",
      "",
      20261123,
      null,
    ]) expect(isIsoInstant(bad), String(bad)).toBe(false);
  });

  it("converts between an instant, epoch milliseconds and UTC without losing the moment", () => {
    const ms = Date.UTC(2026, 10, 23, 8, 0, 0);
    expect(instantToMs("2026-11-23T09:00:00+01:00")).toBe(ms);
    expect(toUtcInstant("2026-11-23T09:00:00+01:00")).toBe("2026-11-23T08:00:00Z");
    expect(instantFromMs(ms)).toBe("2026-11-23T08:00:00Z");
    expect(instantFromMs(ms, 60)).toBe("2026-11-23T09:00:00+01:00");
    expect(instantFromMs(ms, -330)).toBe("2026-11-23T02:30:00-05:30");
    expect(instantFromMs(ms + 250)).toBe("2026-11-23T08:00:00.250Z");
    expect(offsetMinutesOf("2026-11-23T02:30:00-05:30")).toBe(-330);
    expect(offsetMinutesOf("2026-11-23T08:00:00Z")).toBe(0);
    expect(() => instantToMs("2026-11-23T09:00:00")).toThrow(RangeError);
    expect(() => instantFromMs(Number.NaN)).toThrow(RangeError);
  });

  it("orders instants by the moment, not by their text", () => {
    const sorted = ["2026-11-23T10:00:00+01:00", "2026-11-23T08:30:00Z", "2026-11-23T03:00:00-05:00"]
      .sort(compareInstants);
    expect(sorted).toEqual(["2026-11-23T03:00:00-05:00", "2026-11-23T08:30:00Z", "2026-11-23T10:00:00+01:00"]);
  });

  it("reads wall-clock time and local date straight from the text", () => {
    expect(wallTimeOf("2026-11-23T09:00:00.500+01:00")).toBe("2026-11-23T09:00:00");
    expect(localDateOf("2026-11-23T00:30:00+01:00")).toBe("2026-11-23");
    expect(() => wallTimeOf("yesterday")).toThrow(RangeError);
  });

  it("expresses a moment in a named time zone, across a daylight-saving change", () => {
    const winter = Date.UTC(2026, 10, 23, 8, 0, 0);
    const summer = Date.UTC(2026, 6, 1, 8, 0, 0);
    expect(zoneOffsetMinutes(winter, "Europe/Berlin")).toBe(60);
    expect(zoneOffsetMinutes(summer, "Europe/Berlin")).toBe(120);
    expect(instantInZone(winter, "Europe/Berlin")).toBe("2026-11-23T09:00:00+01:00");
    expect(instantInZone(summer, "America/New_York")).toBe("2026-07-01T04:00:00-04:00");
    expect(instantInZone(winter, "UTC")).toBe("2026-11-23T08:00:00Z");
    // A zone name the runtime does not know falls back to UTC instead of throwing.
    expect(instantInZone(winter, "Pacific Standard Time")).toBe("2026-11-23T08:00:00Z");
  });

  it("turns the wall-clock time an owner picked into the right instant", () => {
    expect(instantFromWallTime("2026-11-23T09:00:00", "Europe/Berlin")).toBe("2026-11-23T09:00:00+01:00");
    expect(instantFromWallTime("2026-07-01T09:00:00", "Europe/Berlin")).toBe("2026-07-01T09:00:00+02:00");
    expect(instantFromWallTime("2026-03-08T12:00:00", "America/Los_Angeles")).toBe("2026-03-08T12:00:00-07:00");
    expect(() => instantFromWallTime("2026-11-23T09:00:00Z", "UTC")).toThrow(RangeError);
  });
});

describe("provider errors: one typed failure for every adapter", () => {
  it("carries a code and a safe message, and survives a structured clone", () => {
    const error = new ProviderError("rate_limited");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("rate_limited");
    expect(error.message.length).toBeGreaterThan(0);
    expect(isProviderError(error)).toBe(true);
    expect(isProviderError(JSON.parse(JSON.stringify({ code: error.code, message: error.message })))).toBe(true);
    expect(isProviderError({ code: "exploded", message: "x" })).toBe(false);
    expect(isProviderError(new Error("boom"))).toBe(false);
    expect([...PROVIDER_ERROR_CODES].sort()).toEqual(["failed", "multiple_accounts", "not_connected", "not_supported", "rate_limited"]);
  });

  it("never copies an unknown error's text into what the owner sees", () => {
    const leaked = toProviderError(new Error("ECONNRESET 10.0.0.4 /home/matrix/secret token=abc"));
    expect(leaked.code).toBe("failed");
    expect(leaked.message).not.toMatch(/ECONNRESET|10\.0\.0\.4|secret|token/);
    const kept = new ProviderError("not_supported");
    expect(toProviderError(kept)).toBe(kept);
    expect(toProviderError({ code: "multiple_accounts", message: "raw upstream text" }).code).toBe("multiple_accounts");
    expect(toProviderError({ code: "multiple_accounts", message: "raw upstream text" }).message).not.toContain("raw upstream");
  });

  it("caps and flattens a custom message", () => {
    const error = new ProviderError("failed", `line one\nline two ${"x".repeat(500)}`);
    expect(error.message).not.toContain("\n");
    expect(error.message.length).toBeLessThanOrEqual(160);
  });

  it("maps the app bridge statuses to codes and knows which are worth a retry", () => {
    expect(providerErrorCodeForStatus(404)).toBe("not_connected");
    expect(providerErrorCodeForStatus(409)).toBe("multiple_accounts");
    expect(providerErrorCodeForStatus(429)).toBe("rate_limited");
    expect(providerErrorCodeForStatus(503)).toBe("failed");
    expect(providerErrorCodeForStatus(400)).toBe("failed");
    expect(isRetryableProviderError(new ProviderError("rate_limited"))).toBe(true);
    expect(isRetryableProviderError(new ProviderError("failed"))).toBe(true);
    expect(isRetryableProviderError(new ProviderError("not_connected"))).toBe(false);
    expect(isRetryableProviderError(new ProviderError("not_supported"))).toBe(false);
    expect(isRetryableProviderError(new Error("x"))).toBe(false);
  });
});

describe("addresses and accounts", () => {
  it("names the integration service behind each calendar provider", () => {
    expect(CALENDAR_SERVICE_IDS).toEqual({ google: "google_calendar" });
  });

  it("builds stable account ids and compares addresses without case", () => {
    expect(calendarAccountId("google", " Ada@Example.COM ")).toBe("google:ada@example.com");
    expect(normalizeMailAddress(" Ada@Example.COM ")).toBe("ada@example.com");
    expect(sameMailAddress("Ada@Example.com", "ada@example.COM ")).toBe(true);
    expect(sameMailAddress("ada@example.com", "ada@example.org")).toBe(false);
    expect(isValidMailAddress("ada@example.com")).toBe(true);
    for (const bad of ["ada", "ada@", "ada@host", "a b@example.com", "ada@example.com\nBcc: x@y.z", `${"a".repeat(250)}@example.com`]) {
      expect(isValidMailAddress(bad), bad).toBe(false);
    }
  });
});

describe("calendar contract helpers", () => {
  const draft: EventDraft = {
    calendarId: "primary", title: "Review", start: "2026-11-23T09:00:00+01:00", end: "2026-11-23T10:00:00+01:00",
    allDay: false, timeZone: "Europe/Berlin", location: "", descriptionText: "", attendees: [], addOnlineMeeting: false,
  };

  it("keeps an all-day event on its calendar date in every time zone", () => {
    expect(allDayInstant("2026-11-23")).toBe("2026-11-23T00:00:00Z");
    expect(allDayDate("2026-11-23T00:00:00Z")).toBe("2026-11-23");
    expect(() => allDayInstant("2026-02-30")).toThrow(RangeError);
    expect(() => allDayInstant("23/11/2026")).toThrow(RangeError);
  });

  it("packs a calendar id and a provider event id into one opaque event id", () => {
    const id = composeEventId("team@group.calendar.example.com", "abc_123-xyz");
    expect(splitEventId(id)).toEqual({ calendarId: "team@group.calendar.example.com", providerEventId: "abc_123-xyz" });
    expect(splitEventId(composeEventId("AAMk=", "AQMk-_="))).toEqual({ calendarId: "AAMk=", providerEventId: "AQMk-_=" });
    expect(() => composeEventId("a/b", "c")).toThrow(RangeError);
    expect(() => composeEventId("", "c")).toThrow(RangeError);
    expect(() => splitEventId("no-separator")).toThrow(RangeError);
  });

  it("detects overlap with exclusive ends, which is what a free-busy overlay needs", () => {
    expect(instantsOverlap("2026-11-23T09:00:00+01:00", "2026-11-23T10:00:00+01:00", "2026-11-23T08:30:00Z", "2026-11-23T09:30:00Z")).toBe(true);
    // Back-to-back meetings do not overlap.
    expect(instantsOverlap("2026-11-23T09:00:00+01:00", "2026-11-23T10:00:00+01:00", "2026-11-23T09:00:00Z", "2026-11-23T10:00:00Z")).toBe(false);
  });

  it("writes a recurrence as an RFC 5545 rule", () => {
    expect(recurrenceToRRule({ freq: "daily", interval: 1 })).toBe("RRULE:FREQ=DAILY");
    expect(recurrenceToRRule({ freq: "weekly", interval: 2, byDay: ["MO", "WE"], count: 10 }))
      .toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10");
    expect(recurrenceToRRule({ freq: "monthly", interval: 1, until: "2026-12-31T23:59:59+01:00" }))
      .toBe("RRULE:FREQ=MONTHLY;UNTIL=20261231T225959Z");
    expect(() => recurrenceToRRule({ freq: "weekly", interval: 0 })).toThrow(RangeError);
    expect(() => recurrenceToRRule({ freq: "weekly", interval: 1, count: 0 })).toThrow(RangeError);
  });

  it("describes a recurrence in words", () => {
    expect(describeRecurrence({ freq: "daily", interval: 1 })).toBe("Every day");
    expect(describeRecurrence({ freq: "weekly", interval: 2, byDay: ["MO", "WE"] })).toBe("Every 2 weeks on Monday, Wednesday");
    expect(describeRecurrence({ freq: "monthly", interval: 1, count: 6 })).toBe("Every month, 6 times");
    expect(describeRecurrence({ freq: "yearly", interval: 1, until: "2030-01-01T00:00:00Z" })).toBe("Every year until 2030-01-01");
  });

  it("reports why an event draft cannot be created before any provider call", () => {
    expect(eventDraftIssues(draft)).toEqual([]);
    expect(eventDraftIssues({ ...draft, start: "2026-11-23T09:00:00" })).toEqual(["invalid_time"]);
    expect(eventDraftIssues({ ...draft, end: draft.start })).toEqual(["end_not_after_start"]);
    expect(eventDraftIssues({ ...draft, allDay: true })).toEqual(["all_day_not_midnight_utc"]);
    expect(eventDraftIssues({ ...draft, allDay: true, start: "2026-11-23T00:00:00Z", end: "2026-11-24T00:00:00Z" })).toEqual([]);
    expect(eventDraftIssues({ ...draft, attendees: [{ address: "nobody" }] })).toEqual(["invalid_attendee"]);
    expect(eventDraftIssues({ ...draft, attendees: Array.from({ length: 101 }, (_, i) => ({ address: `p${i}@example.com` })) }))
      .toEqual(["too_many_attendees"]);
    expect(eventDraftIssues({ ...draft, recurrence: { freq: "weekly", interval: 0 } })).toEqual(["invalid_recurrence"]);
    expect(eventDraftIssues({ ...draft, reminders: [{ minutesBefore: -5, method: "popup" }] })).toEqual(["invalid_reminder"]);
  });

  it("lets an adapter satisfy the provider interface with the documented shapes", async () => {
    const provider: CalendarProvider = {
      listCalendars: async () => [{ id: "primary", accountId: "google:ada@example.com", name: "Ada", color: "#3366cc", primary: true, writable: true, visible: true }],
      listEvents: async () => [],
      createEvent: async (input) => ({
        id: composeEventId(input.calendarId, "e1"), calendarId: input.calendarId, title: input.title, start: input.start, end: input.end,
        allDay: input.allDay, timeZone: input.timeZone, location: input.location, descriptionText: input.descriptionText,
        attendees: [], myResponse: null,
      }),
      updateEvent: async () => { throw new ProviderError("not_supported"); },
      deleteEvent: async () => undefined,
      respond: async () => undefined,
      getFreeBusy: async (addresses, start, end) => addresses.map((address) => ({ address, start, end, status: "unknown" as const })),
    };
    const created = await provider.createEvent(draft, { sendInvites: false });
    expect(splitEventId(created.id).providerEventId).toBe("e1");
    await expect(provider.updateEvent(created.id, { title: "x" }, { sendInvites: false })).rejects.toMatchObject({ code: "not_supported" });
    expect(await provider.getFreeBusy(["ada@example.com"], draft.start, draft.end)).toHaveLength(1);
  });
});

describe("barrel", () => {
  it("re-exports the calendar, time, address and error contracts from one place", () => {
    expect(barrel.ProviderError).toBe(ProviderError);
    expect(barrel.isIsoInstant).toBe(isIsoInstant);
    expect(barrel.recurrenceToRRule).toBe(recurrenceToRRule);
    expect(barrel.isValidMailAddress).toBe(isValidMailAddress);
  });
});
