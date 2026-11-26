// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { event } from "../model/fixtures";
import { baseEvents, dayColumn, eventButton, settle, setup } from "./helpers";

afterEach(cleanup);

describe("calendar events on the grid", () => {
  it("places a timed event in its day column at its wall-clock time", async () => {
    await setup();
    const standup = eventButton("Standup");
    expect(dayColumn("2026-11-23").contains(standup)).toBe(true);
    // 09:00 in New York at 48px per hour.
    expect(standup.style.top).toBe("432px");
    expect(standup.style.height).toBe("24px");
    expect(standup.style.left).toBe("0%");
    expect(standup.style.width).toBe("100%");
    // 18:00 New York on Tuesday, not Wednesday in UTC.
    expect(dayColumn("2026-11-24").contains(eventButton("Dinner"))).toBe(true);
  });

  // Outcome: a 30-minute event reads as one line (title, then its start time when there is room).
  // Fault: the block stacks title and time in two lines that do not fit, so both are cut through.
  it("draws a short event as one line and a longer one with its time and place below the title", async () => {
    const { store } = await setup({
      events: [
        ...baseEvents(),
        event({ id: "work/quick", calendarId: "work", title: "Quick sync", start: "2026-11-25T15:00:00Z", end: "2026-11-25T15:15:00Z" }),
        event({ id: "work/long", calendarId: "work", title: "Planning", location: "Room 4", start: "2026-11-25T17:00:00Z", end: "2026-11-25T18:30:00Z" }),
      ],
    });
    const standup = eventButton("Standup");
    expect(standup.classList.contains("is-compact")).toBe(true);
    expect([...standup.querySelectorAll(".cal-event__title, .cal-event__time, .cal-event__location")].map((part) => part.className))
      .toEqual(["cal-event__title", "cal-event__time"]);
    expect(standup.querySelector(".cal-event__time")?.textContent).toMatch(/^9:00\s?AM$/);
    expect(standup.getAttribute("aria-label")).toMatch(/9:00\s?AM – 9:30\s?AM/);

    const quick = eventButton("Quick sync");
    expect(quick.classList.contains("is-compact") && quick.classList.contains("is-tiny")).toBe(true);

    const planning = eventButton("Planning");
    expect(planning.classList.contains("is-compact")).toBe(false);
    expect(planning.querySelector(".cal-event__time")?.textContent).toMatch(/^12:00\s?PM – 1:30\s?PM$/);
    expect(planning.querySelector(".cal-event__location")?.textContent).toBe("Room 4");

    // A 30-minute suggestion gets the same one-row layout for its label and title.
    act(() => {
      store.receiveProposals([{ start: "2026-11-27T15:00:00Z", end: "2026-11-27T15:30:00Z", title: "Follow-up" }]);
    });
    const suggestion = within(dayColumn("2026-11-27")).getByRole("button", { name: /Suggested time .*Follow-up/ });
    expect(suggestion.classList.contains("is-compact")).toBe(true);
  });

  it("lays overlapping events out side by side and puts all-day events in the bar row", async () => {
    await setup({
      events: [
        ...baseEvents(),
        event({ id: "work/a", calendarId: "work", title: "Design review", start: "2026-11-25T15:00:00Z", end: "2026-11-25T16:00:00Z" }),
        event({ id: "work/b", calendarId: "work", title: "Hiring sync", start: "2026-11-25T15:30:00Z", end: "2026-11-25T16:30:00Z" }),
      ],
    });
    const review = eventButton("Design review");
    const hiring = eventButton("Hiring sync");
    expect([review.style.left, review.style.width]).toEqual(["0%", "50%"]);
    expect([hiring.style.left, hiring.style.width]).toEqual(["50%", "50%"]);
    const allDay = screen.getByRole("group", { name: "All-day events" });
    const offsite = within(allDay).getByRole("button", { name: /^Offsite,/ });
    expect(offsite.style.gridColumn).toBe("4 / 5");
    expect(document.querySelector('.cal-day-column [data-event-id="work/offsite"]')).toBeNull();
  });

  it("hides and shows a calendar's events from the rail checkbox", async () => {
    const { provider } = await setup();
    const rail = screen.getByRole("navigation", { name: "Calendars" });
    expect(within(rail).getByText("Work account")).toBeTruthy();
    const family = within(rail).getByRole("checkbox", { name: "Family" }) as HTMLInputElement;
    expect(family.checked).toBe(true);
    fireEvent.click(family);
    expect(family.checked).toBe(false);
    expect(screen.queryByRole("button", { name: /^Dinner,/ })).toBeNull();
    fireEvent.click(family);
    await settle();
    expect(eventButton("Dinner")).toBeTruthy();
    expect(provider.callsTo("listEvents").length).toBeGreaterThanOrEqual(1);
  });

  it("opens a popover with guests, their answers, a safe join link and answer buttons", async () => {
    const invite = event({
      id: "work/invite",
      calendarId: "work",
      title: "Quarterly review",
      start: "2026-11-25T19:00:00Z",
      end: "2026-11-25T20:00:00Z",
      myResponse: "needsAction",
      onlineMeeting: { provider: "google_meet", joinUrl: "https://meet.example.com/abc" },
      attendees: [
        { address: "boss@example.com", name: "Pat Boss", response: "accepted", organizer: true },
        { address: "me@example.com", name: "", response: "needsAction", organizer: false },
        { address: "sam@example.com", name: "Sam", response: "declined", organizer: false },
      ],
    });
    const { provider } = await setup({ events: [...baseEvents(), invite] });
    fireEvent.click(eventButton("Quarterly review"));
    const popover = screen.getByRole("dialog", { name: "Quarterly review" });
    expect(within(popover).getByText("Pat Boss")).toBeTruthy();
    expect(within(popover).getByText("Organizer")).toBeTruthy();
    expect(within(popover).getByText("Declined")).toBeTruthy();
    expect(within(popover).getByRole("link", { name: /Join meeting/ }).getAttribute("href")).toBe("https://meet.example.com/abc");
    fireEvent.click(within(popover).getByRole("button", { name: "Accept" }));
    await settle();
    expect(provider.callsTo("respond")[0].args).toEqual(["work/invite", "accepted"]);
    expect(within(screen.getByRole("dialog", { name: "Quarterly review" })).getByRole("button", { name: "Accept" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("never links a join URL that is not https", async () => {
    const unsafe = event({
      id: "work/unsafe", calendarId: "work", title: "Odd link", start: "2026-11-24T15:00:00Z", end: "2026-11-24T15:30:00Z",
      onlineMeeting: { provider: "other", joinUrl: "javascript:alert(1)" },
    });
    await setup({ events: [unsafe] });
    fireEvent.click(eventButton("Odd link"));
    expect(screen.queryByRole("link", { name: /Join meeting/ })).toBeNull();
  });

  it("rolls back a moved event when the provider rejects the change", async () => {
    const { provider } = await setup();
    provider.failNext = new (await import("../../../../home/apps/_shared/office-accounts/types/calendar")).ProviderError("failed");
    fireEvent.keyDown(eventButton("Standup"), { key: "ArrowDown", altKey: true });
    await settle();
    expect(provider.callsTo("updateEvent")).toHaveLength(1);
    expect(eventButton("Standup").style.top).toBe("432px");
    expect(screen.getByRole("alert").textContent).toMatch(/\w/);
  });

  it("moves an event without guests at once, and asks before notifying guests of a move", async () => {
    const meeting = event({
      id: "work/meeting", calendarId: "work", title: "Planning", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z",
      attendees: [{ address: "lee@example.com", name: "Lee", response: "accepted", organizer: false }],
    });
    const { provider } = await setup({ events: [...baseEvents(), meeting] });
    fireEvent.keyDown(eventButton("Standup"), { key: "ArrowDown", altKey: true });
    await settle();
    expect(provider.callsTo("updateEvent")[0].args[2]).toEqual({ sendInvites: false });
    expect(eventButton("Standup").style.top).toBe("444px");

    fireEvent.keyDown(eventButton("Planning"), { key: "ArrowDown", altKey: true });
    const dialog = screen.getByRole("alertdialog", { name: "Tell guests about the new time?" });
    expect(within(dialog).getByText("lee@example.com")).toBeTruthy();
    expect(provider.callsTo("updateEvent")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Send update" }));
    await settle();
    const call = provider.callsTo("updateEvent")[1];
    expect(call.args[0]).toBe("work/meeting");
    expect(call.args[2]).toEqual({ sendInvites: true });
  });

  it("shows a per-range error with a retry that reloads the range", async () => {
    const { provider } = await setup();
    const original = provider.listEvents.bind(provider);
    let fail = true;
    provider.listEvents = async (request) => {
      if (fail) throw new Error("upstream said: secret provider detail");
      return original(request);
    };
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Calendar" })).getByRole("button", { name: "Next week" }));
    await settle();
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Events for this range could not be loaded.");
    expect(banner.textContent).not.toContain("secret provider detail");
    fail = false;
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
