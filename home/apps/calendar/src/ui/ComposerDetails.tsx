/**
 * The composer's secondary fields: video meeting, location, description,
 * repeat, reminder and (with more than one writable calendar) the calendar.
 */
import { Checkbox, Select, TextField } from "../../../_shared/office-ui";
import type { CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarStore } from "../model";
import type { DraftState } from "../model/drafts";
import {
  RECURRENCE_PRESETS,
  REMINDER_PRESETS,
  presetForRecurrence,
  presetForReminders,
  recurrenceForPreset,
  remindersForPreset,
  type RecurrencePreset,
} from "./composerOptions";

export interface ComposerDetailsProps {
  store: CalendarStore;
  draftState: DraftState;
  writable: readonly CalendarInfo[];
  disabled: boolean;
}

const CUSTOM = { value: "custom", label: "Custom" };

export function ComposerDetails({ store, draftState, writable, disabled }: ComposerDetailsProps) {
  const { draft } = draftState;
  const repeat = presetForRecurrence(draft.recurrence);
  const reminder = presetForReminders(draft.reminders);
  return (
    <>
      <Checkbox label="Add video meeting" checked={draft.addOnlineMeeting} onChange={(on) => store.setDraftOnlineMeeting(on)} disabled={disabled} />
      <TextField label="Location" value={draft.location} onChange={(location) => store.patchDraft({ location })} maxLength={500} disabled={disabled} />
      <TextField
        label="Description"
        multiline
        rows={4}
        value={draft.descriptionText}
        onChange={(descriptionText) => store.patchDraft({ descriptionText })}
        maxLength={8000}
        disabled={disabled}
      />
      <Select
        label="Repeat"
        value={repeat}
        onChange={(value) => {
          if (value !== CUSTOM.value) store.setDraftRecurrence(recurrenceForPreset(value as RecurrencePreset, draft));
        }}
        options={[...RECURRENCE_PRESETS, ...(repeat === CUSTOM.value ? [CUSTOM] : [])]}
        disabled={disabled}
      />
      <Select
        label="Reminder"
        value={reminder}
        onChange={(value) => {
          if (value !== CUSTOM.value) store.setDraftReminders(remindersForPreset(value));
        }}
        options={[...REMINDER_PRESETS, ...(reminder === CUSTOM.value ? [CUSTOM] : [])]}
        disabled={disabled}
      />
      {writable.length > 1 && (
        <Select
          label="Calendar"
          value={draft.calendarId}
          onChange={(calendarId) => store.patchDraft({ calendarId })}
          options={writable.map((calendar) => ({ value: calendar.id, label: calendar.name }))}
          disabled={disabled || draftState.mode === "edit"}
        />
      )}
    </>
  );
}
