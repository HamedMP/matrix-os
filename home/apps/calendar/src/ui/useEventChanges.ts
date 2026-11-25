/**
 * Changes to existing events from the grid and the popover. A change that
 * would notify guests waits for the owner's answer in `ConfirmGuestChange`;
 * every other change goes straight to the store (optimistic, rolled back on
 * failure) without notifying anyone.
 */
import { useState } from "react";
import { instantToMs, type EventChanges } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState, CalendarStore } from "../model";
import type { GuestChange } from "./ConfirmGuestChange";
import { guestAddresses, ownerAddressFor, timeChanges } from "./eventActions";

type PendingGuestChange = GuestChange & { eventId: string; changes: EventChanges | null };

export function useEventChanges(store: CalendarStore, state: CalendarState) {
  const [pending, setPending] = useState<PendingGuestChange | null>(null);

  function guestsOf(eventId: string): { title: string; recipients: string[] } | null {
    const event = state.events.find((item) => item.id === eventId);
    if (!event) return null;
    return { title: event.title, recipients: guestAddresses(event, ownerAddressFor(event, state.calendars, state.accounts)) };
  }

  function changeTime(eventId: string, startMs: number, endMs: number): void {
    const event = state.events.find((item) => item.id === eventId);
    if (!event || (startMs === instantToMs(event.start) && endMs === instantToMs(event.end))) return;
    const changes = timeChanges(event, startMs, endMs);
    const guests = guestsOf(eventId);
    if (guests && guests.recipients.length > 0) {
      setPending({ kind: "move", eventId, changes, eventTitle: guests.title, recipients: guests.recipients });
      return;
    }
    void store.updateEvent(eventId, changes, { sendInvites: false });
  }

  function remove(eventId: string): void {
    const guests = guestsOf(eventId);
    if (guests && guests.recipients.length > 0) {
      setPending({ kind: "delete", eventId, changes: null, eventTitle: guests.title, recipients: guests.recipients });
      return;
    }
    void store.deleteEvent(eventId, { sendInvites: false });
  }

  /** The owner's answer: notify the named guests or not. */
  function finish(sendInvites: boolean): void {
    const change = pending;
    setPending(null);
    if (!change) return;
    if (change.kind === "delete") void store.deleteEvent(change.eventId, { sendInvites });
    else if (change.changes) void store.updateEvent(change.eventId, change.changes, { sendInvites });
  }

  return { pending, changeTime, remove, finish, cancel: () => setPending(null) };
}
