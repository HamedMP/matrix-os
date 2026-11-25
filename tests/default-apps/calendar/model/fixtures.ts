import type { CalendarEvent } from "../../../../home/apps/_shared/office-accounts/types/calendar";

let counter = 0;

/** A plain provider event; only the fields a test names differ from the defaults. */
export function event(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, "start" | "end">): CalendarEvent {
  counter += 1;
  return {
    id: overrides.id ?? `cal-1/e${counter}`,
    calendarId: "cal-1",
    title: `Event ${counter}`,
    allDay: false,
    timeZone: "UTC",
    location: "",
    descriptionText: "",
    attendees: [],
    myResponse: null,
    ...overrides,
  };
}

export function allDay(id: string, startDate: string, endDateExclusive: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return event({ id, start: `${startDate}T00:00:00Z`, end: `${endDateExclusive}T00:00:00Z`, allDay: true, ...extra });
}
