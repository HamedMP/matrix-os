/**
 * The composer's secondary fields: video meeting, location, description,
 * repeat, reminder and (with more than one writable calendar) the calendar.
 * Editing an existing event shows its repeat and reminders as unchanged, and
 * keeps a video meeting it already has.
 */
import { Checkbox, Select, TextField } from "../../../_shared/office-ui";
import type { CalendarInfo } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarStore } from "../model";
import type { DraftState } from "../model/drafts";
import {
  MEETING_FIXED_HINT,
  RECURRENCE_PRESETS,
  REMINDER_PRESETS,
  REPEAT_FIXED_HINT,
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
const UNCHANGED = "unchanged";
const NO_REPEAT_LABEL = RECURRENCE_PRESETS[0].label;

/**
 * An existing event's repeat rule and reminders are not read into the draft,
 * so its fields show what is known and cannot be changed here.
 */
function FixedRepeatAndReminder({ repeat }: { repeat: string | null }) {
  const ignore = () => undefined;
  return (
    <>
      <Select label="Repeat" value={UNCHANGED} onChange={ignore} options={[{ value: UNCHANGED, label: repeat ?? NO_REPEAT_LABEL }]} disabled />
      <Select
        label="Reminder"
        value={UNCHANGED}
        onChange={ignore}
        options={[{ value: UNCHANGED, label: "Unchanged" }]}
        hint={REPEAT_FIXED_HINT}
        disabled
      />
    </>
  );
}

export function ComposerDetails({ store, draftState, writable, disabled }: ComposerDetailsProps) {
  const { draft } = draftState;
  const repeat = presetForRecurrence(draft.recurrence, draft);
  const reminder = presetForReminders(draft.reminders);
  const editing = draftState.mode === "edit";
  // An existing event's meeting link cannot be removed, so its box is shown on and fixed.
  const meetingFixed = editing && draftState.original?.addOnlineMeeting === true;
  return (
    <>
      <Checkbox
        label="Add video meeting"
        checked={draft.addOnlineMeeting}
        onChange={(on) => store.setDraftOnlineMeeting(on)}
        disabled={disabled || meetingFixed}
        description={meetingFixed ? MEETING_FIXED_HINT : undefined}
      />
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
      {editing ? (
        <FixedRepeatAndReminder repeat={draftState.repeat} />
      ) : (
        <>
          <Select
            label="Repeat"
            value={repeat}
            onChange={(value) => {
              if (value !== CUSTOM.value) store.setDraftRecurrence(recurrenceForPreset(value as RecurrencePreset));
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
        </>
      )}
      {writable.length > 1 && (
        <Select
          label="Calendar"
          value={draft.calendarId}
          onChange={(calendarId) => store.patchDraft({ calendarId })}
          options={writable.map((calendar) => ({ value: calendar.id, label: calendar.name }))}
          disabled={disabled || editing}
        />
      )}
    </>
  );
}
