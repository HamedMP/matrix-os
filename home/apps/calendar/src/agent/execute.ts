/**
 * Runs a validated intent against the calendar.
 *
 * Read intents (agenda, find slots) answer with events and slots by id so the
 * UI can highlight them. Write intents (propose times, draft event, reschedule)
 * only ever produce proposals or an `EventDraft` for the composer: the deps
 * give this module no way to create, change or delete an event.
 */
import {
  eventDraftIssues,
  instantToMs,
  isValidRecurrence,
  type EventDraft,
  type Recurrence,
} from "../../../_shared/office-accounts/types/calendar";
import { MS_PER_MINUTE, addDays, compareDayKeys, dayKeyAt, zonedInstant } from "../model/dates";
import { parseProposals } from "../model/proposals";
import { NO_CALENDAR_MESSAGE, defaultCalendar } from "../model/store-schedule";
import { resolvePeople, searchAvailability } from "./availability";
import { durationLabel, eventLabel, eventRef, plural, rangeLabel, slotRef, windowLabel } from "./describe";
import type { PeopleEntry } from "./prompt";
import { endOfDayInstant, instantOnDay, parseWallTime, resolveDateRef, resolveWindow, todayKey } from "./relative-dates";
import type {
  AgendaIntent,
  CalendarAgentAnswer,
  CalendarAgentContext,
  CalendarAgentDeps,
  CalendarIntent,
  DraftEventIntent,
  FindSlotsIntent,
  ProposeTimesIntent,
  RecurrenceRef,
  RescheduleIntent,
  ResolvedWindow,
  WindowRef,
} from "./types";

export interface ExecuteOptions {
  context: CalendarAgentContext;
  deps: CalendarAgentDeps;
  people: readonly PeopleEntry[];
  aliases: Readonly<Record<string, string>>;
}

const DEFAULT_SLOT_COUNT = 5;
const DEFAULT_SEARCH: WindowRef = { type: "next_days", days: 7 };
const UNCLEAR_WINDOW = "I could not work out which days you meant. Try naming them, for example \"this week\" or \"before Friday\".";
const NOTHING_SENT = "Nothing is sent until you open it and send it yourself.";

function blank(kind: "clarify" | "error", text: string, notes: string[] = []): CalendarAgentAnswer {
  return { kind, text, notes, events: [], slots: [] };
}

function windowFor(ref: WindowRef | null, fallback: WindowRef, context: CalendarAgentContext, fromNow: boolean): ResolvedWindow | null {
  return resolveWindow(ref ?? fallback, context, { fromNow });
}

function nameNotes(unresolved: readonly string[]): string[] {
  return unresolved.length > 0 ? [`I could not find an address for ${unresolved.join(", ")}. Add them by address to include them.`] : [];
}

async function agenda(intent: AgendaIntent, { context, deps }: ExecuteOptions): Promise<CalendarAgentAnswer> {
  const window = windowFor(intent.window, { type: "day", date: { type: "today" } }, context, false);
  if (!window) return blank("clarify", UNCLEAR_WINDOW);
  let events;
  try {
    events = await deps.listEvents(window.start, window.end);
  } catch (error: unknown) {
    deps.log?.("agent: list events", error);
    return blank("error", "Could not read your calendar. Try again.");
  }
  const sorted = [...events].sort((a, b) => instantToMs(a.start) - instantToMs(b.start)).slice(0, 50);
  const label = windowLabel(window, context.timeZone);
  const text = sorted.length === 0
    ? `Nothing on your calendar for ${label}.`
    : `${plural(sorted.length, "event")} on your calendar for ${label}.`;
  return { kind: "agenda", text, notes: [], events: sorted.map(eventRef), slots: [], window };
}

async function slotsFor(
  intent: FindSlotsIntent | ProposeTimesIntent,
  options: ExecuteOptions,
): Promise<{ window: ResolvedWindow; addresses: string[]; duration: number; slots: CalendarAgentAnswer["slots"]; notes: string[]; failed: boolean } | null> {
  const { context, deps } = options;
  const window = windowFor(intent.window, DEFAULT_SEARCH, context, true);
  if (!window) return null;
  const people = resolvePeople(intent, context, options.people, options.aliases);
  const addresses = people.addresses.length > 0 || intent.attendees.length > 0 || intent.attendeesFromEvent
    ? people.addresses
    : context.assistantAttendees.filter((address) => address !== context.ownerAddress).slice(0, 20);
  const duration = intent.durationMinutes ?? context.defaultDurationMinutes;
  const result = await searchAvailability({ addresses, window, durationMinutes: duration, count: intent.count ?? DEFAULT_SLOT_COUNT }, context, deps);
  return { window, addresses, duration, slots: result.slots, notes: [...nameNotes(people.unresolved), ...result.notes], failed: result.failed };
}

async function findSlotsAnswer(intent: FindSlotsIntent, options: ExecuteOptions): Promise<CalendarAgentAnswer> {
  const found = await slotsFor(intent, options);
  if (!found) return blank("clarify", UNCLEAR_WINDOW);
  if (found.failed) return blank("error", "Could not read your calendar. Try again.", found.notes);
  const who = found.addresses.length > 0 ? `you and ${plural(found.addresses.length, "other person", "other people")} are` : "you are";
  const label = windowLabel(found.window, options.context.timeZone);
  const text = found.slots.length === 0
    ? `No ${durationLabel(found.duration)} slot where ${who} free in working hours, ${label}.`
    : `${plural(found.slots.length, "time")} when ${who} free for ${durationLabel(found.duration)}, ${label}.`;
  return { kind: "slots", text, notes: found.notes, events: [], slots: found.slots, window: found.window, attendees: found.addresses };
}

async function proposeAnswer(intent: ProposeTimesIntent, options: ExecuteOptions): Promise<CalendarAgentAnswer> {
  const found = await slotsFor(intent, options);
  if (!found) return blank("clarify", UNCLEAR_WINDOW);
  if (found.failed) return blank("error", "Could not read your calendar. Try again.", found.notes);
  const calendar = defaultCalendar(options.context.calendars);
  const proposals = parseProposals(found.slots.map((slot) => ({
    start: slot.start,
    end: slot.end,
    title: intent.title,
    attendees: found.addresses.map((address) => ({ address })),
    note: "Suggested by the agent",
    calendarId: calendar?.id,
    timeZone: options.context.timeZone,
  })), "agent");
  const text = proposals.length === 0
    ? `No free ${durationLabel(found.duration)} slot to suggest, ${windowLabel(found.window, options.context.timeZone)}.`
    : `${plural(proposals.length, "suggested time")} for ${intent.title ? `"${intent.title}"` : "the meeting"} on your calendar. Pick one to open a draft. ${NOTHING_SENT}`;
  return { kind: "proposals", text, notes: found.notes, events: [], slots: found.slots, window: found.window, proposals };
}

function recurrenceFor(ref: RecurrenceRef | null, startDay: string, options: ExecuteOptions, notes: string[]): Recurrence | undefined {
  if (!ref) return undefined;
  const { context } = options;
  let recurrence: Recurrence = { freq: ref.freq, interval: ref.interval, ...(ref.byDay ? { byDay: ref.byDay } : {}) } as Recurrence;
  if (ref.until) {
    const day = resolveDateRef(ref.until, context);
    if (!day || compareDayKeys(day, startDay) < 0) {
      notes.push("The end date of the series was before its first meeting, so the draft repeats with no end date. Set one in the draft.");
    } else {
      recurrence = { ...recurrence, until: endOfDayInstant(day, context) } as Recurrence;
    }
  } else if (ref.count !== undefined) {
    recurrence = { ...recurrence, count: ref.count } as Recurrence;
  }
  if (!isValidRecurrence(recurrence)) {
    notes.push("I could not set up the repeat; set it in the draft.");
    return undefined;
  }
  return recurrence;
}

async function draftAnswer(intent: DraftEventIntent, options: ExecuteOptions): Promise<CalendarAgentAnswer> {
  const { context, deps } = options;
  const calendar = defaultCalendar(context.calendars);
  if (!calendar) return blank("error", NO_CALENDAR_MESSAGE);
  const people = resolvePeople(intent, context, options.people, options.aliases);
  const notes = nameNotes(people.unresolved);
  const duration = intent.durationMinutes ?? context.defaultDurationMinutes;
  const day = intent.date ? resolveDateRef(intent.date, context) : null;
  if (intent.date && !day) return blank("clarify", UNCLEAR_WINDOW);
  const minute = parseWallTime(intent.time);

  let startMs: number | null = null;
  if (day && minute !== null) {
    startMs = instantToMs(instantOnDay(day, minute, context));
  } else if (minute !== null) {
    const today = todayKey(context);
    const todayAt = instantToMs(instantOnDay(today, minute, context));
    startMs = todayAt > context.now ? todayAt : instantToMs(instantOnDay(addDays(today, 1), minute, context));
  } else {
    const window = day ? resolveWindow({ type: "day", date: { type: "date", date: day } }, context, { fromNow: true }) : windowFor(intent.window, DEFAULT_SEARCH, context, true);
    if (!window) return blank("clarify", UNCLEAR_WINDOW);
    const found = await searchAvailability({ addresses: people.addresses, window, durationMinutes: duration, count: 1 }, context, deps);
    notes.push(...found.notes);
    if (found.slots[0]) startMs = instantToMs(found.slots[0].start);
    else {
      const step = 30 * MS_PER_MINUTE;
      startMs = day ? instantToMs(instantOnDay(day, context.workingHours.startMinute, context)) : Math.ceil(context.now / step) * step;
      notes.push("I found no free time for everyone, so pick a time in the draft.");
    }
  }

  const start = zonedInstant(startMs, context.timeZone);
  const end = zonedInstant(startMs + duration * MS_PER_MINUTE, context.timeZone);
  const draft: EventDraft = {
    calendarId: calendar.id,
    title: intent.title,
    start,
    end,
    allDay: false,
    timeZone: context.timeZone,
    location: intent.location,
    descriptionText: intent.description,
    attendees: people.addresses.map((address) => ({ address })),
    addOnlineMeeting: intent.onlineMeeting,
  };
  const recurrence = recurrenceFor(intent.recurrence, dayKeyAt(startMs, context.timeZone), options, notes);
  if (recurrence) draft.recurrence = recurrence;
  if (eventDraftIssues(draft).length > 0) return blank("error", "I could not put that draft together. Try again with a date and time.");
  const repeat = recurrence ? " (repeats)" : "";
  const text = `Draft ready: ${intent.title ? `"${intent.title}", ` : ""}${rangeLabel(start, end, context.timeZone)}${repeat}${people.addresses.length > 0 ? ` with ${plural(people.addresses.length, "person", "people")}` : ""}. ${NOTHING_SENT}`;
  return { kind: "draft", text, notes, events: [], slots: [slotRef(start, end)], draft };
}

async function rescheduleAnswer(intent: RescheduleIntent, options: ExecuteOptions): Promise<CalendarAgentAnswer> {
  const { context, deps } = options;
  const id = options.aliases[intent.event];
  const event = context.events.find((item) => item.id === id);
  if (!event) return blank("clarify", "Which event should I move? I could not find it on your calendar.");
  if (event.allDay) return blank("clarify", "All-day events are moved in the event editor. Open the event to change its dates.");
  if (!context.calendars.some((calendar) => calendar.id === event.calendarId && calendar.writable)) {
    return blank("error", "That event is on a calendar you cannot change.");
  }
  // The move keeps the event's exact length; every slot offered is that long.
  const lengthMs = Math.max(0, instantToMs(event.end) - instantToMs(event.start));
  const duration = lengthMs / MS_PER_MINUTE;
  const slotFrom = (startMs: number) => slotRef(zonedInstant(startMs, context.timeZone), zonedInstant(startMs + lengthMs, context.timeZone));
  const ref = eventRef(event);
  const day = intent.date ? resolveDateRef(intent.date, context) : null;
  const minute = parseWallTime(intent.time);
  if (day && minute !== null) {
    const slot = slotFrom(instantToMs(instantOnDay(day, minute, context)));
    return {
      kind: "reschedule", eventId: event.id, durationMinutes: duration, events: [ref], slots: [slot], notes: [],
      text: `Move "${event.title}" to ${rangeLabel(slot.start, slot.end, context.timeZone)}? Open the draft to check and send the update. ${NOTHING_SENT}`,
    };
  }
  const window = day
    ? resolveWindow({ type: "day", date: { type: "date", date: day } }, context, { fromNow: true })
    : windowFor(intent.window, DEFAULT_SEARCH, context, true);
  if (!window) return blank("clarify", UNCLEAR_WINDOW);
  // Free time is searched inside working hours, whole minutes at a time; a longer event cannot fit, so the owner names the time.
  const searchMinutes = Math.max(1, Math.ceil(duration));
  if (searchMinutes > context.workingHours.endMinute - context.workingHours.startMinute) {
    return blank("clarify", `"${event.title}" lasts ${durationLabel(searchMinutes)}, longer than your working hours, so I cannot look for a free time for it. Tell me the date and time to move it to.`);
  }
  const owner = context.ownerAddress?.toLowerCase() ?? null;
  const addresses = [...new Set(event.attendees.map((attendee) => attendee.address.trim().toLowerCase()))].filter((address) => address !== owner).slice(0, 20);
  const count = intent.count ?? 3;
  const found = await searchAvailability({ addresses, window, durationMinutes: searchMinutes, count: count + 1, excludeEventId: event.id }, context, deps);
  if (found.failed) return blank("error", "Could not read your calendar. Try again.", found.notes);
  // The event's current time is not a new time. A free slot of the rounded-up length holds the exact one.
  found.slots = found.slots
    .filter((slot) => instantToMs(slot.start) !== instantToMs(event.start))
    .slice(0, count)
    .map((slot) => slotFrom(instantToMs(slot.start)));
  const text = found.slots.length === 0
    ? `No time when everyone on "${event.title}" is free, ${windowLabel(window, context.timeZone)}.`
    : `${plural(found.slots.length, "time")} to move "${event.title}" (${eventLabel(ref, context.timeZone)}) when everyone is free. Pick one to open the draft. ${NOTHING_SENT}`;
  return { kind: "reschedule", eventId: event.id, durationMinutes: duration, events: [ref], slots: found.slots, notes: found.notes, text };
}

/** Runs one intent. Never throws for provider failures; they become an "error" answer with a fixed sentence. */
export async function executeIntent(intent: CalendarIntent, options: ExecuteOptions): Promise<CalendarAgentAnswer> {
  switch (intent.type) {
    case "agenda":
      return agenda(intent, options);
    case "find_slots":
      return findSlotsAnswer(intent, options);
    case "propose_times":
      return proposeAnswer(intent, options);
    case "draft_event":
      return draftAnswer(intent, options);
    case "reschedule":
      return rescheduleAnswer(intent, options);
    case "clarify":
      return blank("clarify", intent.question);
  }
}
