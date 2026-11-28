import { describe, expect, it } from "vitest";
import { createMemoryPersistence } from "../../../../home/apps/calendar/src/model/preferences";
import { createCalendarStore } from "../../../../home/apps/calendar/src/model/store";
import { agentContext, createStoreAgentDeps, openRescheduleDraft } from "../../../../home/apps/calendar/src/ui/agent/store-bridge";
import { calendarInfo, FakeCalendarProvider } from "../model/fake-provider";
import { event } from "../model/fixtures";

// Monday 23 November 2026, 10:00 in New York.
const NOW = Date.parse("2026-11-23T15:00:00Z");
const ACCOUNT = { id: "google:me@example.com", provider: "google" as const, address: "me@example.com", displayName: "Me" };

async function setup(view: string, address = ACCOUNT.address) {
  const provider = new FakeCalendarProvider([calendarInfo("work", { primary: true }), calendarInfo("family")]);
  // One event a week for five weeks, plus a Saturday and a Sunday this week.
  provider.events = [
    ...[0, 7, 14, 21, 28].map((offset) => {
      const day = new Date(Date.parse("2026-11-24T15:00:00Z") + offset * 86_400_000).toISOString();
      return event({ id: `work/weekly${offset}`, calendarId: "work", title: `Weekly ${offset}`, start: day, end: new Date(Date.parse(day) + 1_800_000).toISOString() });
    }),
    event({ id: "family/saturday", calendarId: "family", title: "Saturday brunch", start: "2026-11-28T16:00:00Z", end: "2026-11-28T18:00:00Z" }),
    event({ id: "family/sunday", calendarId: "family", title: "Sunday hike", start: "2026-11-29T14:00:00Z", end: "2026-11-29T20:00:00Z" }),
  ];
  provider.busy = [
    { address: "ana@example.com", start: "2026-11-24T16:00:00Z", end: "2026-11-24T17:00:00Z" },
    { address: "ana@example.com", start: "2026-12-15T16:00:00Z", end: "2026-12-15T17:00:00Z" },
  ];
  const store = createCalendarStore({
    connect: async () => [{ account: { ...ACCOUNT, address }, provider }],
    persistence: createMemoryPersistence({ preferences: { timeZone: "America/New_York", view } }),
    now: () => NOW,
    log: () => undefined,
  });
  await store.init();
  return { store, provider, deps: createStoreAgentDeps(store, { generate: async () => "" }) };
}

describe("calendar agent store bridge", () => {
  it("reads every event of a month-long window from Day view", async () => {
    const { store, deps } = await setup("day");
    const events = await deps.listEvents("2026-11-23T00:00:00-05:00", "2026-12-23T00:00:00-05:00");
    expect(events.map((item) => item.id)).toEqual([
      "work/weekly0", "family/saturday", "family/sunday", "work/weekly7", "work/weekly14", "work/weekly21", "work/weekly28",
    ]);
    // The grid stays a Day view.
    expect(store.getSnapshot().range.view).toBe("day");
  });

  it("reads the weekend from Work week view", async () => {
    const { store, deps } = await setup("workWeek");
    const events = await deps.listEvents("2026-11-28T00:00:00-05:00", "2026-11-30T00:00:00-05:00");
    expect(events.map((item) => item.title)).toEqual(["Saturday brunch", "Sunday hike"]);
    expect(store.getSnapshot().range.view).toBe("workWeek");
  });

  it("refuses a partial answer when a calendar cannot be read", async () => {
    const { provider, deps } = await setup("week");
    const listEvents = provider.listEvents.bind(provider);
    provider.listEvents = async (request) => {
      if (request.start === "2026-12-01T00:00:00-05:00") throw new Error("upstream down");
      return listEvents(request);
    };
    await expect(deps.listEvents("2026-12-01T00:00:00-05:00", "2026-12-10T00:00:00-05:00")).rejects.toThrow();
  });

  it("reads free-busy for the whole window in one lookup without painting the grid", async () => {
    const { store, provider, deps } = await setup("day");
    const blocks = await deps.getFreeBusy(["ana@example.com"], "2026-11-23T00:00:00-05:00", "2026-12-23T00:00:00-05:00");
    expect(blocks.map((block) => block.start)).toEqual(["2026-11-24T16:00:00Z", "2026-12-15T16:00:00Z"]);
    expect(provider.callsTo("getFreeBusy")).toHaveLength(1);
    expect(store.getSnapshot().assistant.attendees).toEqual([]);
    expect(store.getSnapshot().assistant.overlays).toEqual({});
  });

  // Outcome: the reschedule draft keeps the event's length, whatever slot it is moved to.
  // Fault: the draft takes both times from the slot, so a slot of another length shortens or stretches the meeting.
  it("moves the event to the slot's start and keeps its own length", async () => {
    const { store } = await setup("week");
    expect(openRescheduleDraft(store, "family/sunday", { id: "slot", start: "2026-12-01T09:00:00-05:00", end: "2026-12-01T10:00:00-05:00" })).toBe(true);
    const draft = store.getSnapshot().draft?.draft;
    expect(draft && Date.parse(draft.start)).toBe(Date.parse("2026-12-01T14:00:00Z"));
    // Sunday hike lasts six hours.
    expect(draft && Date.parse(draft.end) - Date.parse(draft.start)).toBe(6 * 3_600_000);
  });

  it("treats an empty account address as unknown, not as the owner's address", async () => {
    const { store } = await setup("week", "");
    expect(agentContext(store.getSnapshot(), NOW).ownerAddress).toBeNull();
  });
});
