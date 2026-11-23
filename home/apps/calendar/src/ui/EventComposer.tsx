/**
 * The event composer panel. While it is open, guests' busy time is overlaid
 * on the grid and free slots are suggested. Nothing is sent until the owner
 * presses Send invite and confirms the named recipients.
 */
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Checkbox, ConfirmSend, Select, TextField } from "../../../_shared/office-ui";
import { instantToMs } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarState, CalendarStore } from "../model";
import type { DraftState } from "../model/drafts";
import { AttendeeField } from "./AttendeeField";
import { ComposerTime } from "./ComposerTime";
import {
  RECURRENCE_PRESETS,
  REMINDER_PRESETS,
  TITLE_REQUIRED,
  issueText,
  presetForRecurrence,
  presetForReminders,
  recurrenceForPreset,
  remindersForPreset,
  type RecurrencePreset,
} from "./composerOptions";
import { addDays } from "../model/dates";
import { formatEventWhen } from "./format";
import { SchedulingAssistant } from "./SchedulingAssistant";

export interface EventComposerProps {
  store: CalendarStore;
  state: CalendarState;
  draftState: DraftState;
  onApplyProposal(proposalId: string): void;
}

/** Everyone a save would notify: current guests plus, when editing, guests that were removed. */
export function inviteRecipients(draftState: DraftState): string[] {
  const addresses = [...draftState.draft.attendees, ...(draftState.original?.attendees ?? [])].map((attendee) => attendee.address.toLowerCase());
  return [...new Set(addresses)];
}

export function EventComposer({ store, state, draftState, onApplyProposal }: EventComposerProps) {
  const { draft } = draftState;
  const [attempted, setAttempted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const saving = draftState.status === "saving";
  const recipients = inviteRecipients(draftState);
  const attendeeKey = draft.attendees.map((attendee) => attendee.address.toLowerCase()).join(",");
  const durationMinutes = Math.round((instantToMs(draft.end) - instantToMs(draft.start)) / 60_000);
  const writable = useMemo(() => state.calendars.filter((calendar) => calendar.writable), [state.calendars]);
  const { status: busyStatus, busyStart } = state.assistant;

  useEffect(() => {
    void store.setAssistantAttendees(attendeeKey ? attendeeKey.split(",") : []);
  }, [store, attendeeKey]);

  useEffect(() => () => {
    void store.setAssistantAttendees([]);
    store.clearProposals("assistant");
  }, [store]);

  useEffect(() => {
    if (!draft.allDay) store.setAssistantDuration(durationMinutes);
  }, [store, draft.allDay, durationMinutes]);

  useEffect(() => {
    if (busyStatus === "ready" && attendeeKey) store.findSlots({ durationMinutes: draft.allDay ? undefined : durationMinutes });
    // Searches again when availability arrives or the guest list or length changes, not on every keystroke.
  }, [store, busyStatus, busyStart, attendeeKey, durationMinutes, draft.allDay]);

  const titleError = attempted && !draft.title.trim() ? TITLE_REQUIRED : null;
  const issues = draftState.issues.map(issueText);
  const blocked = !draft.title.trim() || draftState.issues.length > 0;
  const sendsInvites = recipients.length > 0;
  const primaryLabel = sendsInvites ? (draftState.mode === "edit" ? "Send update" : "Send invite") : "Save";

  function onPrimary() {
    setAttempted(true);
    if (blocked || saving) return;
    if (sendsInvites) setConfirming(true);
    else void store.saveDraft({ sendInvites: false });
  }

  return (
    <form className="cal-composer" aria-label={draftState.mode === "edit" ? "Edit event" : "New event"} onSubmit={(event) => { event.preventDefault(); onPrimary(); }}>
      <div className="cal-composer__head">
        <h2>{draftState.mode === "edit" ? "Edit event" : "New event"}</h2>
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
          onApply={onApplyProposal}
          onFind={() => store.findSlots({ durationMinutes })}
          onRetry={() => void store.loadBusy()}
        />
        <Checkbox label="Add video meeting" checked={draft.addOnlineMeeting} onChange={(on) => store.setDraftOnlineMeeting(on)} disabled={saving} />
        <TextField label="Location" value={draft.location} onChange={(location) => store.patchDraft({ location })} maxLength={500} disabled={saving} />
        <TextField label="Description" multiline rows={4} value={draft.descriptionText} onChange={(descriptionText) => store.patchDraft({ descriptionText })} maxLength={8000} disabled={saving} />
        <Select
          label="Repeat"
          value={presetForRecurrence(draft.recurrence)}
          onChange={(value) => {
            if (value !== "custom") store.setDraftRecurrence(recurrenceForPreset(value as RecurrencePreset, draft));
          }}
          options={[
            ...RECURRENCE_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
            ...(presetForRecurrence(draft.recurrence) === "custom" ? [{ value: "custom", label: "Custom" }] : []),
          ]}
          disabled={saving}
        />
        <Select
          label="Reminder"
          value={presetForReminders(draft.reminders)}
          onChange={(value) => store.setDraftReminders(remindersForPreset(value))}
          options={[
            ...REMINDER_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
            ...(presetForReminders(draft.reminders) === "custom" ? [{ value: "custom", label: "Custom" }] : []),
          ]}
          disabled={saving}
        />
        {writable.length > 1 && (
          <Select
            label="Calendar"
            value={draft.calendarId}
            onChange={(calendarId) => store.patchDraft({ calendarId })}
            options={writable.map((calendar) => ({ value: calendar.id, label: calendar.name }))}
            disabled={saving || draftState.mode === "edit"}
          />
        )}
      </div>
      <div className="cal-composer__foot">
        {(attempted || draftState.error) && (issues.length > 0 || draftState.error) && (
          <ul className="cal-composer__errors" role="alert">
            {issues.map((text) => <li key={text}>{text}</li>)}
            {draftState.error && <li>{draftState.error}</li>}
          </ul>
        )}
        <div className="cal-composer__actions">
          <button type="button" className="oui-button" onClick={() => store.closeDraft()} disabled={saving}>Cancel</button>
          <button type="submit" className="oui-button oui-button--primary" disabled={saving} aria-busy={saving || undefined}>
            {saving ? "Saving…" : primaryLabel}
          </button>
        </div>
      </div>
      <ConfirmSend
        open={confirming}
        kind="invite"
        title={draftState.mode === "edit" ? "Send the updated invitation?" : "Send this invitation?"}
        confirmLabel={primaryLabel}
        recipients={recipients}
        summary={`${draft.title.trim()} · ${formatEventWhen(draft, draft.allDay ? state.timeZone : draft.timeZone)}`}
        busy={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await store.saveDraft({ sendInvites: true });
          setConfirming(false);
        }}
      />
    </form>
  );
}
