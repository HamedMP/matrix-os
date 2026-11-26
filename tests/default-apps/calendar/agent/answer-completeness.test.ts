import { describe, expect, it } from "vitest";
import { instantToMs } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { runCalendarAgent, type CalendarAgentDeps } from "../../../../home/apps/calendar/src/agent";
import { event } from "../model/fixtures";
import { aliasFor, ME, person, setup } from "./agent-fixture";

const guests = (count: number) => Array.from({ length: count }, (_, index) => `guest${index + 1}@example.com`);

/** Deps that record every free-busy request and answer that everyone is free. */
function recordingFreeBusy(deps: CalendarAgentDeps) {
  const asked: string[][] = [];
  const recorded: CalendarAgentDeps = { ...deps, getFreeBusy: async (addresses) => {
    asked.push([...addresses]);
    return [];
  } };
  return { deps: recorded, asked };
}

describe("calendar agent: answers keep every field the owner gave", () => {
  // Outcome: "move my 1:1 to 11:00" offers only 11:00, on the next days everyone is free then.
  // Fault: with no date, the named time is dropped and any free slot (10:30) is offered instead.
  it("moves an event to the named time on the days that time is free, never another time", async () => {
    const { deps, context } = setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), time: "11:00" }));
    const answer = await runCalendarAgent("move my 1:1 with Sam to 11:00", context, deps);
    expect(answer.kind).toBe("reschedule");
    // Sam is busy Monday to Wednesday; Saturday and Sunday are outside working days.
    expect(answer.slots.map((slot) => slot.start)).toEqual(["2026-11-26T11:00:00-05:00", "2026-11-27T11:00:00-05:00", "2026-11-30T11:00:00-05:00"]);
    for (const slot of answer.slots) expect(instantToMs(slot.end) - instantToMs(slot.start)).toBe(30 * 60_000);
    expect(answer.text).toContain("11:00");
  });

  // Outcome: when nobody can make the named time on any day, the owner is asked for a date, not offered other times.
  it("asks for a date when the named time is taken on every day, and offers no other time", async () => {
    const { deps, context, provider } = setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), time: "11:00" }));
    provider.busy.push({ address: "sam@example.com", start: "2026-11-23T05:00:00Z", end: "2026-12-02T05:00:00Z" });
    const answer = await runCalendarAgent("move my 1:1 with Sam to 11:00", context, deps);
    expect(answer).toMatchObject({ kind: "reschedule", slots: [] });
    expect(answer.text).toBe("No day when everyone on \"1:1 with Sam\" is free at 11:00, Mon 23 Nov – Mon 30 Nov. Tell me the date to move it to.");
  });

  // Outcome: "a review with Sam at 11:00 this week" is drafted at 11:00 on a day in that week Sam is free.
  // Fault: the window is dropped and the draft lands today at 11:00, when Sam is busy.
  it("drafts at the named time on a day of the named window when everyone is free", async () => {
    const { deps, context } = setup(JSON.stringify({
      intent: "draft_event", title: "Review", attendees: ["sam@example.com"], time: "11:00", window: { type: "this_week" },
    }));
    const answer = await runCalendarAgent("review with sam at 11 this week", context, deps);
    expect(answer.kind === "draft" && [answer.draft.start, answer.draft.end]).toEqual(["2026-11-26T11:00:00-05:00", "2026-11-26T11:30:00-05:00"]);

    // Nobody free at 11:00 that week: the draft keeps 11:00 on the first day and says to check it.
    const busy = setup(JSON.stringify({ intent: "draft_event", title: "Review", attendees: ["sam@example.com"], time: "11:00", window: { type: "this_week" } }));
    busy.provider.busy.push({ address: "sam@example.com", start: "2026-11-23T05:00:00Z", end: "2026-12-02T05:00:00Z" });
    const fallback = await runCalendarAgent("review with sam at 11 this week", busy.context, busy.deps);
    expect(fallback.kind === "draft" && fallback.draft.start).toBe("2026-11-23T11:00:00-05:00");
    expect(fallback.notes).toContain("I found no day when everyone is free at 11:00, so check the time in the draft.");
  });

  // Outcome: asking to change the length or the guests while moving says those stay, rather than dropping them silently.
  it("says a move keeps the event's length and guests when the owner asked to change them", async () => {
    const { deps, context } = setup((prompt) => JSON.stringify({
      intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), date: { type: "tomorrow" }, time: "16:00", durationMinutes: 60, attendees: ["ana@example.com"],
    }));
    const answer = await runCalendarAgent("move my 1:1 to tomorrow at 4 for an hour and add Ana", context, deps);
    expect(answer.kind).toBe("reschedule");
    expect(answer.notes).toContain("Moving \"1:1 with Sam\" keeps its length and guests. Change those in the draft.");
  });
});

describe("calendar agent: shortened lists say they are shortened", () => {
  // Outcome: a month with 70 meetings is reported as 70, and the 50 shown are labelled as part of them.
  // Fault: the list is cut to 50 before counting and reported as "50 events".
  it("counts every event in the range and labels a shortened agenda", async () => {
    const { deps, context, provider } = setup(JSON.stringify({
      intent: "agenda", window: { type: "between", from: { type: "date", date: "2026-12-01" }, to: { type: "date", date: "2026-12-31" } },
    }));
    for (let index = 0; index < 70; index += 1) {
      const startMs = Date.parse("2026-12-01T14:00:00Z") + Math.floor(index / 3) * 86_400_000 + (index % 3) * 3_600_000;
      provider.events.push(event({ id: `work/m${index}`, calendarId: "work", start: new Date(startMs).toISOString(), end: new Date(startMs + 1_800_000).toISOString() }));
    }
    const answer = await runCalendarAgent("what is on in December", context, deps);
    expect(answer.kind).toBe("agenda");
    expect(answer.text).toBe("70 events on your calendar for Tue 1 Dec – Thu 31 Dec. Showing the first 50 of 70.");
    expect(answer.events.map((item) => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => `work/m${index}`));
  });

  it("says the free times listed are the first ones when there may be more", async () => {
    const { deps, context } = setup(JSON.stringify({ intent: "find_slots", attendees: ["Ana"], durationMinutes: 60, window: { type: "this_week" } }));
    const answer = await runCalendarAgent("when are we free this week", context, deps);
    expect(answer.text).toBe("The first 5 times when you and 1 other person are free for 1 hour, Mon 23 Nov – Sun 29 Nov.");
  });

  // Outcome: "when everyone is free" covers every guest of the event being moved.
  // Fault: only the first 20 guests are checked, so guest 21 may be busy at the time offered.
  it("checks every guest of an event it moves, not only the first 20", async () => {
    const setupResult = setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "All hands") }));
    const { provider, context } = setupResult;
    provider.events.push(event({ id: "work/all-hands", calendarId: "work", title: "All hands", start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z",
      attendees: [ME, ...guests(25).map((address) => person(address, ""))] }));
    const { deps, asked } = recordingFreeBusy(setupResult.deps);
    await runCalendarAgent("move the all hands", { ...context, events: provider.events }, deps);
    expect(asked).toEqual([guests(25)]);
  });

  it("checks every person already in the scheduling assistant, not only the first 20", async () => {
    const setupResult = setup(JSON.stringify({ intent: "find_slots", window: { type: "this_week" } }));
    const { deps, asked } = recordingFreeBusy(setupResult.deps);
    await runCalendarAgent("when are we all free", { ...setupResult.context, assistantAttendees: guests(25) }, deps);
    expect(asked).toEqual([guests(25)]);
  });

  // Outcome: people the agent had to leave out are named as left out, never dropped silently.
  it("says when people named in a request or on an event were left out", async () => {
    const named = setup(JSON.stringify({ intent: "find_slots", attendees: guests(25), window: { type: "this_week" } }));
    const many = recordingFreeBusy(named.deps);
    const answer = await runCalendarAgent("when can these 25 people meet", named.context, many.deps);
    expect(many.asked).toEqual([guests(20)]);
    expect(answer.notes).toContain("I used up to 20 of the people you named. Add the others in the draft.");

    const fromEvent = setup((prompt) => JSON.stringify({ intent: "find_slots", attendeesFromEvent: aliasFor(prompt, "Town hall"), window: { type: "this_week" } }));
    fromEvent.provider.events.push(event({ id: "work/town", calendarId: "work", title: "Town hall", start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z",
      attendees: guests(105).map((address) => person(address, "")) }));
    const all = recordingFreeBusy(fromEvent.deps);
    const townAnswer = await runCalendarAgent("when is the town hall crowd free", { ...fromEvent.context, events: fromEvent.provider.events }, all.deps);
    expect(all.asked).toEqual([guests(100)]);
    expect(townAnswer.notes).toContain("An event can have at most 100 guests, so 5 people were left out.");
  });
});
