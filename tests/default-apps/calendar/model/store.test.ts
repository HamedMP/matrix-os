import { describe, expect, it } from "vitest";
import { ProviderError } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { createMemoryPersistence, parsePreferences } from "../../../../home/apps/calendar/src/model/preferences";
import { createCalendarStore, type CalendarStore } from "../../../../home/apps/calendar/src/model/store";
import { calendarInfo, FakeCalendarProvider } from "./fake-provider";
import { event } from "./fixtures";

const NOW = Date.parse("2026-11-23T15:00:00Z"); // Monday 10:00 in New York
const ACCOUNT = { id: "google:me@example.com", provider: "google" as const, address: "me@example.com", displayName: "Me" };

function setup(options: { preferences?: unknown; proposals?: unknown[] } = {}) {
  const provider = new FakeCalendarProvider([
    calendarInfo("work", { primary: true }),
    calendarInfo("family"),
    calendarInfo("holidays", { writable: false, visible: false }),
  ]);
  provider.events = [
    event({ id: "work/standup", calendarId: "work", title: "Standup", start: "2026-11-23T14:00:00Z", end: "2026-11-23T14:30:00Z" }),
    event({ id: "family/dinner", calendarId: "family", title: "Dinner", start: "2026-11-24T23:00:00Z", end: "2026-11-25T00:30:00Z" }),
    event({ id: "holidays/thanks", calendarId: "holidays", title: "Thanksgiving", start: "2026-11-26T00:00:00Z", end: "2026-11-27T00:00:00Z", allDay: true }),
    event({ id: "work/invite", calendarId: "work", title: "Review", start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z",
      myResponse: "needsAction", attendees: [{ address: "me@example.com", name: "", response: "needsAction", organizer: false }] }),
  ];
  const persistence = createMemoryPersistence({
    preferences: options.preferences ?? { timeZone: "America/New_York" },
    proposals: options.proposals,
  });
  const logged: string[] = [];
  const store = createCalendarStore({
    connect: async () => [{ account: ACCOUNT, provider }],
    persistence,
    now: () => NOW,
    log: (action) => logged.push(action),
  });
  return { store, provider, persistence, logged };
}

function titles(store: CalendarStore): string[] {
  return store.getSnapshot().events.map((item) => item.title);
}

describe("calendar store: loading and visibility", () => {
  it("loads the week of today in the saved zone and only visible calendars", async () => {
    const { store, provider } = setup();
    await store.init();
    const state = store.getSnapshot();
    expect(state.range.view).toBe("week");
    expect(state.range.start).toBe("2026-11-23T00:00:00-05:00");
    expect(state.calendars.map((calendar) => [calendar.id, calendar.visible])).toEqual([["work", true], ["family", true], ["holidays", false]]);
    expect(titles(store)).toEqual(["Standup", "Dinner", "Review"]);
    expect(provider.callsTo("listEvents")).toHaveLength(1);
    expect((provider.callsTo("listEvents")[0].args[0] as { calendarIds: string[] }).calendarIds).toEqual(["work", "family"]);
  });

  it("persists a show or hide choice and restores it in a new session", async () => {
    const first = setup();
    await first.store.init();
    first.store.setCalendarVisible("family", false);
    first.store.setCalendarVisible("holidays", true);
    await first.store.flush();
    expect(titles(first.store)).toContain("Thanksgiving");
    expect(titles(first.store)).not.toContain("Dinner");
    expect(first.persistence.saved?.calendarVisibility).toEqual({ family: false, holidays: true });

    const second = setup({ preferences: first.persistence.saved });
    await second.store.init();
    expect(second.store.getSnapshot().calendars.map((calendar) => calendar.visible)).toEqual([true, false, true]);
    expect((second.provider.callsTo("listEvents")[0].args[0] as { calendarIds: string[] }).calendarIds).toEqual(["work", "holidays"]);
  });

  it("reuses cached ranges when navigating back and refetches on refresh", async () => {
    const { store, provider } = setup();
    await store.init();
    store.shift(1);
    await Promise.resolve();
    await store.loadEvents();
    expect(store.getSnapshot().range.startKey).toBe("2026-11-30");
    store.shift(-1);
    await store.loadEvents();
    expect(provider.callsTo("listEvents")).toHaveLength(2);
    expect(titles(store)).toEqual(["Standup", "Dinner", "Review"]);
    await store.refresh();
    expect(provider.callsTo("listEvents")).toHaveLength(3);
  });

  it("keeps cached events and shows a fixed message when loading fails", async () => {
    const { store, provider, logged } = setup();
    await store.init();
    provider.listEvents = async () => {
      throw new Error("upstream said: token xyz expired at /internal/path");
    };
    await store.refresh();
    const state = store.getSnapshot();
    expect(state.eventsStatus).toBe("error");
    expect(state.eventsError).toBe("Something went wrong. Try again.");
    expect(logged).toContain("load events");
  });

  it("changes view and week start and saves them", async () => {
    const { store, persistence } = setup();
    await store.init();
    store.setPreferences({ weekStart: 0 });
    store.setView("month");
    await store.flush();
    const state = store.getSnapshot();
    expect(state.range.view).toBe("month");
    expect(state.range.startKey).toBe("2026-11-01");
    expect(parsePreferences(persistence.saved)).toMatchObject({ view: "month", weekStart: 0 });
  });
});

describe("calendar store: optimistic writes", () => {
  it("shows a new event at once and replaces it with the provider's event", async () => {
    const { store, provider } = setup();
    await store.init();
    store.openDraftForGrid("2026-11-24", 13 * 60, 14 * 60);
    store.patchDraft({ title: "Planning" });
    store.addDraftAttendee({ address: "Ana@Example.com" });
    provider.holdWrites = true;
    const saving = store.saveDraft({ sendInvites: true });
    let state = store.getSnapshot();
    expect(state.draft?.status).toBe("saving");
    const optimistic = state.events.find((item) => item.title === "Planning");
    expect(optimistic?.id).toMatch(/^pending:/);
    expect(state.pendingEventIds).toEqual([optimistic?.id]);
    provider.release();
    expect(await saving).toBe(true);
    state = store.getSnapshot();
    expect(state.draft).toBeNull();
    expect(state.pending).toEqual([]);
    expect(state.events.find((item) => item.title === "Planning")?.id).toBe("work/created1");
    const [draft, options] = provider.callsTo("createEvent")[0].args as [{ start: string; attendees: unknown[] }, unknown];
    expect(draft.start).toBe("2026-11-24T13:00:00-05:00");
    expect(draft.attendees).toEqual([{ address: "ana@example.com" }]);
    expect(options).toEqual({ sendInvites: true });
  });

  it("rolls a failed create back and keeps the draft open with the error", async () => {
    const { store, provider } = setup();
    await store.init();
    store.openDraftForGrid("2026-11-24", 13 * 60);
    store.patchDraft({ title: "Planning" });
    provider.failNext = new ProviderError("rate_limited");
    expect(await store.saveDraft({ sendInvites: false })).toBe(false);
    const state = store.getSnapshot();
    expect(titles(store)).not.toContain("Planning");
    expect(state.draft).toMatchObject({ status: "editing", error: "Too many requests. Try again in a moment." });
    expect(state.pending).toEqual([]);
  });

  it("does not call the provider for an invalid draft", async () => {
    const { store, provider } = setup();
    await store.init();
    store.openDraftForGrid("2026-11-24", 13 * 60);
    store.setDraftTimes("2026-11-24T14:00", "2026-11-24T13:00");
    expect(await store.saveDraft({ sendInvites: false })).toBe(false);
    expect(store.getSnapshot().draft?.issues).toContain("end_not_after_start");
    expect(provider.callsTo("createEvent")).toHaveLength(0);
  });

  it("restores an event when an update, a move or a delete fails", async () => {
    const { store, provider } = setup();
    await store.init();
    provider.holdWrites = true;
    provider.failNext = new ProviderError("failed");
    const moving = store.moveEvent("work/standup", Date.parse("2026-11-23T18:00:00Z"), { sendInvites: false });
    expect(store.getSnapshot().events.find((item) => item.id === "work/standup")?.start).toBe("2026-11-23T18:00:00Z");
    provider.release();
    expect(await moving).toBe(false);
    expect(store.getSnapshot().events.find((item) => item.id === "work/standup")?.start).toBe("2026-11-23T14:00:00Z");
    expect(store.getSnapshot().mutationError).toBe("Something went wrong. Try again.");

    provider.holdWrites = false;
    provider.failNext = new ProviderError("failed");
    expect(await store.deleteEvent("family/dinner", { sendInvites: false })).toBe(false);
    expect(titles(store)).toContain("Dinner");

    expect(await store.deleteEvent("family/dinner", { sendInvites: false })).toBe(true);
    expect(titles(store)).not.toContain("Dinner");
  });

  it("answers an invitation optimistically and rolls back on failure", async () => {
    const { store, provider } = setup();
    await store.init();
    provider.failNext = new ProviderError("failed");
    expect(await store.respond("work/invite", "accepted")).toBe(false);
    expect(store.getSnapshot().events.find((item) => item.id === "work/invite")?.myResponse).toBe("needsAction");
    expect(await store.respond("work/invite", "accepted")).toBe(true);
    const invite = store.getSnapshot().events.find((item) => item.id === "work/invite");
    expect(invite?.myResponse).toBe("accepted");
    expect(invite?.attendees[0].response).toBe("accepted");
  });

  it("keeps an unconfirmed delete hidden when a reload lands meanwhile", async () => {
    const { store, provider } = setup();
    await store.init();
    provider.holdWrites = true;
    const deleting = store.deleteEvent("work/standup", { sendInvites: false });
    await store.refresh();
    expect(titles(store)).not.toContain("Standup");
    provider.release();
    expect(await deleting).toBe(true);
    expect(titles(store)).not.toContain("Standup");
  });

  it("refuses writes to a read-only calendar without calling the provider", async () => {
    const { store, provider } = setup();
    await store.init();
    store.setCalendarVisible("holidays", true);
    await store.loadEvents();
    expect(await store.deleteEvent("holidays/thanks", { sendInvites: false })).toBe(false);
    expect(store.getSnapshot().mutationError).toBe("This calendar is read-only.");
    expect(provider.callsTo("deleteEvent")).toHaveLength(0);
  });

  it("edits an existing event and sends only the changed fields", async () => {
    const { store, provider } = setup();
    await store.init();
    expect(store.openEditDraft("work/standup")).toBe(true);
    store.patchDraft({ title: "Daily standup" });
    expect(await store.saveDraft({ sendInvites: false })).toBe(true);
    expect(provider.callsTo("updateEvent")[0].args.slice(0, 2)).toEqual(["work/standup", { title: "Daily standup" }]);
    expect(titles(store)).toContain("Daily standup");
  });
});

describe("calendar store: scheduling assistant and proposals", () => {
  it("overlays attendees' busy time and turns free slots into proposals", async () => {
    const { store, provider } = setup();
    provider.busy = [{ address: "ana@example.com", start: "2026-11-23T16:00:00Z", end: "2026-11-23T19:00:00Z" }];
    await store.init();
    await store.setAssistantAttendees(["Ana@example.com", "bad address"]);
    let state = store.getSnapshot();
    expect(provider.callsTo("getFreeBusy")[0].args).toEqual([["ana@example.com"], state.range.start, state.range.end]);
    expect(state.assistant.overlays["2026-11-23"]).toEqual([
      { address: "ana@example.com", dayKey: "2026-11-23", startMinute: 660, endMinute: 840, status: "busy" },
    ]);
    store.setAssistantDuration(60);
    const proposals = store.findSlots({ maxResults: 2, title: "Intro" });
    // 10:00 is now; 10:00-11:00 overlaps nobody; Ana is busy 11:00-14:00.
    expect(proposals.map((proposal) => proposal.start)).toEqual(["2026-11-23T10:00:00-05:00", "2026-11-23T14:00:00-05:00"]);
    state = store.getSnapshot();
    expect(state.proposals).toHaveLength(2);
    expect(state.proposals[0]).toMatchObject({ source: "assistant", title: "Intro", attendees: [{ address: "ana@example.com" }] });

    expect(store.openDraftFromProposal(state.proposals[1].id)).toBe(true);
    expect(store.getSnapshot().draft?.draft).toMatchObject({ title: "Intro", start: "2026-11-23T14:00:00-05:00", calendarId: "work" });
    expect(await store.saveDraft({ sendInvites: true })).toBe(true);
    expect(store.getSnapshot().proposals.map((proposal) => proposal.start)).toEqual(["2026-11-23T10:00:00-05:00"]);
  });

  it("refetches busy time after navigating to another week", async () => {
    const { store, provider } = setup();
    await store.init();
    await store.setAssistantAttendees(["ana@example.com"]);
    store.shift(1);
    await Promise.resolve();
    await store.loadBusy();
    const calls = provider.callsTo("getFreeBusy");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1].args[1]).toBe("2026-11-30T00:00:00-05:00");
  });

  it("loads agent proposals, ignores malformed ones and deletes a dismissed row", async () => {
    const rows = [
      { id: "6f1c1d1e-0000-4000-8000-000000000001", start_at: "2026-11-24T15:00:00Z", end_at: "2026-11-24T15:30:00Z", title: "1:1", attendees: [{ address: "bo@example.com" }], note: "Both free" },
      { id: "broken", start_at: "tomorrow", end_at: "later" },
    ];
    const { store, persistence } = setup({ proposals: rows });
    await store.init();
    const state = store.getSnapshot();
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]).toMatchObject({ source: "agent", title: "1:1", note: "Both free", attendees: [{ address: "bo@example.com" }] });
    store.dismissProposal(state.proposals[0].id);
    await Promise.resolve();
    expect(store.getSnapshot().proposals).toEqual([]);
    expect(await persistence.loadProposals()).toEqual([rows[1]]);
  });

  it("replaces only the same source's proposals", async () => {
    const { store } = setup();
    await store.init();
    store.receiveProposals([{ start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" }], "agent");
    store.findSlots({ maxResults: 1 });
    store.receiveProposals({ proposals: [{ start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z" }] }, "agent");
    expect(store.getSnapshot().proposals.map((proposal) => [proposal.source, proposal.start])).toEqual([
      ["assistant", "2026-11-23T10:00:00-05:00"],
      ["agent", "2026-11-25T15:00:00Z"],
    ]);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const { store } = setup();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    await store.init();
    const seen = calls;
    expect(seen).toBeGreaterThan(0);
    unsubscribe();
    store.shift(1);
    expect(calls).toBe(seen);
    expect(JSON.parse(JSON.stringify(store.getSnapshot()))).toEqual(store.getSnapshot());
  });
});
