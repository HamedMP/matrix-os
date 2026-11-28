import { describe, expect, it } from "vitest";
import { MAX_FREE_BUSY_ADDRESSES, ProviderError, type EventChanges } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { resolvePeople } from "../../../../home/apps/calendar/src/agent/availability";
import { createMemoryPersistence } from "../../../../home/apps/calendar/src/model/preferences";
import { createCalendarStore } from "../../../../home/apps/calendar/src/model/store";
import { DEFAULT_WORKING_HOURS } from "../../../../home/apps/calendar/src/model/slots";
import { calendarInfo, FakeCalendarProvider } from "./fake-provider";
import { event } from "./fixtures";

const NOW = Date.parse("2026-11-23T15:00:00Z"); // Monday 10:00 in New York
const ACCOUNT = { id: "google:me@example.com", provider: "google" as const, address: "me@example.com", displayName: "Me" };
const guests = (count: number) => Array.from({ length: count }, (_, index) => `guest${index + 1}@example.com`);

function setup() {
  const provider = new FakeCalendarProvider([calendarInfo("work", { primary: true })]);
  provider.events = [
    event({ id: "work/call", calendarId: "work", title: "Call", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z",
      onlineMeeting: { provider: "google_meet", joinUrl: "https://meet.google.com/abc-defg-hij" } }),
  ];
  const store = createCalendarStore({
    connect: async () => [{ account: ACCOUNT, provider }],
    persistence: createMemoryPersistence({ preferences: { timeZone: "America/New_York" } }),
    now: () => NOW,
    log: () => undefined,
  });
  return { store, provider };
}

describe("calendar store: availability of many guests", () => {
  // Outcome: a busy guest after the first 20 still blocks a suggested time.
  // Fault: the guest list is cut at the provider's 20-person limit, so later guests count as free.
  it("checks every guest, in batches the provider accepts, and keeps the full guest list", async () => {
    const { store, provider } = setup();
    const people = guests(25);
    // Only the 23rd guest is busy, all of Monday's working day from 10:00.
    provider.busy = [{ address: "guest23@example.com", start: "2026-11-23T15:00:00Z", end: "2026-11-23T22:00:00Z" }];
    await store.init();
    await store.setAssistantAttendees(people);

    const state = store.getSnapshot();
    expect(state.assistant).toMatchObject({ status: "ready", attendees: people });
    expect(provider.callsTo("getFreeBusy").map((call) => (call.args[0] as string[]).length)).toEqual([MAX_FREE_BUSY_ADDRESSES, 5]);
    store.setAssistantDuration(60);
    const [first] = store.findSlots({ maxResults: 1 });
    expect(first.start).toBe("2026-11-24T09:00:00-05:00");

    const read = await store.readFreeBusy(people, state.range.start, state.range.end);
    expect(read.map((block) => block.address)).toEqual(["guest23@example.com"]);
  });

  // Outcome: the agent's "everyone is free" covers every guest of the event it reschedules.
  it("lets the agent read availability for every guest of an event, not only the first 20", () => {
    const big = event({ id: "work/all-hands", calendarId: "work", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z",
      attendees: guests(21).map((address) => ({ address, name: "", response: "accepted" as const, organizer: false })) });
    const context = {
      now: NOW, timeZone: "America/New_York", weekStart: 1 as const, workingHours: DEFAULT_WORKING_HOURS, defaultDurationMinutes: 30,
      ownerAddress: "me@example.com", calendars: [], events: [big], assistantAttendees: [],
    };
    const resolved = resolvePeople({ attendees: [], attendeesFromEvent: "e1" }, context, [], { e1: "work/all-hands" });
    expect(resolved.addresses).toEqual(guests(21));
  });
});

describe("calendar store: draft guards", () => {
  // Outcome: a draft that is still saving cannot be replaced, so a failed save keeps its edits.
  // Fault: "New event" during the save opens a fresh draft; the failed draft is then dropped.
  it("refuses to open another draft while one is saving, and restores the failed one", async () => {
    const { store, provider } = setup();
    await store.init();
    store.openDraftForGrid("2026-11-25", 13 * 60);
    store.patchDraft({ title: "Planning", location: "Room 4" });
    provider.holdWrites = true;
    provider.failNext = new ProviderError("failed");
    const saving = store.saveDraft({ sendInvites: false });

    expect(store.openNewDraft()).toBe(false);
    expect(store.openDraftForGrid("2026-11-26", 9 * 60)).toBe(false);
    expect(store.openAllDayDraft("2026-11-26")).toBe(false);
    expect(store.openEditDraft("work/call")).toBe(false);
    expect(store.getSnapshot().draft?.draft).toMatchObject({ title: "Planning", location: "Room 4" });

    provider.release();
    expect(await saving).toBe(false);
    expect(store.getSnapshot().draft).toMatchObject({ status: "editing", draft: { title: "Planning", location: "Room 4" } });
  });

  // Outcome: an existing video meeting is never offered for removal, since the provider cannot remove it.
  // Fault: unchecking it sends nothing ("Nothing to change") or silently keeps the link next to another edit.
  it("keeps an existing event's video meeting on and never sends its removal", async () => {
    const { store, provider } = setup();
    await store.init();
    expect(store.openEditDraft("work/call")).toBe(true);
    expect(store.getSnapshot().draft?.draft.addOnlineMeeting).toBe(true);
    store.setDraftOnlineMeeting(false);
    expect(store.getSnapshot().draft?.draft.addOnlineMeeting).toBe(true);
    store.patchDraft({ title: "Call (moved)" });
    expect(await store.saveDraft({ sendInvites: false })).toBe(true);
    expect(provider.callsTo("updateEvent")[0].args[1] as EventChanges).toEqual({ title: "Call (moved)" });
  });
});

describe("calendar store: event loads", () => {
  // Outcome: going back to a week already loaded shows it as ready, and a late failure of the week left behind does not mark it.
  // Fault: a cached load returns without taking the load token, so the abandoned week's failure owns the shown week's status.
  it("lets a cached load supersede an earlier request that later fails", async () => {
    const { store, provider } = setup();
    await store.init();
    expect(store.getSnapshot().eventsStatus).toBe("ready");

    provider.holdReads = true;
    store.shift(1);
    expect(store.getSnapshot().eventsStatus).toBe("loading");
    const pending = store.loadEvents();
    store.shift(-1);
    expect(store.getSnapshot()).toMatchObject({ eventsStatus: "ready", eventsError: null });

    provider.releaseReads(new ProviderError("failed"));
    await pending;
    expect(store.getSnapshot()).toMatchObject({ eventsStatus: "ready", eventsError: null });
  });
});
