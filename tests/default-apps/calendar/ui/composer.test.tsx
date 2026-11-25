// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventDraft, InviteOptions } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { dayColumn, settle, setup } from "./helpers";

afterEach(cleanup);

function composer(): HTMLElement {
  return screen.getByRole("form", { name: /New event|Edit event/ });
}

async function openComposerAt9() {
  const context = await setup();
  // Keyboard path on the grid: the cursor starts at 09:00 on today; Enter creates.
  const grid = screen.getByRole("group", { name: /Time grid/ });
  fireEvent.keyDown(grid, { key: "Enter" });
  return context;
}

function type(label: string, value: string) {
  fireEvent.change(within(composer()).getByLabelText(label), { target: { value } });
}

function addGuest(address: string) {
  const field = within(composer()).getByLabelText("Guests");
  fireEvent.change(field, { target: { value: address } });
  fireEvent.keyDown(field, { key: "Enter" });
}

describe("event composer", () => {
  it("opens from the grid at the cursor time and validates before saving", async () => {
    const { provider } = await openComposerAt9();
    expect((within(composer()).getByLabelText("Start time") as HTMLInputElement).value).toBe("09:00");
    expect((within(composer()).getByLabelText("End time") as HTMLInputElement).value).toBe("09:30");
    expect((within(composer()).getByLabelText("Time zone") as HTMLSelectElement).value).toBe("America/New_York");

    fireEvent.click(within(composer()).getByRole("button", { name: "Save" }));
    expect(within(composer()).getByText("Add a title.")).toBeTruthy();

    type("Title", "Focus time");
    type("End time", "08:00");
    fireEvent.click(within(composer()).getByRole("button", { name: "Save" }));
    expect(within(composer()).getByRole("alert").textContent).toContain("The end must be after the start.");
    expect(provider.callsTo("createEvent")).toHaveLength(0);
  });

  it("keeps the length when the start moves and rejects an invalid guest address", async () => {
    await openComposerAt9();
    type("Start time", "13:15");
    expect((within(composer()).getByLabelText("End time") as HTMLInputElement).value).toBe("13:45");
    addGuest("not an address");
    expect(within(composer()).getByText("Enter a valid email address.")).toBeTruthy();
    expect(within(composer()).queryByRole("list", { name: "Guest list" })).toBeNull();
  });

  it("saves an event without guests directly and never sends invites", async () => {
    const { provider } = await openComposerAt9();
    type("Title", "Focus time");
    fireEvent.click(within(composer()).getByRole("button", { name: "Save" }));
    await settle();
    const [draft, options] = provider.callsTo("createEvent")[0].args as [EventDraft, InviteOptions];
    expect(draft.title).toBe("Focus time");
    expect(draft.start).toBe("2026-11-23T09:00:00-05:00");
    expect(options).toEqual({ sendInvites: false });
    expect(screen.queryByRole("form", { name: "New event" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Focus time,/ })).toBeTruthy();
  });

  it("sends invites only after the owner confirms the named recipients", async () => {
    const { provider } = await openComposerAt9();
    type("Title", "Kickoff");
    addGuest("ana@example.com, ben@example.com");
    const guests = within(composer()).getByRole("list", { name: "Guest list" });
    expect(within(guests).getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(within(composer()).getByRole("button", { name: "Send invite" }));
    let dialog = screen.getByRole("alertdialog", { name: "Send this invitation?" });
    expect(within(dialog).getByText("ana@example.com")).toBeTruthy();
    expect(within(dialog).getByText("ben@example.com")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await settle();
    expect(provider.callsTo("createEvent")).toHaveLength(0);

    fireEvent.click(within(composer()).getByRole("button", { name: "Send invite" }));
    dialog = screen.getByRole("alertdialog", { name: "Send this invitation?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send invite" }));
    await settle();
    const [draft, options] = provider.callsTo("createEvent")[0].args as [EventDraft, InviteOptions];
    expect(draft.attendees.map((attendee) => attendee.address)).toEqual(["ana@example.com", "ben@example.com"]);
    expect(options).toEqual({ sendInvites: true });
  });

  it("overlays guests' busy time on the grid and offers free slots that set the draft time", async () => {
    const context = await setup();
    context.provider.busy = [{ address: "ana@example.com", start: "2026-11-24T14:00:00Z", end: "2026-11-24T16:00:00Z" }];
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Calendar" })).getByRole("button", { name: "New event" }));
    addGuest("ana@example.com");
    await settle();
    await settle();
    const bands = dayColumn("2026-11-24").querySelectorAll(".cal-busy");
    expect(bands).toHaveLength(1);
    expect(bands[0].className).toContain("cal-person-0");
    const assistant = within(composer()).getByRole("region", { name: "Scheduling assistant" });
    expect(within(assistant).getByText("ana@example.com")).toBeTruthy();
    const slots = within(assistant).getAllByRole("button", { name: /–/ });
    expect(slots.length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".cal-proposal").length).toBe(slots.length);
    fireEvent.click(slots[0]);
    const startTime = (within(composer()).getByLabelText("Start time") as HTMLInputElement).value;
    expect(startTime).toMatch(/^\d{2}:\d{2}$/);
    expect(document.querySelector(".cal-proposal")?.getAttribute("aria-label")).toMatch(/^Suggested time/);
  });

  it("opens a draft from an agent proposal on the grid without creating anything", async () => {
    const { store, provider } = await setup();
    store.receiveProposals([{ id: "p1", start: "2026-11-25T16:00:00Z", end: "2026-11-25T16:30:00Z", title: "Coffee with Ana", attendees: ["ana@example.com"] }]);
    await settle();
    const proposal = screen.getByRole("button", { name: /Suggested time .*Coffee with Ana/ });
    expect(dayColumn("2026-11-25").contains(proposal)).toBe(true);
    fireEvent.click(proposal);
    expect((within(composer()).getByLabelText("Title") as HTMLInputElement).value).toBe("Coffee with Ana");
    expect(within(composer()).getByRole("button", { name: "Send invite" })).toBeTruthy();
    expect(provider.callsTo("createEvent")).toHaveLength(0);
  });
});
