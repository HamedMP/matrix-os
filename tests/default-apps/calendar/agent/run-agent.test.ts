import { describe, expect, it } from "vitest";
import { instantToMs, instantsOverlap } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import {
  runCalendarAgent,
  UNAVAILABLE_MESSAGE,
  type CalendarAgentAnswer,
  type CalendarAgentContext,
  type CalendarAgentDeps,
} from "../../../../home/apps/calendar/src/agent";
import { DEFAULT_WORKING_HOURS } from "../../../../home/apps/calendar/src/model/slots";
import { calendarInfo, FakeCalendarProvider } from "../model/fake-provider";
import { event } from "../model/fixtures";

// Monday 23 November 2026, 10:00 in New York.
const NOW = Date.parse("2026-11-23T15:00:00Z");
const ME = { address: "me@example.com", name: "Me", response: "accepted" as const, organizer: true };
const person = (address: string, name: string) => ({ address, name, response: "accepted" as const, organizer: false });

function setup(reply: string | ((prompt: string) => string | Promise<string>)) {
  const provider = new FakeCalendarProvider([calendarInfo("work", { primary: true }), calendarInfo("holidays", { writable: false })]);
  provider.events = [
    event({ id: "work/standup", calendarId: "work", title: "Standup", start: "2026-11-23T14:00:00Z", end: "2026-11-23T14:30:00Z" }),
    event({ id: "work/deal", calendarId: "work", title: "Deal team sync", start: "2026-11-24T16:00:00Z", end: "2026-11-24T17:00:00Z",
      attendees: [ME, person("ana@example.com", "Ana Diaz"), person("bo@example.com", "Bo Chen")] }),
    event({ id: "work/lunch", calendarId: "work", title: "Lunch", start: "2026-11-24T17:00:00Z", end: "2026-11-24T18:00:00Z" }),
    event({ id: "work/oneonone", calendarId: "work", title: "1:1 with Sam", start: "2026-11-26T15:00:00Z", end: "2026-11-26T15:30:00Z",
      attendees: [ME, person("sam@example.com", "Sam Park")] }),
  ];
  provider.busy = [
    { address: "ana@example.com", start: "2026-11-23T15:00:00Z", end: "2026-11-23T22:00:00Z" },
    { address: "sam@example.com", start: "2026-11-23T05:00:00Z", end: "2026-11-26T05:00:00Z" },
    { address: "sam@example.com", start: "2026-11-26T14:00:00Z", end: "2026-11-26T15:00:00Z" },
  ];
  const prompts: string[] = [];
  const logged: string[] = [];
  const touched = new Set<string>();
  const base: CalendarAgentDeps = {
    async generate(prompt) {
      prompts.push(prompt);
      return typeof reply === "function" ? reply(prompt) : reply;
    },
    listEvents: (start, end) => provider.listEvents({ calendarIds: ["work", "holidays"], start, end }),
    getFreeBusy: (addresses, start, end) => provider.getFreeBusy(addresses, start, end),
    log: (action) => logged.push(action),
  };
  // Records every member the agent reaches for, to prove it only reads.
  const deps = new Proxy(base, {
    get(target, key, receiver) {
      touched.add(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  const context: CalendarAgentContext = {
    now: NOW,
    timeZone: "America/New_York",
    weekStart: 1,
    workingHours: DEFAULT_WORKING_HOURS,
    defaultDurationMinutes: 30,
    ownerAddress: "me@example.com",
    calendars: provider.calendars,
    events: provider.events,
    assistantAttendees: [],
  };
  return { provider, deps, context, prompts, logged, touched };
}

/** The prompt alias of the event whose line mentions `title`. */
function aliasFor(prompt: string, title: string): string {
  const line = prompt.split("\n").find((item) => item.includes(`"${title}"`));
  const match = line ? /^\[(e\d+)\]/.exec(line) : null;
  if (!match) throw new Error(`No alias for ${title}`);
  return match[1];
}

function expectFreeOf(answer: CalendarAgentAnswer, busy: Array<{ start: string; end: string }>) {
  for (const slot of answer.slots) {
    expect(instantToMs(slot.start)).toBeGreaterThanOrEqual(NOW);
    for (const block of busy) expect(instantsOverlap(slot.start, slot.end, block.start, block.end)).toBe(false);
  }
}

describe("calendar agent: read requests", () => {
  it("answers 'when are we all free this week' with slots everyone is free, by id", async () => {
    const { deps, context, provider } = setup(JSON.stringify({
      intent: "find_slots", attendees: ["Ana"], durationMinutes: 60, window: { type: "this_week" },
    }));
    const answer = await runCalendarAgent("when are we all free this week", context, deps);
    expect(answer.kind).toBe("slots");
    if (answer.kind !== "slots") return;
    expect(answer.attendees).toEqual(["ana@example.com"]);
    expect(answer.slots.length).toBe(5);
    expect(answer.slots[0]).toEqual({ id: `slot-${Date.parse("2026-11-24T14:00:00Z")}-${Date.parse("2026-11-24T15:00:00Z")}`, start: "2026-11-24T09:00:00-05:00", end: "2026-11-24T10:00:00-05:00" });
    expectFreeOf(answer, [...provider.busy.filter((block) => block.address === "ana@example.com"), ...provider.events]);
    expect(answer.window.end).toBe("2026-11-30T00:00:00-05:00");
    expect(provider.callsTo("getFreeBusy")[0].args[0]).toEqual(["ana@example.com"]);
  });

  it("finds a two-hour window before Friday from now, inside working hours", async () => {
    const { deps, context, provider } = setup(JSON.stringify({
      intent: "find_slots", durationMinutes: 120, window: { type: "before", date: { type: "weekday", day: "friday" } }, count: 3,
    }));
    const answer = await runCalendarAgent("find a two-hour window before Friday", context, deps);
    expect(answer.kind).toBe("slots");
    // Distinct choices: each two-hour window starts where the previous one ends.
    expect(answer.slots.map((slot) => slot.start)).toEqual(["2026-11-23T10:00:00-05:00", "2026-11-23T12:00:00-05:00", "2026-11-23T14:00:00-05:00"]);
    expectFreeOf(answer, provider.events);
    expect(provider.callsTo("getFreeBusy")).toHaveLength(0);
  });

  it("lists what is on tomorrow with event ids to highlight", async () => {
    const { deps, context } = setup("{\"intent\":\"agenda\",\"window\":{\"type\":\"day\",\"date\":{\"type\":\"tomorrow\"}}}");
    const answer = await runCalendarAgent("what is on tomorrow", context, deps);
    expect(answer.kind).toBe("agenda");
    expect(answer.events.map((item) => item.id)).toEqual(["work/deal", "work/lunch"]);
    expect(answer.text).toBe("2 events on your calendar for Tue 24 Nov.");
  });

  it("counts people whose availability cannot be read as busy and says so", async () => {
    const { deps, context, provider, logged } = setup(JSON.stringify({ intent: "find_slots", attendees: ["sam@example.com", "Zed"], window: { type: "this_week" } }));
    provider.getFreeBusy = async () => {
      throw new Error("provider exploded with secret detail");
    };
    const answer = await runCalendarAgent("when can Sam and Zed meet", context, deps);
    expect(answer.slots).toEqual([]);
    expect(answer.notes.join(" ")).toContain("Availability is unknown for sam@example.com");
    expect(answer.notes.join(" ")).toContain("could not find an address for Zed");
    expect(answer.notes.join(" ")).not.toContain("secret");
    expect(logged).toContain("agent: free-busy");
  });
});

describe("calendar agent: write requests only ever yield drafts or proposals", () => {
  it("drafts a weekly closing call with the deal team until the 30th, at the first common free slot", async () => {
    const { deps, context, provider } = setup((prompt) => JSON.stringify({
      intent: "draft_event",
      title: "Closing call",
      attendeesFromEvent: aliasFor(prompt, "Deal team sync"),
      recurrence: { freq: "weekly", interval: 1, until: { type: "day_of_month", day: 30 } },
    }));
    const answer = await runCalendarAgent("set up a weekly closing call with the deal team until the 30th", context, deps);
    expect(answer.kind).toBe("draft");
    if (answer.kind !== "draft") return;
    expect(answer.draft).toEqual({
      calendarId: "work",
      title: "Closing call",
      start: "2026-11-24T09:00:00-05:00",
      end: "2026-11-24T09:30:00-05:00",
      allDay: false,
      timeZone: "America/New_York",
      location: "",
      descriptionText: "",
      attendees: [{ address: "ana@example.com" }, { address: "bo@example.com" }],
      addOnlineMeeting: false,
      recurrence: { freq: "weekly", interval: 1, until: "2026-11-30T23:59:59-05:00" },
    });
    expect(answer.text).toContain("Nothing is sent");
    expect(provider.calls.map((call) => call.method).every((method) => method === "listEvents" || method === "getFreeBusy")).toBe(true);
  });

  it("drafts at the exact day and time the owner named", async () => {
    const { deps, context } = setup(JSON.stringify({
      intent: "draft_event", title: "Review", date: { type: "weekday", day: "wednesday" }, time: "14:00", durationMinutes: 45, attendees: ["bo@example.com"],
    }));
    const answer = await runCalendarAgent("review with bo on wednesday at 2pm for 45 minutes", context, deps);
    expect(answer.kind === "draft" && [answer.draft.start, answer.draft.end]).toEqual(["2026-11-25T14:00:00-05:00", "2026-11-25T14:45:00-05:00"]);
  });

  it("moves the Thursday one-on-one to a time both people are free, never its current time", async () => {
    const { deps, context, provider } = setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam") }));
    const answer = await runCalendarAgent("move my Thursday one-on-one to a slot we are both free", context, deps);
    expect(answer.kind).toBe("reschedule");
    if (answer.kind !== "reschedule") return;
    expect(answer.eventId).toBe("work/oneonone");
    expect(answer.durationMinutes).toBe(30);
    expect(answer.events.map((item) => item.id)).toEqual(["work/oneonone"]);
    expect(answer.slots.map((slot) => slot.start)).toEqual(["2026-11-26T10:30:00-05:00", "2026-11-26T11:00:00-05:00", "2026-11-26T11:30:00-05:00"]);
    expectFreeOf(answer, provider.busy.filter((block) => block.address === "sam@example.com"));
    expect(provider.callsTo("getFreeBusy")[0].args[0]).toEqual(["sam@example.com"]);
  });

  // Outcome: moving an event keeps its length, however long or short it is.
  // Fault: the length is clamped to 5 minutes..24 hours, so a two-day event becomes a one-day draft.
  it("keeps a two-day or a three-minute event's exact length when moving it to a named time", async () => {
    for (const [title, start, end] of [
      ["Offsite", "2026-11-25T14:00:00Z", "2026-11-27T14:00:00Z"],
      ["Quick check", "2026-11-25T14:00:00Z", "2026-11-25T14:03:00Z"],
    ] as const) {
      const { deps, context, provider } = setup((prompt) => JSON.stringify({
        intent: "reschedule", event: aliasFor(prompt, title), date: { type: "date", date: "2026-12-01" }, time: "09:00",
      }));
      provider.events.push(event({ id: `work/${title}`, calendarId: "work", title, start, end }));
      const answer = await runCalendarAgent(`move ${title} to 1 December at 9`, { ...context, events: provider.events }, deps);
      expect(answer.kind).toBe("reschedule");
      if (answer.kind !== "reschedule") return;
      const [slot] = answer.slots;
      expect(slot.start).toBe("2026-12-01T09:00:00-05:00");
      expect(instantToMs(slot.end) - instantToMs(slot.start)).toBe(instantToMs(end) - instantToMs(start));
      expect(answer.durationMinutes).toBe((instantToMs(end) - instantToMs(start)) / 60_000);
    }
  });

  // Outcome: the agent says why it cannot search free time for an event longer than the working day, and changes nothing.
  // Fault: the search runs with a shortened length, or reports that nobody is free.
  it("explains that it cannot search free time for an event longer than the working day", async () => {
    const { deps, context, provider } = setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "Offsite") }));
    provider.events.push(event({ id: "work/offsite", calendarId: "work", title: "Offsite", start: "2026-11-25T14:00:00Z", end: "2026-11-27T14:00:00Z" }));
    const answer = await runCalendarAgent("find another time for the offsite", { ...context, events: provider.events }, deps);
    expect(answer).toMatchObject({ kind: "clarify", slots: [] });
    expect(answer.text).toBe("\"Offsite\" lasts 48 hours, longer than your working hours, so I cannot look for a free time for it. Tell me the date and time to move it to.");
    expect(provider.callsTo("getFreeBusy")).toEqual([]);
  });

  it("places proposals from the agent source on the calendar's default writable calendar", async () => {
    const { deps, context } = setup(JSON.stringify({ intent: "propose_times", title: "Kickoff", attendees: ["Bo Chen"], durationMinutes: 60, count: 2 }));
    const answer = await runCalendarAgent("propose two times for a kickoff with Bo", context, deps);
    expect(answer.kind).toBe("proposals");
    if (answer.kind !== "proposals") return;
    expect(answer.proposals).toHaveLength(2);
    expect(answer.proposals[0]).toMatchObject({
      source: "agent", title: "Kickoff", calendarId: "work", timeZone: "America/New_York", attendees: [{ address: "bo@example.com" }],
    });
    expect(answer.proposals[0].id).toMatch(/^agent:\d+-\d+$/);
    expect(answer.proposals[0].rowId).toBeUndefined();
  });

  it("only ever reads, whatever the write request", async () => {
    const replies = [
      (prompt: string) => JSON.stringify({ intent: "draft_event", title: "X", attendeesFromEvent: aliasFor(prompt, "Deal team sync"), recurrence: { freq: "weekly", interval: 1 } }),
      (prompt: string) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), date: { type: "tomorrow" }, time: "16:00" }),
      () => JSON.stringify({ intent: "propose_times", title: "Y", attendees: ["ana@example.com"] }),
    ];
    for (const reply of replies) {
      const { deps, context, provider, touched } = setup(reply);
      const answer = await runCalendarAgent("do it and send the invites now", context, deps);
      expect(["draft", "reschedule", "proposals"]).toContain(answer.kind);
      expect([...touched].every((key) => ["generate", "listEvents", "getFreeBusy", "log"].includes(key))).toBe(true);
      expect(provider.calls.filter((call) => ["createEvent", "updateEvent", "deleteEvent", "respond"].includes(call.method))).toEqual([]);
    }
  });
});

describe("calendar agent: model failures", () => {
  it("returns a fixed message when the model call fails or hangs, and logs it", async () => {
    const failing = setup(() => {
      throw new Error("route not ready: account 1234");
    });
    const answer = await runCalendarAgent("what is on tomorrow", failing.context, failing.deps);
    expect(answer).toMatchObject({ kind: "error", text: UNAVAILABLE_MESSAGE });
    expect(failing.logged).toEqual(["agent: generate"]);

    const hanging = setup(() => new Promise<string>(() => undefined));
    expect(await runCalendarAgent("what is on tomorrow", hanging.context, hanging.deps, { timeoutMs: 20 })).toMatchObject({ kind: "error" });
  });

  it("asks again when the reply is not a usable intent, and never calls the model for an empty request", async () => {
    const prose = setup("I think you should rest more.");
    expect((await runCalendarAgent("hmm", prose.context, prose.deps)).kind).toBe("clarify");
    const empty = setup("{}");
    expect((await runCalendarAgent("   ", empty.context, empty.deps)).kind).toBe("clarify");
    expect(empty.prompts).toEqual([]);
  });

  it("refuses to move an event on a calendar the owner cannot change", async () => {
    const { deps, context, provider } = setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "Holiday") }));
    provider.events.push(event({ id: "holidays/h", calendarId: "holidays", title: "Holiday", start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z" }));
    const answer = await runCalendarAgent("move the holiday", { ...context, events: provider.events }, deps);
    expect(answer).toMatchObject({ kind: "error", text: "That event is on a calendar you cannot change." });
  });
});
