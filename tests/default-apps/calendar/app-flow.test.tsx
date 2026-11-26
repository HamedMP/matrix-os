// @vitest-environment jsdom
/**
 * The Calendar app end to end in jsdom: the real App (store, Google adapter,
 * agent panel, composer) on a fake Matrix OS bridge that answers with Google
 * Calendar JSON. It walks spec 2710 acceptance check 6: five views, the
 * free-busy overlay, agent proposals highlighted on the grid, and an invite
 * that goes out only after the owner confirms the named recipients.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../home/apps/calendar/src/App";
import { FakeMatrixOS, HOLIDAYS, OWNER, PRIMARY } from "./app-flow-bridge";

/** Monday 23 November 2026, 10:00 in New York. */
const NOW = Date.parse("2026-11-23T15:00:00Z");

let bridge: FakeMatrixOS;

function seed(host: FakeMatrixOS): void {
  host.tables.calendar_preferences.push({ id: "prefs", name: "preferences", value: { version: 1, timeZone: "America/New_York" } });
  host.events[PRIMARY].push(
    {
      id: "standup1",
      status: "confirmed",
      summary: "Standup",
      start: { dateTime: "2026-11-23T09:00:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-23T09:30:00-05:00", timeZone: "America/New_York" },
      organizer: { email: OWNER, self: true },
    },
    {
      id: "dealreview1",
      status: "confirmed",
      summary: "Deal review",
      location: "Room 4",
      start: { dateTime: "2026-11-24T13:00:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-11-24T14:00:00-05:00", timeZone: "America/New_York" },
      organizer: { email: "sam@example.com" },
      attendees: [
        { email: "sam@example.com", displayName: "Sam Park", organizer: true, responseStatus: "accepted" },
        { email: OWNER, self: true, responseStatus: "needsAction" },
      ],
    },
  );
  host.events[HOLIDAYS].push({ id: "thanksgiving", status: "confirmed", summary: "Thanksgiving Day", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } });
  host.busy = { "ana@example.com": [{ start: "2026-11-25T15:00:00Z", end: "2026-11-25T17:00:00Z" }] };
  // A proposal the agent's tools wrote into the app's table.
  host.tables.calendar_proposals.push({
    id: "p1",
    start_at: "2026-11-25T19:00:00Z",
    end_at: "2026-11-25T20:00:00Z",
    title: "Kickoff with Ana",
    attendees: JSON.stringify([{ address: "ana@example.com", name: "Ana Diaz" }]),
    note: "Both free after lunch",
    calendar_id: null,
    time_zone: "America/New_York",
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  bridge = new FakeMatrixOS();
  seed(bridge);
  (window as unknown as { MatrixOS: FakeMatrixOS }).MatrixOS = bridge;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { MatrixOS?: FakeMatrixOS }).MatrixOS;
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function toolbarButton(name: string): HTMLElement {
  return within(screen.getByRole("toolbar", { name: "Calendar" })).getByRole("button", { name });
}

function columnDays(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".cal-day-column")].map((column) => column.dataset.day ?? "");
}

function dayColumn(day: string): HTMLElement {
  const column = document.querySelector<HTMLElement>(`.cal-day-column[data-day="${day}"]`);
  if (!column) throw new Error(`No column for ${day}`);
  return column;
}

function composer(): HTMLElement {
  return screen.getByRole("form", { name: /New event|Edit event/ });
}

async function mount(): Promise<void> {
  render(<App />);
  await screen.findByRole("button", { name: /^Standup,/ });
  await settle();
}

describe("Calendar app journey", () => {
  it("loads the owner's Google calendars into the week view with agent proposals highlighted", async () => {
    await mount();
    expect(columnDays()).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
    expect(bridge.callsTo("list_calendars")[0]).toMatchObject({ label: "Work Google" });
    expect(bridge.callsTo("list_events").map((call) => call.params.calendarId).sort()).toEqual([HOLIDAYS, PRIMARY].sort());

    const rail = screen.getByRole("region", { name: "Work Google calendars" });
    expect(within(rail).getByText("Holidays in United States")).toBeTruthy();
    expect(within(rail).getByText("Read-only")).toBeTruthy();

    expect(within(dayColumn("2026-11-24")).getByRole("button", { name: /^Deal review, .*Room 4|^Deal review,/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Thanksgiving Day/ })).toBeTruthy();

    const proposal = within(dayColumn("2026-11-25")).getByRole("button", { name: /Suggested time 2:00\s?PM to 3:00\s?PM: Kickoff with Ana/ });
    expect(proposal.className).toContain("cal-proposal--agent");
    expect(screen.getByText("Agent proposals on the grid")).toBeTruthy();
  });

  it("switches through all five views and remembers the choice in the preferences table", async () => {
    await mount();
    fireEvent.click(toolbarButton("Day"));
    await settle();
    expect(columnDays()).toEqual(["2026-11-23"]);

    fireEvent.click(toolbarButton("Work week"));
    await settle();
    expect(columnDays()).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);

    fireEvent.click(toolbarButton("Month"));
    await settle();
    const month = screen.getByRole("region", { name: "Month" });
    expect(within(month).getByRole("button", { name: /^Standup,/ })).toBeTruthy();
    expect(within(month).getByRole("button", { name: /^Thanksgiving Day/ })).toBeTruthy();

    fireEvent.click(toolbarButton("Agenda"));
    await settle();
    const agenda = screen.getByRole("region", { name: "Agenda" });
    expect(within(agenda).getByRole("button", { name: /Deal review/ })).toBeTruthy();
    await waitFor(() => expect(bridge.tables.calendar_preferences[0].value).toMatchObject({ view: "agenda" }));
    expect(bridge.tables.calendar_preferences).toHaveLength(1);

    fireEvent.click(toolbarButton("Week"));
    await settle();
    expect(columnDays()).toHaveLength(7);
  });

  it("turns an agent proposal into an invite with the guest's busy time overlaid, sent only after confirmation", async () => {
    await mount();
    fireEvent.click(within(dayColumn("2026-11-25")).getByRole("button", { name: /Kickoff with Ana/ }));
    await settle();

    expect((within(composer()).getByLabelText("Title") as HTMLInputElement).value).toBe("Kickoff with Ana");
    expect((within(composer()).getByLabelText("Start time") as HTMLInputElement).value).toBe("14:00");
    expect((within(composer()).getByLabelText("End time") as HTMLInputElement).value).toBe("15:00");
    expect(within(within(composer()).getByRole("list", { name: "Guest list" })).getByText(/ana@example.com|Ana Diaz/)).toBeTruthy();

    // Free-busy for the guest is fetched for the visible week and drawn on the grid.
    const freeBusy = bridge.callsTo("free_busy");
    expect(freeBusy.length).toBeGreaterThan(0);
    expect(freeBusy.at(-1)?.params.items).toEqual(["ana@example.com"]);
    const bands = dayColumn("2026-11-25").querySelectorAll(".cal-busy");
    expect(bands).toHaveLength(1);
    expect(bands[0].getAttribute("title")).toMatch(/^ana@example.com/);
    const assistant = within(composer()).getByRole("region", { name: "Scheduling assistant" });
    expect(within(assistant).getByText("ana@example.com")).toBeTruthy();

    // Send invite only asks; Cancel sends nothing.
    fireEvent.click(within(composer()).getByRole("button", { name: "Send invite" }));
    let dialog = screen.getByRole("alertdialog", { name: "Send this invitation?" });
    expect(within(dialog).getByText("ana@example.com")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(bridge.callsTo("create_event_with_attendees")).toHaveLength(0);
    expect(composer()).toBeTruthy();

    fireEvent.click(within(composer()).getByRole("button", { name: "Send invite" }));
    dialog = screen.getByRole("alertdialog", { name: "Send this invitation?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send invite" }));
    await settle();

    const created = bridge.callsTo("create_event_with_attendees");
    expect(created).toHaveLength(1);
    expect(created[0].params).toMatchObject({
      calendarId: PRIMARY,
      summary: "Kickoff with Ana",
      sendUpdates: "all",
      attendees: [{ email: "ana@example.com", displayName: "Ana Diaz" }],
      timeZone: "America/New_York",
    });
    expect(Date.parse(String(created[0].params.start))).toBe(Date.parse("2026-11-25T19:00:00Z"));

    // The composer closes, the event is on the grid, the proposal and its row are gone.
    expect(screen.queryByRole("form", { name: "New event" })).toBeNull();
    expect(within(dayColumn("2026-11-25")).getByRole("button", { name: /^Kickoff with Ana,/ })).toBeTruthy();
    expect(document.querySelector(".cal-proposal")).toBeNull();
    expect(document.querySelector(".cal-busy")).toBeNull();
    await waitFor(() => expect(bridge.tables.calendar_proposals).toHaveLength(0));
  });

  it("shows proposals the agent writes later, and the assistant panel places new ones without writing", async () => {
    await mount();
    await act(async () => {
      await bridge.writeRow("calendar_proposals", {
        id: "p2",
        start_at: "2026-11-27T15:00:00Z",
        end_at: "2026-11-27T15:30:00Z",
        title: "Follow-up",
        attendees: "[]",
        note: "",
        calendar_id: null,
        time_zone: null,
      });
    });
    await settle();
    expect(within(dayColumn("2026-11-27")).getByRole("button", { name: /Suggested time .*Follow-up/ })).toBeTruthy();

    bridge.aiReply = () => JSON.stringify({ intent: "propose_times", title: "Sync with Ana", attendees: ["ana@example.com"], durationMinutes: 60, count: 2 });
    fireEvent.click(toolbarButton("Agent"));
    const panel = screen.getByRole("complementary", { name: "Agent" });
    const box = await within(panel).findByRole("textbox", { name: "Ask the agent" }, { timeout: 5000 });
    fireEvent.change(box, { target: { value: "propose two times for a sync with Ana this week" } });
    fireEvent.keyDown(box, { key: "Enter" });

    const card = await within(panel).findByRole("article", { name: "Suggested times" });
    await settle();
    expect(bridge.prompts).toHaveLength(1);
    expect(bridge.prompts[0]).toContain("propose two times for a sync with Ana this week");
    expect(bridge.callsTo("free_busy").at(-1)?.params.items).toEqual(["ana@example.com"]);
    // The panel's free-busy lookup goes to the provider and leaves the grid without overlays.
    expect(document.querySelector(".cal-busy")).toBeNull();

    const slots = within(card).getAllByRole("button", { name: /^Open draft for / });
    expect(slots).toHaveLength(2);
    const agentBlocks = [...document.querySelectorAll<HTMLElement>(".cal-proposal--agent")];
    expect(agentBlocks).toHaveLength(2);
    expect(agentBlocks.every((block) => /Sync with Ana/.test(block.getAttribute("aria-label") ?? ""))).toBe(true);
    // Ana is busy 10:00-12:00 New York on Wednesday; no suggestion overlaps it.
    for (const block of agentBlocks) {
      expect(block.closest<HTMLElement>(".cal-day-column")?.dataset.day === "2026-11-25"
        && /1[01]:\d\d\s?AM/.test(block.getAttribute("aria-label") ?? "")).toBe(false);
    }

    fireEvent.click(slots[0]);
    await settle();
    expect((within(composer()).getByLabelText("Title") as HTMLInputElement).value).toBe("Sync with Ana");
    expect(within(composer()).getByRole("button", { name: "Send invite" })).toBeTruthy();
    expect(bridge.callsTo("create_event_with_attendees")).toHaveLength(0);
    expect(bridge.calls.every((call) => ["list_calendars", "list_events", "free_busy"].includes(call.action))).toBe(true);

    // Cancelling the draft brings the assistant back with its answer, so another time can be picked.
    fireEvent.click(within(composer()).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(screen.queryByRole("form", { name: "New event" })).toBeNull();
    const back = within(screen.getByRole("complementary", { name: "Agent" })).getByRole("article", { name: "Suggested times" });
    const again = within(back).getAllByRole("button", { name: /^Open draft for / });
    expect(again).toHaveLength(2);
    fireEvent.click(again[1]);
    await settle();
    expect((within(composer()).getByLabelText("Title") as HTMLInputElement).value).toBe("Sync with Ana");
    expect(bridge.prompts).toHaveLength(1);
  });

  it("focuses the chosen time on the grid from an agent answer: the drawn proposal, or a marker for free times", async () => {
    await mount();
    fireEvent.click(toolbarButton("Agent"));
    const panel = screen.getByRole("complementary", { name: "Agent" });
    const box = await within(panel).findByRole("textbox", { name: "Ask the agent" }, { timeout: 5000 });
    const ask = async (text: string, reply: unknown, title: string) => {
      bridge.aiReply = () => JSON.stringify(reply);
      fireEvent.change(box, { target: { value: text } });
      fireEvent.keyDown(box, { key: "Enter" });
      const cards = await within(panel).findAllByRole("article", { name: title });
      await settle();
      return cards.at(-1) as HTMLElement;
    };

    const proposals = await ask("propose two times for a sync with Ana", { intent: "propose_times", title: "Sync with Ana", attendees: ["ana@example.com"], durationMinutes: 60, count: 2 }, "Suggested times");
    const showSecond = within(proposals).getAllByRole("button", { name: /^Show .* on the calendar$/ })[1];
    fireEvent.click(showSecond);
    await settle();
    const drawn = [...document.querySelectorAll<HTMLElement>(".cal-proposal--agent")];
    expect(drawn).toHaveLength(2);
    expect(document.activeElement).toBe(drawn[1]);
    expect(showSecond.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".cal-marker")).toBeNull();

    const free = await ask("when am I free with Ana", { intent: "find_slots", attendees: ["ana@example.com"], durationMinutes: 30, count: 2 }, "Free times");
    const showFree = within(free).getAllByRole("button", { name: /^Show .* on the calendar$/ })[0];
    fireEvent.click(showFree);
    await settle();
    const marker = document.querySelector<HTMLElement>(".cal-marker");
    expect(marker).not.toBeNull();
    expect(document.activeElement).toBe(marker);
    expect(marker?.getAttribute("aria-label")).toMatch(/^Selected time /);
    expect(showFree.getAttribute("aria-pressed")).toBe("true");

    // Closing the agent panel takes its marker away.
    fireEvent.click(toolbarButton("Agent"));
    await settle();
    expect(document.querySelector(".cal-marker")).toBeNull();
  });

  // Outcome: a guest outside the owner's organisation shows as "availability unknown", calmly.
  // Fault: Google's per-calendar error for a calendar the owner cannot see turns into
  // "Something went wrong" in the scheduling assistant.
  it("shows a guest whose calendar cannot be seen as availability unknown, not as an error", async () => {
    bridge.busyHidden = ["bo@other.org"];
    await mount();
    fireEvent.click(toolbarButton("New event"));
    await settle();
    const field = within(composer()).getByLabelText("Guests");
    fireEvent.change(field, { target: { value: "ana@example.com, bo@other.org" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();

    expect(bridge.callsTo("free_busy").at(-1)?.params.items).toEqual(["ana@example.com", "bo@other.org"]);
    const assistant = within(composer()).getByRole("region", { name: "Scheduling assistant" });
    expect(within(assistant).queryByRole("alert")).toBeNull();
    expect(assistant.textContent).not.toMatch(/went wrong/i);
    const legend = within(assistant).getByRole("list", { name: "Busy time colours" });
    const bo = within(legend).getByText("bo@other.org").closest("li");
    expect(bo?.textContent).toContain("Availability unknown");
    const ana = within(legend).getByText("ana@example.com").closest("li");
    expect(ana?.textContent).not.toContain("Availability unknown");
    // Unknown time counts as busy, and the empty suggestion list says why.
    expect(assistant.textContent).toContain("Guests with unknown availability count as busy.");
  });

  // Outcome: an account the host lists under its default label is named by its address.
  // Fault: the rail heading shows the raw service slug `google_calendar`.
  it("names an account with the host's default label by its address, not the service slug", async () => {
    bridge.integrations = async () => [{ service: "google_calendar", account_label: "google_calendar", account_email: OWNER, status: "active" }];
    await mount();
    const rail = screen.getByRole("region", { name: `${OWNER} calendars` });
    expect(within(rail).getByRole("heading", { name: new RegExp(OWNER) })).toBeTruthy();
    expect(screen.queryByText(/google_calendar/)).toBeNull();
  });

  it("shows the connect empty state when no calendar account is connected", async () => {
    bridge.integrations = async () => [];
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a calendar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(bridge.calls).toHaveLength(0);
  });

  it("shows the same connect state, and calls nothing, when only an Outlook calendar is connected", async () => {
    bridge.integrations = async () => [{ service: "microsoft_outlook_calendar", account_label: "me@contoso.com", account_email: "me@contoso.com", status: "active" }];
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a calendar" })).toBeTruthy();
    expect(screen.getByText(/Connect Google Calendar in Settings, Integrations\./)).toBeTruthy();
    expect(screen.queryByText(/Outlook/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bridge.calls).toHaveLength(0);
  });
});
