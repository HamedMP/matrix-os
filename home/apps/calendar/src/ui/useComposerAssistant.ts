/**
 * Keeps the scheduling assistant in step with the open draft: its guests'
 * busy time is fetched and overlaid, and free slots of the draft's length
 * are searched once both the guests' availability and the owner's own events
 * for the visible range have loaded. Closing the composer clears the overlay
 * and the suggestions.
 */
import { useEffect, useMemo } from "react";
import type { CalendarEvent, EventDraft } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState, CalendarStore } from "../model";
import { isSlotDuration } from "../model/slots";
import { normalizeAttendeeAddresses } from "../model/store-schedule";

export interface ComposerSearch {
  /** False when the draft's length cannot be searched for (end not after start, or longer than a day). */
  searchable: boolean;
  /** True when the current guests' availability and the owner's events are loaded, so a search sees every meeting. */
  ready: boolean;
}

/** What makes the owner busy, as one comparable key: the search reruns only when it changes. */
function ownerBusyKey(events: readonly CalendarEvent[]): string {
  return events
    .filter((event) => !event.allDay && event.myResponse !== "declined")
    .map((event) => `${event.id}|${event.start}|${event.end}|${event.myResponse ?? ""}`)
    .join("\n");
}

export function useComposerAssistant(store: CalendarStore, draft: EventDraft, state: CalendarState, durationMinutes: number): ComposerSearch {
  const attendeeKey = draft.attendees.map((attendee) => attendee.address.toLowerCase()).join(",");
  const { status, busyStart } = state.assistant;
  const allDay = draft.allDay;
  const searchable = allDay || isSlotDuration(durationMinutes);
  // The loaded availability must be for these guests: right after a guest is added the store still holds the earlier list.
  const currentGuests = normalizeAttendeeAddresses(attendeeKey ? attendeeKey.split(",") : []).join(",") === state.assistant.attendees.join(",");
  const ready = status === "ready" && state.eventsStatus === "ready" && currentGuests;
  const ownerKey = useMemo(() => ownerBusyKey(state.events), [state.events]);

  useEffect(() => {
    void store.setAssistantAttendees(attendeeKey ? attendeeKey.split(",") : []);
  }, [store, attendeeKey]);

  useEffect(() => () => {
    void store.setAssistantAttendees([]);
    store.clearProposals("assistant");
  }, [store]);

  // Searches again when availability or the owner's events arrive, or the
  // guests or length change; not on every keystroke.
  useEffect(() => {
    if (!attendeeKey || !ready) return;
    if (!searchable) {
      store.clearProposals("assistant");
      return;
    }
    store.findSlots({ durationMinutes: allDay ? undefined : durationMinutes });
  }, [store, ready, busyStart, ownerKey, attendeeKey, durationMinutes, allDay, searchable]);

  return { searchable, ready };
}
