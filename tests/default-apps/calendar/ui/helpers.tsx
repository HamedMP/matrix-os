import { act, render, screen } from "@testing-library/react";
import React from "react";
import type { CalendarAccount, CalendarEvent } from "../../../../home/apps/_shared/office-accounts/types/calendar";
import { createMemoryPersistence } from "../../../../home/apps/calendar/src/model/preferences";
import { createCalendarStore } from "../../../../home/apps/calendar/src/model/store";
import { CalendarApp } from "../../../../home/apps/calendar/src/ui/CalendarApp";
import { calendarInfo, FakeCalendarProvider } from "../model/fake-provider";
import { event } from "../model/fixtures";

/** Monday 23 November 2026, 10:00 in New York. */
export const NOW = Date.parse("2026-11-23T15:00:00Z");
export const ACCOUNT: CalendarAccount = { id: "google:me@example.com", provider: "google", address: "me@example.com", displayName: "Work account" };

export function baseEvents(): CalendarEvent[] {
  return [
    event({ id: "work/standup", calendarId: "work", title: "Standup", start: "2026-11-23T14:00:00Z", end: "2026-11-23T14:30:00Z" }),
    event({ id: "family/dinner", calendarId: "family", title: "Dinner", start: "2026-11-24T23:00:00Z", end: "2026-11-25T00:30:00Z" }),
    event({ id: "work/offsite", calendarId: "work", title: "Offsite", start: "2026-11-26T00:00:00Z", end: "2026-11-27T00:00:00Z", allDay: true }),
  ];
}

export async function setup(options: { events?: CalendarEvent[]; preferences?: Record<string, unknown>; accounts?: boolean } = {}) {
  const provider = new FakeCalendarProvider([
    calendarInfo("work", { name: "Work", primary: true, color: "#3366cc" }),
    calendarInfo("family", { name: "Family", color: "#22aa55" }),
  ]);
  provider.events = options.events ?? baseEvents();
  const store = createCalendarStore({
    connect: async () => (options.accounts === false ? [] : [{ account: ACCOUNT, provider }]),
    persistence: createMemoryPersistence({ preferences: { timeZone: "America/New_York", ...options.preferences } }),
    now: () => NOW,
    log: () => undefined,
  });
  const utils = render(<CalendarApp store={store} now={() => NOW} />);
  await act(async () => {
    await store.init();
  });
  return { store, provider, ...utils };
}

/** Lets pending promises (provider calls, store updates) settle inside act. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function dayColumn(day: string): HTMLElement {
  const column = document.querySelector<HTMLElement>(`.cal-day-column[data-day="${day}"]`);
  if (!column) throw new Error(`No column for ${day}`);
  return column;
}

export function columnDays(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".cal-day-column")].map((column) => column.dataset.day ?? "");
}

export function eventButton(title: string | RegExp): HTMLElement {
  return screen.getByRole("button", { name: typeof title === "string" ? new RegExp(`^${title},`) : title });
}
