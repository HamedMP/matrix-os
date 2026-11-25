import { describe, expect, it } from "vitest";
import {
  cacheKey,
  emptyCache,
  eventsInRange,
  freshEntry,
  putEntry,
  replaceEvent,
  touchEntries,
} from "../../../../home/apps/calendar/src/model/cache";
import {
  addDraftAttendee,
  allDayDraft,
  draftChanges,
  draftForGrid,
  draftFromEvent,
  removeDraftAttendee,
  setDraftAllDay,
  setDraftRecurrence,
  setDraftReminders,
  setDraftTimes,
} from "../../../../home/apps/calendar/src/model/drafts";
import { eventDraftIssues } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { event } from "./fixtures";

const WEEK = { start: "2026-11-23T00:00:00-05:00", end: "2026-11-30T00:00:00-05:00" };
const BASE = { calendarId: "cal-1", timeZone: "America/New_York" };

describe("event cache", () => {
  it("evicts the least recently used entry beyond the cap", () => {
    let cache = emptyCache();
    for (const id of ["a", "b", "c"]) cache = putEntry(cache, { calendarId: id, ...WEEK, events: [], fetchedAt: 0 }, 3);
    cache = touchEntries(cache, [cacheKey("a", WEEK.start, WEEK.end)]);
    cache = putEntry(cache, { calendarId: "d", ...WEEK, events: [], fetchedAt: 0 }, 3);
    expect(Object.values(cache.entries).map((entry) => entry.calendarId).sort()).toEqual(["a", "c", "d"]);
    expect(cache.order).toHaveLength(3);
  });

  it("treats old entries as stale", () => {
    const cache = putEntry(emptyCache(), { calendarId: "a", ...WEEK, events: [], fetchedAt: 1_000 });
    const key = cacheKey("a", WEEK.start, WEEK.end);
    expect(freshEntry(cache, key, 2_000)).not.toBeNull();
    expect(freshEntry(cache, key, 1_000 + 10 * 60_000)).toBeNull();
  });

  it("moves, inserts and removes events across the entries they touch", () => {
    const standup = event({ id: "cal-1/s", start: "2026-11-23T14:00:00Z", end: "2026-11-23T14:30:00Z" });
    const nextWeek = { start: "2026-11-30T00:00:00-05:00", end: "2026-12-07T00:00:00-05:00" };
    let cache = putEntry(emptyCache(), { calendarId: "cal-1", ...WEEK, events: [standup], fetchedAt: 0 });
    cache = putEntry(cache, { calendarId: "cal-1", ...nextWeek, events: [], fetchedAt: 0 });
    const before = cache;
    cache = replaceEvent(cache, standup.id, { ...standup, start: "2026-12-01T14:00:00Z", end: "2026-12-01T14:30:00Z" });
    expect(eventsInRange(cache, ["cal-1"], WEEK.start, WEEK.end)).toEqual([]);
    expect(eventsInRange(cache, ["cal-1"], nextWeek.start, nextWeek.end).map((item) => item.id)).toEqual([standup.id]);
    expect(eventsInRange(before, ["cal-1"], WEEK.start, WEEK.end)).toHaveLength(1);
    cache = replaceEvent(cache, standup.id, null);
    expect(eventsInRange(cache, ["cal-1"], nextWeek.start, nextWeek.end)).toEqual([]);
  });

  it("keeps all-day events at the edge of a zoned range", () => {
    const holiday = event({ id: "cal-1/h", allDay: true, start: "2026-11-23T00:00:00Z", end: "2026-11-24T00:00:00Z" });
    const cache = putEntry(emptyCache(), { calendarId: "cal-1", ...WEEK, events: [holiday], fetchedAt: 0 });
    expect(eventsInRange(cache, ["cal-1"], WEEK.start, WEEK.end)).toHaveLength(1);
  });

  describe("overlapping ranges", () => {
    const MONTH = { start: "2026-11-01T00:00:00-04:00", end: "2026-12-01T00:00:00-05:00" };
    const ids = (cache: ReturnType<typeof emptyCache>, range: { start: string; end: string }) =>
      eventsInRange(cache, ["cal-1"], range.start, range.end).map((item) => `${item.id}@${item.start}`);

    it("drops a meeting from an older month once a newer week reply no longer has it", () => {
      const deleted = event({ id: "cal-1/deleted", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" });
      const earlier = event({ id: "cal-1/earlier", start: "2026-11-10T15:00:00Z", end: "2026-11-10T16:00:00Z" });
      let cache = putEntry(emptyCache(), { calendarId: "cal-1", ...MONTH, events: [deleted, earlier], fetchedAt: 1_000 });
      cache = putEntry(cache, { calendarId: "cal-1", ...WEEK, events: [], fetchedAt: 2_000 });
      expect(ids(cache, WEEK)).toEqual([]);
      expect(ids(cache, MONTH)).toEqual([`${earlier.id}@${earlier.start}`]);
      // The month may hold the meeting elsewhere now, so it is fetched again when shown.
      expect(freshEntry(cache, cacheKey("cal-1", MONTH.start, MONTH.end), 2_500)).toBeNull();
    });

    it("shows a moved meeting once, at the time the newer reply gives", () => {
      const before = event({ id: "cal-1/moved", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" });
      const after = { ...before, start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z" };
      let cache = putEntry(emptyCache(), { calendarId: "cal-1", ...MONTH, events: [before], fetchedAt: 1_000 });
      cache = putEntry(cache, { calendarId: "cal-1", ...WEEK, events: [after], fetchedAt: 2_000 });
      cache = touchEntries(cache, [cacheKey("cal-1", MONTH.start, MONTH.end)]);
      expect(ids(cache, WEEK)).toEqual([`${after.id}@${after.start}`]);
      expect(ids(cache, MONTH)).toEqual([`${after.id}@${after.start}`]);
      // Nothing in the month was left unexplained, so it stays fresh.
      expect(freshEntry(cache, cacheKey("cal-1", MONTH.start, MONTH.end), 2_500)).not.toBeNull();
    });

    it("keeps a newer week's answer when an older month reply is stored after it", () => {
      const deleted = event({ id: "cal-1/deleted", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" });
      let cache = putEntry(emptyCache(), { calendarId: "cal-1", ...WEEK, events: [], fetchedAt: 2_000 });
      cache = putEntry(cache, { calendarId: "cal-1", ...MONTH, events: [deleted], fetchedAt: 1_000 });
      expect(ids(cache, WEEK)).toEqual([]);
      expect(ids(cache, MONTH)).toEqual([]);
      // The same range asked earlier does not replace the newer answer.
      const later = event({ id: "cal-1/later", start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z" });
      cache = putEntry(cache, { calendarId: "cal-1", ...WEEK, events: [later], fetchedAt: 3_000 });
      cache = putEntry(cache, { calendarId: "cal-1", ...WEEK, events: [], fetchedAt: 2_500 });
      expect(ids(cache, WEEK)).toEqual([`${later.id}@${later.start}`]);
    });

    it("leaves other calendars and all-day events just outside the newer range alone", () => {
      const holiday = event({ id: "cal-1/h", allDay: true, start: "2026-11-30T00:00:00Z", end: "2026-12-01T00:00:00Z" });
      const other = event({ id: "cal-2/x", calendarId: "cal-2", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" });
      let cache = putEntry(emptyCache(), { calendarId: "cal-1", ...MONTH, events: [holiday], fetchedAt: 1_000 });
      cache = putEntry(cache, { calendarId: "cal-2", ...MONTH, events: [other], fetchedAt: 1_000 });
      cache = putEntry(cache, { calendarId: "cal-1", ...WEEK, events: [], fetchedAt: 2_000 });
      expect(ids(cache, MONTH)).toEqual([`${holiday.id}@${holiday.start}`]);
      expect(eventsInRange(cache, ["cal-2"], WEEK.start, WEEK.end).map((item) => item.id)).toEqual([other.id]);
      expect(freshEntry(cache, cacheKey("cal-1", MONTH.start, MONTH.end), 2_500)).not.toBeNull();
    });
  });
});

describe("event drafts", () => {
  it("writes grid times with the zone's own offset on each side of a daylight-saving change", () => {
    expect(draftForGrid("2026-03-07", 600, 660, BASE).start).toBe("2026-03-07T10:00:00-05:00");
    expect(draftForGrid("2026-03-09", 600, 660, BASE).start).toBe("2026-03-09T10:00:00-04:00");
    const moved = setDraftTimes(draftForGrid("2026-03-07", 600, 660, BASE), "2026-03-08T01:30", "2026-03-08T03:30");
    expect([moved.start, moved.end]).toEqual(["2026-03-08T01:30:00-05:00", "2026-03-08T03:30:00-04:00"]);
  });

  it("switches between timed and all-day by calendar date", () => {
    const timed = draftForGrid("2026-11-24", 22 * 60, 24 * 60, BASE);
    const allDay = setDraftAllDay(timed, true, BASE.timeZone);
    expect(allDay).toMatchObject({ allDay: true, timeZone: "UTC", start: "2026-11-24T00:00:00Z", end: "2026-11-25T00:00:00Z" });
    expect(eventDraftIssues(allDay)).toEqual([]);
    expect(setDraftAllDay(allDay, false, BASE.timeZone)).toMatchObject({ start: "2026-11-24T09:00:00-05:00", end: "2026-11-24T09:30:00-05:00" });
    expect(allDayDraft("2026-11-26", "2026-11-27", BASE).end).toBe("2026-11-28T00:00:00Z");
  });

  it("adds attendees once, ignores invalid ones and removes by address", () => {
    let draft = draftForGrid("2026-11-24", 600, 630, BASE);
    draft = addDraftAttendee(draft, { address: "Ana@Example.com", name: "Ana\nB" });
    draft = addDraftAttendee(draft, { address: "ana@example.com" });
    draft = addDraftAttendee(draft, { address: "nope" });
    expect(draft.attendees).toEqual([{ address: "ana@example.com", name: "Ana B" }]);
    expect(removeDraftAttendee(draft, "ANA@example.com").attendees).toEqual([]);
  });

  it("cleans reminders and flags an invalid recurrence", () => {
    const draft = draftForGrid("2026-11-24", 600, 630, BASE);
    const reminded = setDraftReminders(draft, [
      { minutesBefore: 30, method: "popup" },
      { minutesBefore: 10, method: "email" },
      { minutesBefore: 30, method: "popup" },
      { minutesBefore: -5, method: "popup" },
    ]);
    expect(reminded.reminders).toEqual([{ minutesBefore: 10, method: "email" }, { minutesBefore: 30, method: "popup" }]);
    expect("reminders" in setDraftReminders(reminded, null)).toBe(false);
    const recurring = setDraftRecurrence(draft, { freq: "daily", interval: 0 });
    expect(eventDraftIssues(recurring)).toContain("invalid_recurrence");
    expect(eventDraftIssues(setDraftRecurrence(draft, { freq: "weekly", interval: 2, byDay: ["MO", "WE"], count: 6 }))).toEqual([]);
  });

  it("sends only changed fields, with times together", () => {
    const original = draftFromEvent(event({
      start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z", timeZone: "America/New_York",
      attendees: [{ address: "boss@example.com", name: "", response: "accepted", organizer: true }],
    }));
    expect(original.attendees).toEqual([]);
    expect(draftChanges(original, { ...original, title: "New" })).toEqual({ title: "New" });
    const moved = setDraftTimes(original, "2026-11-24T11:00", "2026-11-24T12:00");
    expect(draftChanges(original, moved)).toEqual({
      start: "2026-11-24T11:00:00-05:00", end: "2026-11-24T12:00:00-05:00", allDay: false, timeZone: "America/New_York",
    });
  });
});
