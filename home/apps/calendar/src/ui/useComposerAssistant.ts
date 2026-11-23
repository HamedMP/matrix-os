/**
 * Keeps the scheduling assistant in step with the open draft: its guests'
 * busy time is fetched and overlaid, and free slots of the draft's length
 * are searched when availability arrives. Closing the
 * composer clears the overlay and the suggestions.
 */
import { useEffect } from "react";
import type { EventDraft } from "../../../_shared/office-accounts/types/calendar";
import type { AssistantState, CalendarStore } from "../model";

export function useComposerAssistant(store: CalendarStore, draft: EventDraft, assistant: AssistantState, durationMinutes: number): void {
  const attendeeKey = draft.attendees.map((attendee) => attendee.address.toLowerCase()).join(",");
  const { status, busyStart } = assistant;
  const allDay = draft.allDay;

  useEffect(() => {
    void store.setAssistantAttendees(attendeeKey ? attendeeKey.split(",") : []);
  }, [store, attendeeKey]);

  useEffect(() => () => {
    void store.setAssistantAttendees([]);
    store.clearProposals("assistant");
  }, [store]);

  // Searches again when availability arrives or the guests or length change, not on every keystroke.
  useEffect(() => {
    if (status === "ready" && attendeeKey) store.findSlots({ durationMinutes: allDay ? undefined : durationMinutes });
  }, [store, status, busyStart, attendeeKey, durationMinutes, allDay]);
}
