// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryPersistence } from "../../../../home/apps/calendar/src/model/preferences";
import { createCalendarStore } from "../../../../home/apps/calendar/src/model/store";
import { CalendarAgentPanel, type CalendarHighlight } from "../../../../home/apps/calendar/src/ui/agent";
import { calendarInfo, FakeCalendarProvider } from "../model/fake-provider";
import { event } from "../model/fixtures";

afterEach(cleanup);

// Monday 23 November 2026, 10:00 in New York.
const NOW = Date.parse("2026-11-23T15:00:00Z");
const ACCOUNT = { id: "google:me@example.com", provider: "google" as const, address: "me@example.com", displayName: "Me" };
const ME = { address: "me@example.com", name: "Me", response: "accepted" as const, organizer: true };
const WRITES = ["createEvent", "updateEvent", "deleteEvent", "respond"];

async function setup(reply: (prompt: string) => string | Promise<string>) {
  const provider = new FakeCalendarProvider([calendarInfo("work", { primary: true })]);
  provider.events = [
    event({ id: "work/deal", calendarId: "work", title: "Deal team sync", start: "2026-11-24T16:00:00Z", end: "2026-11-24T17:00:00Z",
      attendees: [ME, { address: "ana@example.com", name: "Ana Diaz", response: "accepted", organizer: false }] }),
    event({ id: "work/lunch", calendarId: "work", title: "Lunch", start: "2026-11-24T17:00:00Z", end: "2026-11-24T18:00:00Z" }),
    event({ id: "work/oneonone", calendarId: "work", title: "1:1 with Sam", start: "2026-11-26T15:00:00Z", end: "2026-11-26T15:30:00Z",
      attendees: [ME, { address: "sam@example.com", name: "Sam Park", response: "accepted", organizer: false }] }),
  ];
  const store = createCalendarStore({
    connect: async () => [{ account: ACCOUNT, provider }],
    persistence: createMemoryPersistence({ preferences: { timeZone: "America/New_York" } }),
    now: () => NOW,
    log: () => undefined,
  });
  await store.init();
  const generate = vi.fn(async (prompt: string) => reply(prompt));
  const onHighlight = vi.fn<(target: CalendarHighlight) => void>();
  const view = render(<CalendarAgentPanel store={store} generate={generate} getFreeBusy={(a, s, e) => provider.getFreeBusy(a, s, e)} onHighlight={onHighlight} now={() => NOW} />);
  return { store, provider, generate, onHighlight, view };
}

function aliasFor(prompt: string, title: string): string {
  const line = prompt.split("\n").find((item) => item.includes(`"${title}"`)) ?? "";
  return /^\[(e\d+)\]/.exec(line)?.[1] ?? "e0";
}

function ask(text: string) {
  const box = screen.getByRole("textbox", { name: "Ask the agent" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("CalendarAgentPanel", () => {
  it("answers an agenda question with event chips that highlight the event and move the grid to its day", async () => {
    const { store, onHighlight } = await setup(() => "{\"intent\":\"agenda\",\"window\":{\"type\":\"day\",\"date\":{\"type\":\"tomorrow\"}}}");
    store.setView("day");
    ask("what is on tomorrow");
    const card = await screen.findByRole("article", { name: "Your agenda" });
    expect(within(card).getByText("2 events on your calendar for Tue 24 Nov.")).toBeTruthy();
    expect(within(card).getByText("You asked: what is on tomorrow")).toBeTruthy();
    const chip = within(card).getByRole("button", { name: /Deal team sync/ });
    fireEvent.click(chip);
    expect(onHighlight).toHaveBeenCalledWith({ type: "event", id: "work/deal", start: "2026-11-24T16:00:00Z", end: "2026-11-24T17:00:00Z" });
    expect(store.getSnapshot().range.anchor).toBe("2026-11-24");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the agent's draft in the composer and sends nothing", async () => {
    const { store, provider } = await setup((prompt) => JSON.stringify({
      intent: "draft_event",
      title: "Closing call",
      attendeesFromEvent: aliasFor(prompt, "Deal team sync"),
      recurrence: { freq: "weekly", interval: 1, until: { type: "day_of_month", day: 30 } },
    }));
    ask("set up a weekly closing call with the deal team until the 30th");
    const card = await screen.findByRole("article", { name: "Event draft" });
    expect(store.getSnapshot().draft).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Open draft" }));
    const draft = store.getSnapshot().draft;
    expect(draft?.mode).toBe("create");
    expect(draft?.draft).toMatchObject({
      calendarId: "work",
      title: "Closing call",
      start: "2026-11-23T10:00:00-05:00",
      end: "2026-11-23T10:30:00-05:00",
      attendees: [{ address: "ana@example.com" }],
      recurrence: { freq: "weekly", interval: 1, until: "2026-11-30T23:59:59-05:00" },
    });
    expect(draft?.issues).toEqual([]);
    expect(provider.calls.filter((call) => WRITES.includes(call.method))).toEqual([]);
  });

  it("places suggested times on the grid as agent proposals and opens one as a draft", async () => {
    const { store, provider } = await setup(() => JSON.stringify({ intent: "propose_times", title: "Kickoff", attendees: ["ana@example.com"], durationMinutes: 60, count: 2 }));
    ask("propose two times for a kickoff with Ana");
    const card = await screen.findByRole("article", { name: "Suggested times" });
    const proposals = store.getSnapshot().proposals;
    expect(proposals.map((proposal) => [proposal.source, proposal.title])).toEqual([["agent", "Kickoff"], ["agent", "Kickoff"]]);
    const opens = within(card).getAllByRole("button", { name: /^Open draft for / });
    expect(opens).toHaveLength(2);
    fireEvent.click(opens[0]);
    expect(store.getSnapshot().draft).toMatchObject({ proposalId: proposals[0].id, draft: { title: "Kickoff", start: proposals[0].start } });
    expect(provider.calls.filter((call) => WRITES.includes(call.method))).toEqual([]);
  });

  it("opens a reschedule as the event's edit draft at the chosen time", async () => {
    const { store, provider, onHighlight } = await setup((prompt) => JSON.stringify({ intent: "reschedule", event: aliasFor(prompt, "1:1 with Sam"), window: { type: "this_week" } }));
    ask("move my Thursday one-on-one to a slot we are both free");
    const card = await screen.findByRole("article", { name: "New times for 1:1 with Sam" });
    const show = within(card).getAllByRole("button", { name: /^Show / })[0];
    fireEvent.click(show);
    const target = onHighlight.mock.calls[0][0];
    expect(target.type).toBe("slot");
    fireEvent.click(within(card).getAllByRole("button", { name: /^Open draft for / })[0]);
    const draft = store.getSnapshot().draft;
    expect(draft).toMatchObject({ mode: "edit", eventId: "work/oneonone" });
    expect(Date.parse(draft?.draft.start ?? "")).toBe(Date.parse(target.start));
    expect(Date.parse(draft?.draft.end ?? "")).toBe(Date.parse(target.end));
    expect(provider.calls.filter((call) => WRITES.includes(call.method))).toEqual([]);
  });

  // Outcome: closing the assistant while it is answering drops that answer; nothing it suggested lands on the grid later.
  // Fault: the pending answer still passes the request check and replaces the grid's proposals after the panel is gone.
  it("drops a pending answer when the panel closes, so it never places proposals afterwards", async () => {
    let answer: (reply: string) => void = () => undefined;
    const { store, generate, view } = await setup(() => new Promise<string>((resolve) => {
      answer = resolve;
    }));
    ask("propose two times for a kickoff with Ana");
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    view.unmount();
    answer(JSON.stringify({ intent: "propose_times", title: "Kickoff", attendees: ["ana@example.com"], durationMinutes: 60, count: 2 }));
    // Let the agent finish its calendar reads and settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getSnapshot().proposals).toEqual([]);
  });

  // Outcome: the grid stays where the owner left it when the assistant closes before it has read the calendar.
  // Fault: the closed request still reads its window and moves the grid to that window's first day.
  it("leaves the grid where it is when a request finishes after the panel closed", async () => {
    let answer: (reply: string) => void = () => undefined;
    const { store, generate, view } = await setup(() => new Promise<string>((resolve) => {
      answer = resolve;
    }));
    store.setView("day");
    ask("what is on next month");
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    view.unmount();
    answer(JSON.stringify({ intent: "agenda", window: { type: "day", date: { type: "date", date: "2026-12-15" } } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getSnapshot().range.anchor).toBe("2026-11-23");
  });

  it("shows a fixed message when the model fails, then keeps working", async () => {
    let fail = true;
    await setup(() => {
      if (fail) throw new Error("internal route detail");
      return "{\"intent\":\"agenda\"}";
    });
    ask("what is on tomorrow");
    const card = await screen.findByRole("article", { name: "Something went wrong" });
    expect(within(card).getByText("The assistant is not available right now. Try again.")).toBeTruthy();
    expect(screen.queryByText(/internal route detail/)).toBeNull();
    fail = false;
    ask("what is on today");
    await waitFor(() => expect(screen.getByRole("article", { name: "Your agenda" })).toBeTruthy());
  });
});
