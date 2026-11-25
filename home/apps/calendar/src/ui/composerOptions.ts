/**
 * Presets the composer offers for recurrence, reminders and time zones,
 * and the mapping between a draft and the selected preset.
 */
import {
  WEEKDAYS,
  instantToMs,
  type EventDraft,
  type EventDraftIssue,
  type EventReminder,
  type Recurrence,
  type Weekday,
} from "../../../_shared/office-accounts/types/calendar";
import { dayKeyAt, weekdayOf } from "../model/dates";

export const RECURRENCE_PRESETS = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday (Monday to Friday)" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Every month" },
  { value: "yearly", label: "Every year" },
] as const;
export type RecurrencePreset = (typeof RECURRENCE_PRESETS)[number]["value"];

const WORK_WEEK: Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

/** The draft's start weekday in its own zone, as an RRULE day. */
export function startWeekday(draft: EventDraft): Weekday {
  const day = dayKeyAt(instantToMs(draft.start), draft.allDay ? "UTC" : draft.timeZone);
  return WEEKDAYS[(weekdayOf(day) + 6) % 7];
}

export function recurrenceForPreset(preset: RecurrencePreset, draft: EventDraft): Recurrence | null {
  switch (preset) {
    case "none":
      return null;
    case "daily":
      return { freq: "daily", interval: 1 };
    case "weekdays":
      return { freq: "weekly", interval: 1, byDay: [...WORK_WEEK] };
    case "weekly":
      return { freq: "weekly", interval: 1, byDay: [startWeekday(draft)] };
    case "biweekly":
      return { freq: "weekly", interval: 2, byDay: [startWeekday(draft)] };
    case "monthly":
      return { freq: "monthly", interval: 1 };
    case "yearly":
      return { freq: "yearly", interval: 1 };
  }
}

/** The preset a draft's recurrence matches; "custom" when it came from elsewhere. */
export function presetForRecurrence(recurrence: Recurrence | undefined): RecurrencePreset | "custom" {
  if (!recurrence) return "none";
  if (recurrence.count !== undefined || recurrence.until !== undefined) return "custom";
  const days = recurrence.byDay ?? [];
  if (recurrence.freq === "daily" && recurrence.interval === 1) return "daily";
  if (recurrence.freq === "monthly" && recurrence.interval === 1) return "monthly";
  if (recurrence.freq === "yearly" && recurrence.interval === 1) return "yearly";
  if (recurrence.freq === "weekly") {
    if (recurrence.interval === 1 && days.length === 5 && WORK_WEEK.every((day) => days.includes(day))) return "weekdays";
    if (days.length <= 1 && recurrence.interval === 1) return "weekly";
    if (days.length <= 1 && recurrence.interval === 2) return "biweekly";
  }
  return "custom";
}

export const REMINDER_PRESETS = [
  { value: "default", label: "Calendar default" },
  { value: "none", label: "No reminder" },
  { value: "0", label: "At the start" },
  { value: "5", label: "5 minutes before" },
  { value: "10", label: "10 minutes before" },
  { value: "15", label: "15 minutes before" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "1440", label: "1 day before" },
] as const;

export function remindersForPreset(value: string): EventReminder[] | null {
  if (value === "default") return null;
  if (value === "none") return [];
  const minutes = Number(value);
  return Number.isInteger(minutes) ? [{ minutesBefore: minutes, method: "popup" }] : null;
}

export function presetForReminders(reminders: readonly EventReminder[] | undefined): string {
  if (reminders === undefined) return "default";
  if (reminders.length === 0) return "none";
  const value = String(reminders[0].minutesBefore);
  return REMINDER_PRESETS.some((preset) => preset.value === value) ? value : "custom";
}

const COMMON_ZONES = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Stockholm", "Europe/Helsinki", "Africa/Johannesburg",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];
const MAX_ZONES = 600;

/** Zones for the picker: every zone the runtime knows (bounded), always including the given ones. */
export function timeZoneOptions(include: readonly string[]): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = COMMON_ZONES;
  if (typeof intl.supportedValuesOf === "function") {
    try {
      zones = intl.supportedValuesOf("timeZone").slice(0, MAX_ZONES);
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  const known = new Set(zones);
  const extra = ["UTC", ...include].filter((zone, index, all) => zone && !known.has(zone) && all.indexOf(zone) === index);
  return [...extra, ...zones];
}

const ISSUE_TEXT: Record<EventDraftIssue, string> = {
  invalid_time: "Enter a valid date and time.",
  end_not_after_start: "The end must be after the start.",
  all_day_not_midnight_utc: "Pick whole days for an all-day event.",
  too_many_attendees: "There are too many guests.",
  invalid_attendee: "Check the guest addresses.",
  invalid_recurrence: "Pick a valid repeat rule.",
  invalid_reminder: "Pick a valid reminder.",
};

export function issueText(issue: EventDraftIssue): string {
  return ISSUE_TEXT[issue];
}

export const TITLE_REQUIRED = "Add a title.";
