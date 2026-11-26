// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventDraft } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { MEETING_FIXED_HINT } from "../../../../home/apps/calendar/src/ui/composerOptions";
import { event } from "../model/fixtures";
import { baseEvents, settle, setup } from "./helpers";

afterEach(cleanup);

function composer(): HTMLElement {
  return screen.getByRole("form", { name: /New event|Edit event/ });
}

function toolbarButton(name: string): HTMLButtonElement {
  return within(screen.getByRole("toolbar", { name: "Calendar" })).getByRole("button", { name }) as HTMLButtonElement;
}

describe("event composer guards", () => {
  // Outcome: "Every week" repeats on the day the event is on after its date changes.
  // Fault: the rule keeps the first start's weekday, so a Monday draft moved to Wednesday repeats on Mondays.
  it("repeats a weekly event on the weekday it ends up on after the start date changes", async () => {
    const { provider } = await setup();
    fireEvent.keyDown(screen.getByRole("group", { name: /Time grid/ }), { key: "Enter" });
    fireEvent.change(within(composer()).getByLabelText("Title"), { target: { value: "Review" } });
    const repeat = within(composer()).getByLabelText("Repeat") as HTMLSelectElement;
    fireEvent.change(repeat, { target: { value: "weekly" } });
    fireEvent.change(within(composer()).getByLabelText("Start date"), { target: { value: "2026-11-25" } });
    expect((within(composer()).getByLabelText("Repeat") as HTMLSelectElement).value).toBe("weekly");
    fireEvent.click(within(composer()).getByRole("button", { name: "Save" }));
    await settle();
    const [draft] = provider.callsTo("createEvent")[0].args as [EventDraft];
    expect(draft.start).toBe("2026-11-25T09:00:00-05:00");
    expect(draft.recurrence).toEqual({ freq: "weekly", interval: 1 });
  });

  // Outcome: while a new event is being saved, "New event" waits, so a failed save keeps the owner's draft.
  it("turns New event off while a draft is saving", async () => {
    const { store, provider } = await setup();
    fireEvent.click(toolbarButton("New event"));
    fireEvent.change(within(composer()).getByLabelText("Title"), { target: { value: "Planning" } });
    provider.holdWrites = true;
    fireEvent.click(within(composer()).getByRole("button", { name: "Save" }));
    await settle();
    expect(toolbarButton("New event").disabled).toBe(true);
    await act(async () => {
      provider.release();
    });
    await settle();
    expect(toolbarButton("New event").disabled).toBe(false);
    expect(store.getSnapshot().draft).toBeNull();
  });

  // Outcome: an existing event's video meeting is shown on and cannot be unchecked, since it cannot be removed.
  it("shows an existing event's video meeting as fixed", async () => {
    const call = event({ id: "work/call", calendarId: "work", title: "Call", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z",
      onlineMeeting: { provider: "google_meet", joinUrl: "https://meet.google.com/abc-defg-hij" } });
    const { store } = await setup({ events: [...baseEvents(), call] });
    act(() => {
      store.openEditDraft("work/call");
    });
    const meeting = within(composer()).getByLabelText(/^Add video meeting/) as HTMLInputElement;
    expect(meeting.checked).toBe(true);
    expect(meeting.disabled).toBe(true);
    expect(within(composer()).getByText(MEETING_FIXED_HINT)).toBeTruthy();

    act(() => {
      store.openEditDraft("work/standup");
    });
    expect((within(composer()).getByLabelText(/^Add video meeting/) as HTMLInputElement).disabled).toBe(false);
  });
});
