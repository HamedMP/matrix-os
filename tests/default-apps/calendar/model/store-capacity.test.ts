import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { cacheKey, emptyCache, eventsInRange, freshEntry, putEntry, replaceEvent } from "../../../../home/apps/calendar/src/model/cache";
import { createMemoryPersistence } from "../../../../home/apps/calendar/src/model/preferences";
import { createCalendarStore } from "../../../../home/apps/calendar/src/model/store";
import { MAX_VISIBLE_CALENDARS } from "../../../../home/apps/calendar/src/model/store-state";
import { calendarInfo, FakeCalendarProvider } from "./fake-provider";
import { event } from "./fixtures";

const NOW = Date.parse("2026-11-23T15:00:00Z"); // Monday 10:00 in New York
const ME = { id: "google:me@example.com", provider: "google" as const, address: "me@example.com", displayName: "Me" };
const TEAM = { id: "google:team@example.com", provider: "google" as const, address: "team@example.com", displayName: "Team" };
const WEEK = { start: "2026-11-23T00:00:00-05:00", end: "2026-11-30T00:00:00-05:00" };
/** The most one Google reply holds for one calendar: 10 pages of 250. */
const GOOGLE_MAX_EVENTS = 2_500;

/** `count` half-hour meetings on Tuesday of the shown week, one minute apart. */
function meetings(calendarId: string, count: number): CalendarEvent[] {
  const base = Date.parse("2026-11-24T14:00:00Z");
  return Array.from({ length: count }, (_, index) => event({
    id: `${calendarId}/m${index}`,
    calendarId,
    start: new Date(base + index * 60_000).toISOString(),
    end: new Date(base + index * 60_000 + 30 * 60_000).toISOString(),
  }));
}

function storeFor(connections: Array<{ account: typeof ME; provider: FakeCalendarProvider }>) {
  return createCalendarStore({
    connect: async () => connections,
    persistence: createMemoryPersistence({ preferences: { timeZone: "America/New_York" } }),
    now: () => NOW,
    log: () => undefined,
  });
}

describe("calendar store: a range with many events", () => {
  // Outcome: every meeting the adapter returns for the shown week is on the grid and in the agent's answer.
  // Fault: the cache keeps 2,000 of Google's up to 2,500 events and calls the entry complete, so meetings vanish
  // and the assistant proposes times over them.
  it("keeps every event one adapter reply can hold", async () => {
    const provider = new FakeCalendarProvider([calendarInfo("work", { primary: true })]);
    provider.events = meetings("work", GOOGLE_MAX_EVENTS);
    const store = storeFor([{ account: ME, provider }]);
    await store.init();
    expect(store.getSnapshot()).toMatchObject({ eventsStatus: "ready", eventsError: null });
    expect(store.getSnapshot().events).toHaveLength(GOOGLE_MAX_EVENTS);
    expect(await store.readEvents(WEEK.start, WEEK.end)).toHaveLength(GOOGLE_MAX_EVENTS);
  });

  // Outcome: a range that holds more events than the cache keeps says so instead of showing part of it as the whole.
  // Fault: the reply is cut silently, the grid reports ready and the agent reads the cut list as complete.
  it("reports a range it cannot keep in full and refuses to answer from it", async () => {
    const provider = new FakeCalendarProvider([calendarInfo("work", { primary: true })]);
    provider.events = meetings("work", GOOGLE_MAX_EVENTS + 1);
    const store = storeFor([{ account: ME, provider }]);
    await store.init();
    expect(store.getSnapshot()).toMatchObject({ eventsStatus: "error", eventsError: expect.stringContaining("too many events") });
    await expect(store.readEvents(WEEK.start, WEEK.end)).rejects.toMatchObject({ code: "not_supported" });
    // The assistant offers no time it cannot check against every meeting.
    expect(store.findSlots({ durationMinutes: 30 })).toEqual([]);
    expect(store.findSlots({ durationMinutes: 30, includeOwnEvents: false })).not.toEqual([]);
  });

  it("marks an entry incomplete, never fresh, when a newer reply or a write would push it past its cap", () => {
    const month = { start: "2026-11-01T00:00:00-04:00", end: "2026-12-01T00:00:00-05:00" };
    let cache = putEntry(emptyCache(), { calendarId: "work", ...month, events: meetings("work", GOOGLE_MAX_EVENTS), fetchedAt: 1_000 });
    const monthKey = cacheKey("work", month.start, month.end);
    expect(freshEntry(cache, monthKey, 1_500)).not.toBeNull();

    const added = event({ id: "work/new", calendarId: "work", start: "2026-11-02T14:00:00Z", end: "2026-11-02T15:00:00Z" });
    const written = replaceEvent(cache, added.id, added);
    expect(written.entries[monthKey].incomplete).toBe(true);
    expect(written.entries[monthKey].events.map((item) => item.id)).toContain(added.id);
    expect(freshEntry(written, monthKey, 1_500)).toBeNull();

    // A newer week reply lists one more meeting than the month entry has room for.
    cache = putEntry(cache, { calendarId: "work", start: "2026-11-02T00:00:00-05:00", end: "2026-11-09T00:00:00-05:00", events: [added], fetchedAt: 2_000 });
    expect(cache.entries[monthKey].incomplete).toBe(true);
    expect(freshEntry(cache, monthKey, 2_500)).toBeNull();
  });
});

describe("calendar store: many calendars", () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => calendarInfo(`cal${index}`, { primary: index === 0 }));

  // Outcome: no more calendars are shown than the cache can keep for the grid, and turning on one more is refused.
  // Fault: 120+ visible calendars evict each other's entries while the grid reports ready.
  it("shows at most the visible-calendar cap and refuses one more", async () => {
    const provider = new FakeCalendarProvider(many(MAX_VISIBLE_CALENDARS + 10));
    const store = storeFor([{ account: ME, provider }]);
    await store.init();
    const visible = store.getSnapshot().calendars.filter((calendar) => calendar.visible);
    expect(visible.map((calendar) => calendar.id)).toEqual(many(MAX_VISIBLE_CALENDARS).map((calendar) => calendar.id));
    store.setCalendarVisible(`cal${MAX_VISIBLE_CALENDARS}`, true);
    expect(store.getSnapshot().calendars.filter((calendar) => calendar.visible)).toHaveLength(MAX_VISIBLE_CALENDARS);
    store.setCalendarVisible("cal0", false);
    store.setCalendarVisible(`cal${MAX_VISIBLE_CALENDARS}`, true);
    expect(store.getSnapshot().calendars.find((calendar) => calendar.id === `cal${MAX_VISIBLE_CALENDARS}`)?.visible).toBe(true);
  });

  // Outcome: agent reads of other ranges never take events off the shown week while it says ready.
  // Fault: reading two other weeks for every visible calendar evicts the shown week's entries.
  it("keeps the shown range's entries while the agent reads other ranges", async () => {
    const calendars = many(MAX_VISIBLE_CALENDARS);
    const provider = new FakeCalendarProvider(calendars);
    provider.events = calendars.map((calendar) => event({ id: `${calendar.id}/standup`, calendarId: calendar.id,
      start: "2026-11-24T14:00:00Z", end: "2026-11-24T14:30:00Z" }));
    const store = storeFor([{ account: ME, provider }]);
    await store.init();
    await store.readEvents("2026-11-30T00:00:00-05:00", "2026-12-07T00:00:00-05:00");
    await store.readEvents("2026-12-07T00:00:00-05:00", "2026-12-14T00:00:00-05:00");
    const state = store.getSnapshot();
    expect(state.eventsStatus).toBe("ready");
    expect(state.events).toHaveLength(MAX_VISIBLE_CALENDARS);
    expect(eventsInRange(state.cache, calendars.map((calendar) => calendar.id), WEEK.start, WEEK.end)).toHaveLength(MAX_VISIBLE_CALENDARS);
    for (const calendar of calendars) expect(state.cache.entries[cacheKey(calendar.id, WEEK.start, WEEK.end)]).toBeDefined();
  });
});

describe("calendar store: a calendar shared with two accounts", () => {
  function twoAccounts() {
    const shared = "shared@group.calendar.google.com";
    const mine = new FakeCalendarProvider([calendarInfo("me@example.com", { primary: true }), calendarInfo(shared, { writable: false })]);
    const team = new FakeCalendarProvider([calendarInfo("team@example.com", { primary: true }), calendarInfo(shared)]);
    const planning = event({ id: `${shared}/planning`, calendarId: shared, title: "Planning", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" });
    mine.events = [planning];
    team.events = [planning];
    const store = storeFor([{ account: ME, provider: mine }, { account: TEAM, provider: team }]);
    return { store, mine, team, shared };
  }

  // Outcome: a shared calendar is listed once, through the account that can write it, and edits save.
  // Fault: both copies are kept; the index uses the writable one and offers Edit, the writes use the read-only one and fail.
  it("lists the calendar once, through the account that can write it, and saves edits there", async () => {
    const { store, mine, team, shared } = twoAccounts();
    await store.init();
    const copies = store.getSnapshot().calendars.filter((calendar) => calendar.id === shared);
    expect(copies).toEqual([expect.objectContaining({ accountId: TEAM.id, writable: true })]);
    expect(store.getSnapshot().events.map((item) => item.title)).toEqual(["Planning"]);
    expect(mine.callsTo("listEvents").flatMap((call) => (call.args[0] as { calendarIds: string[] }).calendarIds)).not.toContain(shared);

    expect(await store.updateEvent(`${shared}/planning`, { title: "Planning (moved)" }, { sendInvites: false })).toBe(true);
    expect(team.callsTo("updateEvent")).toHaveLength(1);
    expect(mine.callsTo("updateEvent")).toHaveLength(0);
    expect(store.getSnapshot().mutationError).toBeNull();
  });

  it("keeps the first account's copy when no copy can write, and refuses edits", async () => {
    const { store, mine, team, shared } = twoAccounts();
    team.calendars = team.calendars.map((calendar) => (calendar.id === shared ? { ...calendar, writable: false } : calendar));
    mine.calendars = mine.calendars.map((calendar) => (calendar.id === shared ? { ...calendar, primary: false } : calendar));
    await store.init();
    expect(store.getSnapshot().calendars.filter((calendar) => calendar.id === shared)).toEqual([
      expect.objectContaining({ accountId: ME.id, writable: false }),
    ]);
    expect(await store.updateEvent(`${shared}/planning`, { title: "Nope" }, { sendInvites: false })).toBe(false);
    expect(mine.callsTo("updateEvent")).toHaveLength(0);
    expect(team.callsTo("updateEvent")).toHaveLength(0);
  });
});
