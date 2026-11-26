/** A calendar, a provider and read-only agent deps shared by the agent suites. */
import { expect } from "vitest";
import { instantToMs, instantsOverlap } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import type { CalendarAgentAnswer, CalendarAgentContext, CalendarAgentDeps } from "../../../../home/apps/calendar/src/agent";
import { DEFAULT_WORKING_HOURS } from "../../../../home/apps/calendar/src/model/slots";
import { calendarInfo, FakeCalendarProvider } from "../model/fake-provider";
import { event } from "../model/fixtures";

// Monday 23 November 2026, 10:00 in New York.
export const NOW = Date.parse("2026-11-23T15:00:00Z");
export const ME = { address: "me@example.com", name: "Me", response: "accepted" as const, organizer: true };
export const person = (address: string, name: string) => ({ address, name, response: "accepted" as const, organizer: false });

export function setup(reply: string | ((prompt: string) => string | Promise<string>)) {
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
export function aliasFor(prompt: string, title: string): string {
  const line = prompt.split("\n").find((item) => item.includes(`"${title}"`));
  const match = line ? /^\[(e\d+)\]/.exec(line) : null;
  if (!match) throw new Error(`No alias for ${title}`);
  return match[1];
}

export function expectFreeOf(answer: CalendarAgentAnswer, busy: Array<{ start: string; end: string }>) {
  for (const slot of answer.slots) {
    expect(instantToMs(slot.start)).toBeGreaterThanOrEqual(NOW);
    for (const block of busy) expect(instantsOverlap(slot.start, slot.end, block.start, block.end)).toBe(false);
  }
}
