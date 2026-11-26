import { describe, expect, it } from "vitest";
import { ProviderError } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { createMemoryPersistence } from "../../../../home/apps/calendar/src/model/preferences";
import { createCalendarStore, type CalendarStore } from "../../../../home/apps/calendar/src/model/store";
import { EVENT_SAVING_MESSAGE } from "../../../../home/apps/calendar/src/model/store-writes";
import { calendarInfo, FakeCalendarProvider } from "./fake-provider";
import { event } from "./fixtures";

const NOW = Date.parse("2026-11-23T15:00:00Z"); // Monday 10:00 in New York
const ACCOUNT = { id: "google:me@example.com", provider: "google" as const, address: "me@example.com", displayName: "Me" };

function setup() {
  const provider = new FakeCalendarProvider([calendarInfo("work", { primary: true })]);
  provider.events = [
    event({ id: "work/standup", calendarId: "work", title: "Standup", start: "2026-11-23T14:00:00Z", end: "2026-11-23T14:30:00Z" }),
    event({ id: "work/review", calendarId: "work", title: "Review", start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z" }),
  ];
  const store = createCalendarStore({
    connect: async () => [{ account: ACCOUNT, provider }],
    persistence: createMemoryPersistence({ preferences: { timeZone: "America/New_York" } }),
    now: () => NOW,
    log: () => undefined,
  });
  return { store, provider };
}

function shown(store: CalendarStore, id: string) {
  return store.getSnapshot().events.find((item) => item.id === id);
}

describe("calendar store: refresh keeps what it has until the new reply lands", () => {
  // Outcome: a meeting saved while a refresh fails stays on the grid, so the owner does not save it twice.
  // Fault: refresh drops every cached range first; the confirmed create has nowhere to land when the reload fails.
  it("keeps the shown events and a create confirmed during a refresh that fails", async () => {
    const { store, provider } = setup();
    await store.init();
    store.openDraftForGrid("2026-11-24", 13 * 60, 14 * 60);
    store.patchDraft({ title: "Planning" });
    provider.holdWrites = true;
    const creating = store.saveDraft({ sendInvites: false });
    provider.holdReads = true;
    const refreshing = store.refresh();
    provider.release();
    expect(await creating).toBe(true);
    provider.releaseReads(new ProviderError("failed"));
    await refreshing;

    const state = store.getSnapshot();
    expect(state.eventsStatus).toBe("error");
    expect(state.draft).toBeNull();
    expect(state.events.map((item) => item.title)).toEqual(["Standup", "Planning", "Review"]);
    expect(shown(store, "work/created1")?.title).toBe("Planning");
  });

  // Outcome: refresh still means "read again": another week cached earlier is fetched again when shown.
  it("reads other cached weeks again when they are shown after a refresh", async () => {
    const { store, provider } = setup();
    await store.init();
    store.shift(1);
    await store.loadEvents();
    store.shift(-1);
    await store.loadEvents();
    expect(provider.callsTo("listEvents")).toHaveLength(2);
    await store.refresh();
    expect(provider.callsTo("listEvents")).toHaveLength(3);
    store.shift(1);
    await store.loadEvents();
    expect(provider.callsTo("listEvents")).toHaveLength(4);
  });
});

describe("calendar store: a reply never undoes a write confirmed while it was out", () => {
  // Outcome: whenever the save is confirmed relative to a reload that was asked before it, the saved change stays.
  // Fault: the read closes its record of confirmed writes a few ticks before storing its reply; a write confirmed in that gap is undone.
  it("keeps a confirmed edit for every order of the edit's and the reload's answers", async () => {
    for (let ticks = 0; ticks <= 12; ticks += 1) {
      const { store, provider } = setup();
      await store.init();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const list = provider.listEvents.bind(provider);
      provider.listEvents = async (request) => {
        const events = await list(request);
        await gate;
        return events;
      };
      const update = provider.updateEvent.bind(provider);
      provider.updateEvent = async (eventId, changes, options) => {
        await gate;
        for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
        return update(eventId, changes, options);
      };
      const refreshing = store.refresh();
      const updating = store.updateEvent("work/review", { title: "Review (mine)" }, { sendInvites: false });
      open();
      expect(await updating).toBe(true);
      await refreshing;
      expect({ ticks, title: shown(store, "work/review")?.title }).toEqual({ ticks, title: "Review (mine)" });
    }
  });
});

describe("calendar store: one write per event at a time", () => {
  // Outcome: a failed grid move can never erase a later confirmed edit of the same event.
  // Fault: the draft save ignores the pending move; the move's rollback then restores the event from before both.
  it("refuses to save an edit draft while a move of that event is unconfirmed, then saves it once settled", async () => {
    const { store, provider } = setup();
    await store.init();
    expect(store.openEditDraft("work/standup")).toBe(true);
    store.patchDraft({ title: "Standup (notes)" });
    provider.holdWrites = true;
    provider.failNext = new ProviderError("failed");
    const moving = store.moveEvent("work/standup", Date.parse("2026-11-23T18:00:00Z"), { sendInvites: false });

    expect(await store.saveDraft({ sendInvites: false })).toBe(false);
    expect(store.getSnapshot().draft).toMatchObject({ status: "editing", error: EVENT_SAVING_MESSAGE, draft: { title: "Standup (notes)" } });
    expect(provider.callsTo("updateEvent")).toHaveLength(1);

    provider.release();
    expect(await moving).toBe(false);
    provider.holdWrites = false;
    expect(await store.saveDraft({ sendInvites: false })).toBe(true);
    expect(shown(store, "work/standup")).toMatchObject({ title: "Standup (notes)", start: "2026-11-23T14:00:00Z" });
  });

  // Outcome: every write path waits for the event's unconfirmed write instead of racing it.
  it("refuses an update, move, delete or answer while the event has an unconfirmed write", async () => {
    const { store, provider } = setup();
    await store.init();
    provider.holdWrites = true;
    const deleting = store.deleteEvent("work/review", { sendInvites: false });
    expect(await store.updateEvent("work/review", { title: "X" }, { sendInvites: false })).toBe(false);
    expect(await store.moveEvent("work/review", Date.parse("2026-11-25T18:00:00Z"), { sendInvites: false })).toBe(false);
    expect(await store.deleteEvent("work/review", { sendInvites: false })).toBe(false);
    expect(await store.respond("work/review", "accepted")).toBe(false);
    expect(store.getSnapshot().mutationError).toBe(EVENT_SAVING_MESSAGE);
    expect(provider.calls.filter((call) => ["updateEvent", "deleteEvent", "respond"].includes(call.method))).toHaveLength(1);
    provider.release();
    expect(await deleting).toBe(true);
  });
});

describe("calendar store: a failed write rolls back to the newest known event", () => {
  // Outcome: a failed move shows the event as the provider now holds it, not an older copy.
  // Fault: rollback restores the copy taken when the write began, over a newer one a reload read meanwhile.
  it("restores the version a reload read while the write was out", async () => {
    const { store, provider } = setup();
    await store.init();
    provider.holdWrites = true;
    provider.failNext = new ProviderError("failed");
    const moving = store.moveEvent("work/standup", Date.parse("2026-11-23T18:00:00Z"), { sendInvites: false });
    provider.events = provider.events.map((item) => (item.id === "work/standup" ? { ...item, title: "Standup (renamed elsewhere)" } : item));
    await store.refresh();
    expect(shown(store, "work/standup")?.start).toBe("2026-11-23T18:00:00Z");
    provider.release();
    expect(await moving).toBe(false);
    expect(shown(store, "work/standup")).toMatchObject({ title: "Standup (renamed elsewhere)", start: "2026-11-23T14:00:00Z" });
  });

  // Outcome: an event deleted elsewhere does not come back when the owner's change to it fails.
  it("does not bring back an event a reload no longer listed", async () => {
    const { store, provider } = setup();
    await store.init();
    provider.holdWrites = true;
    provider.failNext = new ProviderError("not_found");
    const updating = store.updateEvent("work/review", { title: "Review (moved)" }, { sendInvites: false });
    provider.events = provider.events.filter((item) => item.id !== "work/review");
    await store.refresh();
    provider.release();
    expect(await updating).toBe(false);
    expect(shown(store, "work/review")).toBeUndefined();
  });

  // Outcome: when two reads answer out of order, rollback restores the copy from the read asked last.
  // Fault: the late answer to the earlier read replaces the newer copy that rollback restores.
  it("restores the copy from the read asked last, whatever order the replies land in", async () => {
    const { store, provider } = setup();
    await store.init();
    provider.holdWrites = true;
    provider.failNext = new ProviderError("failed");
    const updating = store.updateEvent("work/review", { title: "Review (mine)" }, { sendInvites: false });
    const answers: Array<() => void> = [];
    const list = provider.listEvents.bind(provider);
    provider.listEvents = async (request) => {
      const events = await list(request);
      await new Promise<void>((resolve) => answers.push(resolve));
      return events;
    };
    const rename = (title: string) => {
      provider.events = provider.events.map((item) => (item.id === "work/review" ? { ...item, title } : item));
    };
    rename("Review (first)");
    const { start, end } = store.getSnapshot().range;
    const refreshing = store.refresh();
    await Promise.resolve();
    rename("Review (second)");
    const reading = store.readEvents(start, end);
    await Promise.resolve();
    expect(answers).toHaveLength(2);
    answers[1]();
    await reading;
    answers[0]();
    await refreshing;
    provider.release();
    expect(await updating).toBe(false);
    expect(shown(store, "work/review")?.title).toBe("Review (second)");
  });
});
