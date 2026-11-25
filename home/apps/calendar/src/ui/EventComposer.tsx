/**
 * The event composer panel. While it is open, guests' busy time is overlaid
 * on the grid and free slots are suggested. Nothing is sent until the owner
 * presses Send invite and confirms the named recipients.
 */
import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { TextField } from "../../../_shared/office-ui";
import { instantToMs } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState, CalendarStore } from "../model";
import type { DraftState } from "../model/drafts";
import { AttendeeField } from "./AttendeeField";
import { ComposerTime } from "./ComposerTime";
import { ComposerDetails } from "./ComposerDetails";
import { ComposerFooter } from "./ComposerFooter";
import { TITLE_REQUIRED } from "./composerOptions";
import { useComposerAssistant } from "./useComposerAssistant";
import { addDays } from "../model/dates";
import { SchedulingAssistant } from "./SchedulingAssistant";

export interface EventComposerProps {
  store: CalendarStore;
  state: CalendarState;
  draftState: DraftState;
  onApplyProposal(proposalId: string): void;
}

export function EventComposer({ store, state, draftState, onApplyProposal }: EventComposerProps) {
  const { draft } = draftState;
  const [attempted, setAttempted] = useState(false);
  const saving = draftState.status === "saving";
  const durationMinutes = Math.round((instantToMs(draft.end) - instantToMs(draft.start)) / 60_000);
  const writable = useMemo(() => state.calendars.filter((calendar) => calendar.writable), [state.calendars]);
  useComposerAssistant(store, draft, state.assistant, durationMinutes);

  const titleError = attempted && !draft.title.trim() ? TITLE_REQUIRED : null;
  const heading = draftState.mode === "edit" ? "Edit event" : "New event";

  return (
    <form className="cal-composer" aria-label={heading} onSubmit={(event) => event.preventDefault()}>
      <div className="cal-composer__head">
        <h2>{heading}</h2>
        <button type="button" className="oui-icon-button" aria-label="Close composer" onClick={() => store.closeDraft()} disabled={saving}><X size={16} /></button>
      </div>
      <div className="cal-composer__scroll">
        <TextField label="Title" value={draft.title} onChange={(title) => store.patchDraft({ title })} error={titleError} autoFocus maxLength={500} disabled={saving} />
        <ComposerTime
          draft={draft}
          viewZone={state.timeZone}
          disabled={saving}
          onTimes={(start, end, zone) => store.setDraftTimes(start, end, zone)}
          onAllDay={(allDay) => store.setDraftAllDay(allDay)}
          onAllDayDates={(first, last) => {
            store.setDraftTimes(`${first}T00:00`, `${addDays(last, 1)}T00:00`, state.timeZone);
            store.setDraftAllDay(true);
          }}
        />
        <AttendeeField
          attendees={draft.attendees}
          colorOrder={state.assistant.attendees}
          disabled={saving}
          onAdd={(attendee) => store.addDraftAttendee(attendee)}
          onRemove={(address) => store.removeDraftAttendee(address)}
          onToggleOptional={(address, optional) => store.setDraftAttendeeOptional(address, optional)}
        />
        <SchedulingAssistant
          assistant={state.assistant}
          proposals={state.proposals}
          timeZone={draft.allDay ? state.timeZone : draft.timeZone}
          durationMinutes={draft.allDay ? state.assistant.durationMinutes : durationMinutes}
          onApply={onApplyProposal}
          onFind={() => store.findSlots({ durationMinutes: draft.allDay ? undefined : durationMinutes })}
          onRetry={() => void store.loadBusy()}
        />
        <ComposerDetails store={store} draftState={draftState} writable={writable} disabled={saving} />
      </div>
      <ComposerFooter store={store} draftState={draftState} viewZone={state.timeZone} attempted={attempted} onAttempt={() => setAttempted(true)} />
    </form>
  );
}
