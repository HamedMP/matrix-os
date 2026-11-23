/**
 * What a change to an existing event means for its guests, and the change
 * itself. Pure helpers used by the grid, the popover and the confirm dialogs.
 */
import type { CalendarAccount, CalendarEvent, CalendarInfo, EventChanges } from "../../../_shared/office-accounts/types/calendar";
import { zonedInstant } from "../model/dates";

/** The owner's address for the account that holds an event's calendar. */
export function ownerAddressFor(event: CalendarEvent, calendars: readonly CalendarInfo[], accounts: readonly CalendarAccount[]): string {
  const accountId = calendars.find((calendar) => calendar.id === event.calendarId)?.accountId;
  return accounts.find((account) => account.id === accountId)?.address.toLowerCase() ?? "";
}

/** Everyone a change would notify: attendees other than the organiser and the owner. */
export function guestAddresses(event: CalendarEvent, ownerAddress: string): string[] {
  const owner = ownerAddress.toLowerCase();
  const result = new Set<string>();
  for (const attendee of event.attendees) {
    const address = attendee.address.toLowerCase();
    if (!attendee.organizer && address !== owner) result.add(address);
  }
  return [...result];
}

/** New start and end for a timed event, written in the event's own zone. */
export function timeChanges(event: CalendarEvent, startMs: number, endMs: number): EventChanges {
  const zone = event.allDay ? "UTC" : event.timeZone;
  return {
    start: zonedInstant(startMs, zone),
    end: zonedInstant(endMs, zone),
    allDay: event.allDay,
    timeZone: event.timeZone,
  };
}

/** True when the owner may change the event: a writable calendar and no unconfirmed write. */
export function canEdit(event: CalendarEvent, calendar: CalendarInfo | undefined, pendingIds: readonly string[]): boolean {
  return Boolean(calendar?.writable) && !pendingIds.includes(event.id) && !event.id.startsWith("pending:");
}

/** A join link is opened only when it is a well-formed https URL. */
export function safeJoinUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
