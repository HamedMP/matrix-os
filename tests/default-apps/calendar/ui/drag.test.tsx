// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventChanges } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { event } from "../model/fixtures";
import { baseEvents, eventButton, settle, setup } from "./helpers";

// Seven 100px columns; 48px per hour, so y = minutes * 0.8.
const RECT = { left: 0, top: 0, width: 700, height: 1152, right: 700, bottom: 1152, x: 0, y: 0, toJSON: () => ({}) };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(RECT as DOMRect);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function grid(): HTMLElement {
  return screen.getByRole("group", { name: /Time grid/ });
}

function drag(target: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(grid(), { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(grid(), { pointerId: 1, clientX: to.x, clientY: to.y });
}

describe("time grid gestures", () => {
  it("drags on empty time to open a draft for that span", async () => {
    await setup();
    // Tuesday (column 1), 14:00 to 15:30.
    drag(grid(), { x: 150, y: 840 * 0.8 }, { x: 150, y: 930 * 0.8 });
    const form = screen.getByRole("form", { name: "New event" });
    expect((within(form).getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-11-24");
    expect((within(form).getByLabelText("Start time") as HTMLInputElement).value).toBe("14:00");
    expect((within(form).getByLabelText("End time") as HTMLInputElement).value).toBe("15:30");
  });

  it("drags an event to another day and time, optimistically", async () => {
    const { provider } = await setup();
    provider.holdWrites = true;
    const standup = eventButton("Standup");
    // From Monday 09:00 to Wednesday 11:00 (two columns right, 120 minutes down).
    drag(standup, { x: 50, y: 440 }, { x: 250, y: 440 + 120 * 0.8 });
    await settle();
    const [eventId, changes, options] = provider.callsTo("updateEvent")[0].args as [string, EventChanges, { sendInvites: boolean }];
    expect(eventId).toBe("work/standup");
    // 11:00 in New York, written in the event's own zone (UTC for this fixture).
    expect(changes.start).toBe("2026-11-25T16:00:00Z");
    expect(changes.end).toBe("2026-11-25T16:30:00Z");
    expect(options).toEqual({ sendInvites: false });
    const moved = eventButton("Standup");
    expect(moved.closest("[data-day]")?.getAttribute("data-day")).toBe("2026-11-25");
    expect(moved.getAttribute("aria-busy")).toBe("true");
    provider.release();
    await settle();
    expect(eventButton("Standup").getAttribute("aria-busy")).toBeNull();
  });

  it("resizes an event from its bottom edge", async () => {
    const { provider } = await setup();
    const handle = eventButton("Standup").querySelector<HTMLElement>("[data-resize]");
    expect(handle).not.toBeNull();
    drag(handle!, { x: 50, y: 455 }, { x: 50, y: 455 + 30 * 0.8 });
    await settle();
    const changes = provider.callsTo("updateEvent")[0].args[1] as EventChanges;
    expect(changes.start).toBe("2026-11-23T14:00:00Z");
    expect(changes.end).toBe("2026-11-23T15:00:00Z");
  });

  it("resizes the last day of an overnight event and keeps its original start", async () => {
    // Monday 23:00 to Tuesday 01:00 in New York.
    const overnight = event({ id: "work/late", calendarId: "work", title: "Late deploy", start: "2026-11-24T04:00:00Z", end: "2026-11-24T06:00:00Z" });
    const { provider } = await setup({ events: [...baseEvents(), overnight] });
    const parts = screen.getAllByRole("button", { name: /^Late deploy,/ });
    const tuesday = parts.find((part) => part.closest("[data-day]")?.getAttribute("data-day") === "2026-11-24");
    const handle = tuesday?.querySelector<HTMLElement>("[data-resize]");
    expect(handle).toBeTruthy();
    // Drag the bottom edge from 01:00 down to 02:00 on Tuesday (column 1).
    drag(handle!, { x: 150, y: 60 * 0.8 }, { x: 150, y: 120 * 0.8 });
    await settle();
    const changes = provider.callsTo("updateEvent")[0].args[1] as EventChanges;
    expect(Date.parse(changes.start!)).toBe(Date.parse("2026-11-24T04:00:00Z"));
    expect(Date.parse(changes.end!)).toBe(Date.parse("2026-11-24T07:00:00Z"));
  });

  it("treats a press without movement on an event as a click that opens it", async () => {
    const { provider } = await setup();
    fireEvent.pointerDown(eventButton("Standup"), { pointerId: 1, button: 0, clientX: 50, clientY: 440 });
    fireEvent.pointerUp(grid(), { pointerId: 1, clientX: 50, clientY: 440 });
    expect(screen.getByRole("dialog", { name: "Standup" })).toBeTruthy();
    expect(provider.callsTo("updateEvent")).toHaveLength(0);
    expect(provider.callsTo("createEvent")).toHaveLength(0);
  });
});
