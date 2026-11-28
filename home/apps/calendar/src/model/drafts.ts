/**
 * Event drafts: the form state behind "new event" and "edit event".
 *
 * Every helper returns a new draft and never mutates its input. Times follow
 * the contract rule: a timed draft carries instants with the offset of its own
 * `timeZone`; an all-day draft carries midnight UTC dates with an exclusive end.
 */
import { isValidMailAddress } from "../../../_shared/office-accounts/types/addresses";
import {
  MAX_EVENT_ATTENDEES,
  MAX_EVENT_REMINDERS,
  MAX_REMINDER_MINUTES,
  WEEKDAYS,
  allDayDate,
  allDayInstant,
  eventDraftIssues,
  instantFromWallTime,
  instantToMs,
  type CalendarAttendee,
  type CalendarEvent,
  type EventChanges,
  type EventDraft,
  type EventDraftAttendee,
  type EventDraftIssue,
  type EventReminder,
  type IsoInstant,
  type Recurrence,
  type Weekday,
} from "../../../_shared/office-accounts/types/calendar";
import { MS_PER_MINUTE, addDays, compareDayKeys, dayKeyAt, instantAtWall, weekdayOf, zonedInstant, type DayKey } from "./dates";
import type { Proposal } from "./proposals";

export const DEFAULT_DURATION_MINUTES = 30;

export interface DraftState {
  mode: "create" | "edit";
  /** The event being edited; null for a new event. */
  eventId: string | null;
  /** The draft as it was opened, to send only changed fields on save. */
  original: EventDraft | null;
  draft: EventDraft;
  /** The proposal this draft came from; it is removed once the event is created. */
  proposalId: string | null;
  /**
   * Edit drafts only: how the event repeats, as the provider describes it, or
   * null when it does not repeat. An event's repeat rule and reminders are not
   * carried into the draft (see `draftFromEvent`), so they stay unchanged.
   */
  repeat: string | null;
  issues: EventDraftIssue[];
  status: "editing" | "saving";
  /** A fixed, safe sentence; never provider text. */
  error: string | null;
}

export function draftState(draft: EventDraft, extra: Partial<Omit<DraftState, "draft" | "issues">> = {}): DraftState {
  return {
    mode: extra.mode ?? "create",
    eventId: extra.eventId ?? null,
    original: extra.original ?? null,
    draft,
    proposalId: extra.proposalId ?? null,
    repeat: extra.repeat ?? null,
    issues: eventDraftIssues(draft),
    status: extra.status ?? "editing",
    error: extra.error ?? null,
  };
}

/** Replaces the draft inside a state and recomputes its issues. Clears a previous error. */
export function withDraft(state: DraftState, draft: EventDraft): DraftState {
  return { ...state, draft, issues: eventDraftIssues(draft), error: null };
}

export interface DraftBase {
  calendarId: string;
  timeZone: string;
  title?: string;
  attendees?: readonly EventDraftAttendee[];
  location?: string;
  descriptionText?: string;
}

function baseDraft(base: DraftBase, start: IsoInstant, end: IsoInstant, allDay: boolean): EventDraft {
  return {
    calendarId: base.calendarId,
    title: base.title ?? "",
    start,
    end,
    allDay,
    timeZone: allDay ? "UTC" : base.timeZone,
    location: base.location ?? "",
    descriptionText: base.descriptionText ?? "",
    attendees: (base.attendees ?? []).map((attendee) => ({ ...attendee })),
    addOnlineMeeting: false,
  };
}

/** A timed draft for a slot, written with the offsets of `base.timeZone`. */
export function draftFromSlot(slot: { start: IsoInstant; end: IsoInstant }, base: DraftBase): EventDraft {
  return baseDraft(
    base,
    zonedInstant(instantToMs(slot.start), base.timeZone),
    zonedInstant(instantToMs(slot.end), base.timeZone),
    false,
  );
}

/** A timed draft starting at `startMs`, `durationMinutes` long. */
export function draftAt(startMs: number, durationMinutes: number, base: DraftBase): EventDraft {
  return draftFromSlot(
    { start: zonedInstant(startMs, base.timeZone), end: zonedInstant(startMs + durationMinutes * MS_PER_MINUTE, base.timeZone) },
    base,
  );
}

/** A draft for a grid click: wall-clock minutes on a day in `base.timeZone`. */
export function draftForGrid(day: DayKey, startMinute: number, endMinute: number, base: DraftBase): EventDraft {
  return baseDraft(base, instantAtWall(day, startMinute, base.timeZone), instantAtWall(day, endMinute, base.timeZone), false);
}

/** An all-day draft covering `startDay` up to and including `lastDay`. */
export function allDayDraft(startDay: DayKey, lastDay: DayKey, base: DraftBase): EventDraft {
  const last = compareDayKeys(lastDay, startDay) < 0 ? startDay : lastDay;
  return baseDraft(base, allDayInstant(startDay), allDayInstant(addDays(last, 1)), true);
}

export function draftFromProposal(proposal: Proposal, base: DraftBase): EventDraft {
  const timeZone = proposal.timeZone ?? base.timeZone;
  return draftFromSlot(proposal, {
    ...base,
    timeZone,
    title: proposal.title || base.title,
    attendees: proposal.attendees.length > 0 ? proposal.attendees : base.attendees,
    descriptionText: base.descriptionText,
  });
}

function draftAttendee(attendee: CalendarAttendee): EventDraftAttendee {
  const result: EventDraftAttendee = { address: attendee.address };
  if (attendee.name) result.name = attendee.name;
  if (attendee.optional) result.optional = true;
  return result;
}

/** How an existing event repeats, for display: its description, a generic one for a series occurrence, or null. */
export function eventRepeat(event: CalendarEvent): string | null {
  const text = event.recurrenceText?.trim();
  if (text) return text;
  return event.seriesId ? "Repeats" : null;
}

/** The editable fields of an existing event. Recurrence and reminders stay as the provider holds them. */
export function draftFromEvent(event: CalendarEvent): EventDraft {
  return {
    calendarId: event.calendarId,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    timeZone: event.allDay ? "UTC" : event.timeZone,
    location: event.location,
    descriptionText: event.descriptionText,
    attendees: event.attendees.filter((attendee) => !attendee.organizer).map(draftAttendee),
    addOnlineMeeting: Boolean(event.onlineMeeting),
  };
}

/** The draft's start weekday in its own zone (UTC for an all-day draft), as an RRULE day. */
export function startWeekday(draft: Pick<EventDraft, "start" | "allDay" | "timeZone">): Weekday {
  const day = dayKeyAt(instantToMs(draft.start), draft.allDay ? "UTC" : draft.timeZone);
  return WEEKDAYS[(weekdayOf(day) + 6) % 7];
}

/**
 * After the start moved: a weekly rule that names only the old start's weekday
 * ("Every week" on Tuesday) moves to the new start's weekday, so the series
 * keeps repeating on the day the event is on. A rule on several days is the
 * owner's own choice and stays.
 */
function followStartWeekday(previous: EventDraft, next: EventDraft): EventDraft {
  const rule = next.recurrence;
  if (rule?.freq !== "weekly" || rule.byDay?.length !== 1) return next;
  const before = startWeekday(previous);
  const after = startWeekday(next);
  if (rule.byDay[0] !== before || before === after) return next;
  return { ...next, recurrence: { ...rule, byDay: [after] } };
}

/** Wall-clock start and end (`YYYY-MM-DDTHH:mm`) in the draft's zone, or another zone. */
export function setDraftTimes(draft: EventDraft, startWall: string, endWall: string, timeZone = draft.timeZone): EventDraft {
  const seconds = (wall: string) => (wall.length === 16 ? `${wall}:00` : wall);
  return followStartWeekday(draft, {
    ...draft,
    allDay: false,
    timeZone,
    start: instantFromWallTime(seconds(startWall), timeZone),
    end: instantFromWallTime(seconds(endWall), timeZone),
  });
}

/** Moves the start and keeps the duration. */
export function moveDraft(draft: EventDraft, startMs: number): EventDraft {
  const duration = instantToMs(draft.end) - instantToMs(draft.start);
  if (draft.allDay) {
    const days = Math.max(1, Math.round(duration / (1440 * MS_PER_MINUTE)));
    const day = new Date(startMs).toISOString().slice(0, 10);
    return followStartWeekday(draft, { ...draft, start: allDayInstant(day), end: allDayInstant(addDays(day, days)) });
  }
  return followStartWeekday(draft, { ...draft, start: zonedInstant(startMs, draft.timeZone), end: zonedInstant(startMs + duration, draft.timeZone) });
}

/**
 * Switches between timed and all-day. To all-day: the days the timed draft
 * touches in `timeZone`. To timed: 09:00 for `DEFAULT_DURATION_MINUTES` on the
 * first day, in `timeZone`.
 */
export function setDraftAllDay(draft: EventDraft, allDay: boolean, timeZone: string): EventDraft {
  if (allDay === draft.allDay) return draft;
  if (allDay) {
    const zone = draft.timeZone || timeZone;
    const startMs = instantToMs(draft.start);
    const endMs = Math.max(startMs + 1, instantToMs(draft.end));
    const first = dayKeyAt(startMs, zone);
    const last = dayKeyAt(endMs - 1, zone);
    return followStartWeekday(draft, { ...draft, allDay: true, timeZone: "UTC", start: allDayInstant(first), end: allDayInstant(addDays(last, 1)) });
  }
  const day = allDayDate(draft.start);
  return followStartWeekday(draft, {
    ...draft,
    allDay: false,
    timeZone,
    start: instantAtWall(day, 9 * 60, timeZone),
    end: instantAtWall(day, 9 * 60 + DEFAULT_DURATION_MINUTES, timeZone),
  });
}

/** Adds an attendee once (by lower-cased address). Invalid addresses and a full list leave the draft unchanged. */
export function addDraftAttendee(draft: EventDraft, attendee: EventDraftAttendee): EventDraft {
  const address = attendee.address.trim().toLowerCase();
  if (!isValidMailAddress(address) || draft.attendees.length >= MAX_EVENT_ATTENDEES) return draft;
  if (draft.attendees.some((existing) => existing.address.toLowerCase() === address)) return draft;
  const next: EventDraftAttendee = { address };
  const name = attendee.name?.replace(/[\r\n]+/g, " ").trim();
  if (name) next.name = name.slice(0, 120);
  if (attendee.optional) next.optional = true;
  return { ...draft, attendees: [...draft.attendees, next] };
}

export function removeDraftAttendee(draft: EventDraft, address: string): EventDraft {
  const target = address.trim().toLowerCase();
  return { ...draft, attendees: draft.attendees.filter((attendee) => attendee.address.toLowerCase() !== target) };
}

export function setAttendeeOptional(draft: EventDraft, address: string, optional: boolean): EventDraft {
  const target = address.trim().toLowerCase();
  return {
    ...draft,
    attendees: draft.attendees.map((attendee) => {
      if (attendee.address.toLowerCase() !== target) return attendee;
      const next: EventDraftAttendee = { ...attendee };
      if (optional) next.optional = true;
      else delete next.optional;
      return next;
    }),
  };
}

export function setDraftOnlineMeeting(draft: EventDraft, on: boolean): EventDraft {
  return { ...draft, addOnlineMeeting: on };
}

/** Sets or clears (`null`) the recurrence. Validity shows up in the draft's issues. */
export function setDraftRecurrence(draft: EventDraft, recurrence: Recurrence | null): EventDraft {
  const next = { ...draft };
  if (recurrence) next.recurrence = { ...recurrence, ...(recurrence.byDay ? { byDay: [...recurrence.byDay] } : {}) } as Recurrence;
  else delete next.recurrence;
  return next;
}

/**
 * Sets reminders: whole minutes within bounds, one per method and time,
 * soonest first, at most `MAX_EVENT_REMINDERS`. `null` restores the calendar's defaults.
 */
export function setDraftReminders(draft: EventDraft, reminders: readonly EventReminder[] | null): EventDraft {
  const next = { ...draft };
  if (reminders === null) {
    delete next.reminders;
    return next;
  }
  const seen = new Set<string>();
  const cleaned: EventReminder[] = [];
  for (const reminder of reminders) {
    if (!Number.isInteger(reminder.minutesBefore) || reminder.minutesBefore < 0 || reminder.minutesBefore > MAX_REMINDER_MINUTES) continue;
    if (reminder.method !== "popup" && reminder.method !== "email") continue;
    const key = `${reminder.method}:${reminder.minutesBefore}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ minutesBefore: reminder.minutesBefore, method: reminder.method });
  }
  next.reminders = cleaned.sort((a, b) => a.minutesBefore - b.minutesBefore).slice(0, MAX_EVENT_REMINDERS);
  return next;
}

const CHANGE_FIELDS = [
  "title", "start", "end", "allDay", "timeZone", "location", "descriptionText",
  "attendees", "addOnlineMeeting", "recurrence", "reminders",
] as const satisfies readonly (keyof EventChanges)[];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only the fields that differ between the opened draft and the edited one. Times travel together. */
export function draftChanges(original: EventDraft, next: EventDraft): EventChanges {
  const changes: Record<string, unknown> = {};
  for (const field of CHANGE_FIELDS) {
    if (!sameValue(original[field], next[field])) changes[field] = next[field];
  }
  // A video meeting can be added to an existing event, never removed: providers keep the link.
  if (changes.addOnlineMeeting === false) delete changes.addOnlineMeeting;
  if ("start" in changes || "end" in changes || "allDay" in changes || "timeZone" in changes) {
    changes.start = next.start;
    changes.end = next.end;
    changes.allDay = next.allDay;
    changes.timeZone = next.timeZone;
  }
  return changes as EventChanges;
}

function attendeesFromDraft(attendees: readonly EventDraftAttendee[], previous: readonly CalendarAttendee[] = []): CalendarAttendee[] {
  return attendees.map((attendee) => {
    const known = previous.find((item) => item.address.toLowerCase() === attendee.address.toLowerCase());
    const result: CalendarAttendee = {
      address: attendee.address,
      name: attendee.name ?? known?.name ?? "",
      response: known?.response ?? "needsAction",
      organizer: false,
    };
    if (attendee.optional) result.optional = true;
    return result;
  });
}

/** The event to show on the grid while a create is in flight. */
export function eventFromDraft(draft: EventDraft, id: string): CalendarEvent {
  return {
    id,
    calendarId: draft.calendarId,
    title: draft.title,
    start: draft.start,
    end: draft.end,
    allDay: draft.allDay,
    timeZone: draft.timeZone,
    location: draft.location,
    descriptionText: draft.descriptionText,
    attendees: attendeesFromDraft(draft.attendees),
    myResponse: null,
  };
}

/** The event to show while an update is in flight. */
export function applyEventChanges(event: CalendarEvent, changes: EventChanges): CalendarEvent {
  const next: CalendarEvent = { ...event };
  if (changes.title !== undefined) next.title = changes.title;
  if (changes.start !== undefined) next.start = changes.start;
  if (changes.end !== undefined) next.end = changes.end;
  if (changes.allDay !== undefined) next.allDay = changes.allDay;
  if (changes.timeZone !== undefined) next.timeZone = changes.timeZone;
  if (changes.location !== undefined) next.location = changes.location;
  if (changes.descriptionText !== undefined) next.descriptionText = changes.descriptionText;
  if (changes.attendees !== undefined) {
    const organizers = event.attendees.filter((attendee) => attendee.organizer);
    next.attendees = [...organizers, ...attendeesFromDraft(changes.attendees, event.attendees)];
  }
  return next;
}
