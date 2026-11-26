import { describe, expect, it } from "vitest";
import { instantToMs } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { runCalendarAgent, type CalendarAgentAnswer } from "../../../../home/apps/calendar/src/agent";
import { aliasFor, setup } from "./agent-fixture";

// Next week in the fixture: Mon 30 Nov 00:00 to Mon 7 Dec 00:00 in New York.
const NEXT_WEEK = { start: Date.parse("2026-11-30T05:00:00Z"), end: Date.parse("2026-12-07T05:00:00Z") };
const NEXT_WEEK_REF = { type: "next_week" };
const SAM_BUSY_FOR_TWO_WEEKS = { address: "sam@example.com", start: "2026-11-23T05:00:00Z", end: "2026-12-08T05:00:00Z" };

type Reply = (prompt: string) => string;
interface Case {
  name: string;
  reply: Reply;
  /** Length every offered or drafted time must have. */
  minutes: number;
}

const cases: Case[] = [
  { name: "find_slots", minutes: 60, reply: () => JSON.stringify({ intent: "find_slots", attendees: ["sam@example.com"], durationMinutes: 60, window: NEXT_WEEK_REF }) },
  { name: "propose_times", minutes: 60, reply: () => JSON.stringify({ intent: "propose_times", title: "Plan", attendees: ["sam@example.com"], durationMinutes: 60, window: NEXT_WEEK_REF }) },
  { name: "draft_event, no time", minutes: 45, reply: () => JSON.stringify({ intent: "draft_event", title: "Plan", attendees: ["sam@example.com"], durationMinutes: 45, window: NEXT_WEEK_REF }) },
  { name: "draft_event at 11:00", minutes: 45, reply: () => JSON.stringify({ intent: "draft_event", title: "Plan", attendees: ["sam@example.com"], durationMinutes: 45, time: "11:00", window: NEXT_WEEK_REF }) },
  { name: "reschedule, no time", minutes: 30, reply: (prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), window: NEXT_WEEK_REF }) },
  { name: "reschedule at 11:00", minutes: 30, reply: (prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), time: "11:00", window: NEXT_WEEK_REF }) },
];

function offeredTimes(answer: CalendarAgentAnswer): Array<{ start: string; end: string }> {
  return answer.kind === "draft" ? [answer.draft, ...answer.slots] : answer.slots;
}

describe("calendar agent: every answer keeps the window and length the owner asked for", () => {
  // Outcome: whatever the intent, and whether or not anyone is free, nothing is offered or drafted outside "next week",
  // and every time has the requested length.
  // Fault: a fallback (no free slot) drafts "now, rounded up", which is this week, not next week.
  for (const sam of ["free", "busy"] as const) {
    for (const item of cases) {
      it(`${item.name}, Sam ${sam}`, async () => {
        const { deps, context, provider } = setup(item.reply);
        if (sam === "busy") provider.busy.push(SAM_BUSY_FOR_TWO_WEEKS);
        const answer = await runCalendarAgent(`${item.name} next week`, context, deps);
        expect(answer.kind).not.toBe("error");
        for (const time of offeredTimes(answer)) {
          expect(instantToMs(time.start)).toBeGreaterThanOrEqual(NEXT_WEEK.start);
          expect(instantToMs(time.end)).toBeLessThanOrEqual(NEXT_WEEK.end);
          expect(instantToMs(time.end) - instantToMs(time.start)).toBe(item.minutes * 60_000);
        }
      });
    }
  }

  // Outcome: with nobody free next week, the draft starts when next week's working day starts and says to check it.
  it("drafts at the first working-hours start of the window when nobody is free", async () => {
    const { deps, context, provider } = setup(cases[2].reply);
    provider.busy.push(SAM_BUSY_FOR_TWO_WEEKS);
    const answer = await runCalendarAgent("plan with sam next week", context, deps);
    expect(answer.kind === "draft" && [answer.draft.start, answer.draft.end]).toEqual(["2026-11-30T09:00:00-05:00", "2026-11-30T09:45:00-05:00"]);
    expect(answer.notes).toContain("I found no free time for everyone, so pick a time in the draft.");
  });

  // Outcome: "a meeting today" asked after the working day is over is answered with a question, not a draft in the past.
  // Fault: the fallback drafts today at the start of working hours, which has already passed.
  it("asks for a time when no working-hours start is left in the window", async () => {
    const { deps, context } = setup(JSON.stringify({ intent: "draft_event", title: "Plan", date: { type: "today" } }));
    const evening = { ...context, now: Date.parse("2026-11-23T23:00:00Z") };
    const answer = await runCalendarAgent("plan meeting today", evening, deps);
    expect(answer).toMatchObject({ kind: "clarify", text: "I found no 30 min time when everyone is free, Mon 23 Nov. Tell me the time you want." });
  });

  // Outcome: when the calendar cannot be read, the draft says so and does not claim nobody is free.
  it("does not say nobody is free when the calendar could not be read", async () => {
    const { deps, context } = setup(cases[2].reply);
    const failing = { ...deps, listEvents: async () => { throw new Error("offline"); } };
    const answer = await runCalendarAgent("plan with sam next week", context, failing);
    expect(answer.kind === "draft" && answer.draft.start).toBe("2026-11-30T09:00:00-05:00");
    expect(answer.notes).toContain("Could not read your calendar. Try again.");
    expect(answer.notes).not.toContain("I found no free time for everyone, so pick a time in the draft.");
  });

  // Outcome: "move my 1:1 to Thursday at 10:00", its current time, is answered with a question, not offered as a move.
  // Fault: the named date and time are offered even though they are the time the event already has.
  it("does not offer an event's current time as the time to move it to", async () => {
    const { deps, context } = setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), date: { type: "weekday", day: "thursday" }, time: "10:00" }));
    const answer = await runCalendarAgent("move my 1:1 to Thursday at 10", context, deps);
    expect(answer).toMatchObject({ kind: "clarify", text: "\"1:1 with Sam\" is already at Thu 26 Nov 10:00–10:30. Tell me the new time." });
  });
});

describe("calendar agent: a window cut to the longest search says so", () => {
  // Outcome: asking about January to June says the answer covers only the first 62 days.
  // Fault: the window is cut to 62 days silently, so "nothing on" or "no time" reads as true for the whole range.
  const LONG = { type: "between", from: { type: "date", date: "2027-01-01" }, to: { type: "date", date: "2027-06-30" } };
  const CUT_NOTE = "That is more than 62 days, so I looked at Fri 1 Jan – Wed 3 Mar only.";
  const long: Array<[string, Reply]> = [
    ["agenda", () => JSON.stringify({ intent: "agenda", window: LONG })],
    ["find_slots", () => JSON.stringify({ intent: "find_slots", window: LONG })],
    ["propose_times", () => JSON.stringify({ intent: "propose_times", title: "Plan", window: LONG })],
    ["draft_event", () => JSON.stringify({ intent: "draft_event", title: "Plan", window: LONG })],
    ["draft_event at 11:00", () => JSON.stringify({ intent: "draft_event", title: "Plan", time: "11:00", window: LONG })],
    ["reschedule", (prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), window: LONG })],
    ["reschedule at 11:00", (prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), time: "11:00", window: LONG })],
  ];
  for (const [name, reply] of long) {
    it(name, async () => {
      const { deps, context } = setup(reply);
      const answer = await runCalendarAgent(`${name} January to June`, context, deps);
      expect(answer.notes).toContain(CUT_NOTE);
    });
  }

  it("adds no note when the window fits", async () => {
    const { deps, context } = setup(JSON.stringify({ intent: "agenda", window: NEXT_WEEK_REF }));
    const answer = await runCalendarAgent("what is on next week", context, deps);
    expect(answer.notes).toEqual([]);
  });
});
