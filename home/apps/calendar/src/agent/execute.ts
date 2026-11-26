/**
 * Runs a validated intent against the calendar.
 *
 * Read intents (agenda, find slots) answer with events and slots by id so the
 * UI can highlight them. Write intents (propose times, draft event, reschedule)
 * only ever produce proposals or an `EventDraft` for the composer: the deps
 * give this module no way to create, change or delete an event.
 */
import {
  MAX_EVENT_ATTENDEES,
  eventDraftIssues,
  instantToMs,
  isValidRecurrence,
  type EventDraft,
  type Recurrence,
} from "../../../_shared/office-accounts/types/calendar";
import { MS_PER_MINUTE, addDays, compareDayKeys, dayKeyAt, zonedInstant } from "../model/dates";
import { parseProposals } from "../model/proposals";
import { NO_CALENDAR_MESSAGE, defaultCalendar } from "../model/store-schedule";
import { cappedAddresses, resolvePeople, searchAtTime, searchAvailability, startsAtTime, type ResolvedPeople } from "./availability";
import { clockLabel, durationLabel, eventLabel, eventRef, firstOf, plural, rangeLabel, slotRef, windowLabel } from "./describe";
import { MAX_INTENT_ATTENDEES } from "./parse-intent";
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
  PeopleRef,
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
const DEFAULT_RESCHEDULE_COUNT = 3;
/** An agenda lists at most this many events; the answer still counts all of them. */
export const MAX_AGENDA_EVENTS = 50;
const DEFAULT_SEARCH: WindowRef = { type: "next_days", days: 7 };
const UNCLEAR_WINDOW = "I could not work out which days you meant. Try naming them, for example \"this week\" or \"before Friday\".";
const NOTHING_SENT = "Nothing is sent until you open it and send it yourself.";

function blank(kind: "clarify" | "error", text: string, notes: string[] = []): CalendarAgentAnswer {
  return { kind, text, notes, events: [], slots: [] };
}

function windowFor(ref: WindowRef | null, fallback: WindowRef, context: CalendarAgentContext, fromNow: boolean): ResolvedWindow | null {
  return resolveWindow(ref ?? fallback, context, { fromNow });
}

function leftOutNote(leftOut: number): string[] {
  return leftOut > 0 ? [`An event can have at most ${MAX_EVENT_ATTENDEES} guests, so ${plural(leftOut, "person", "people")} ${leftOut === 1 ? "was" : "were"} left out.`] : [];
}

/** Everything the owner should know about the people a request named: unknown names, and anyone left out. */
function peopleNotes(people: ResolvedPeople, ref: PeopleRef): string[] {
  const notes = people.unresolved.length > 0 ? [`I could not find an address for ${people.unresolved.join(", ")}. Add them by address to include them.`] : [];
  if (ref.attendeesCut) notes.push(`I used up to ${MAX_INTENT_ATTENDEES} of the people you named. Add the others in the draft.`);
  return [...notes, ...leftOutNote(people.leftOut)];
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
  const sorted = [...events].sort((a, b) => instantToMs(a.start) - instantToMs(b.start));
  const shown = sorted.slice(0, MAX_AGENDA_EVENTS);
  const label = windowLabel(window, context.timeZone);
  // The count is the whole range; a shortened list says it is one.
  const partial = shown.length < sorted.length ? ` Showing the first ${shown.length} of ${sorted.length}.` : "";
  const text = sorted.length === 0
    ? `Nothing on your calendar for ${label}.`
    : `${plural(sorted.length, "event")} on your calendar for ${label}.${partial}`;
  return { kind: "agenda", text, notes: [], events: shown.map(eventRef), slots: [], window };
}

async function slotsFor(
  intent: FindSlotsIntent | ProposeTimesIntent,
  options: ExecuteOptions,
): Promise<{ window: ResolvedWindow; addresses: string[]; duration: number; count: number; slots: CalendarAgentAnswer["slots"]; notes: string[]; failed: boolean } | null> {
  const { context, deps } = options;
  const window = windowFor(intent.window, DEFAULT_SEARCH, context, true);
  if (!window) return null;
  const people = resolvePeople(intent, context, options.people, options.aliases);
  const named = people.addresses.length > 0 || intent.attendees.length > 0 || intent.attendeesFromEvent;
  // "We" with no names means the people already in the scheduling assistant, every one of them.
  const assistant = named ? null : cappedAddresses(context.assistantAttendees.map((address) => address.trim().toLowerCase()), context.ownerAddress?.toLowerCase() ?? null);
  const addresses = assistant ? assistant.addresses : people.addresses;
  const duration = intent.durationMinutes ?? context.defaultDurationMinutes;
  const count = intent.count ?? DEFAULT_SLOT_COUNT;
  const result = await searchAvailability({ addresses, window, durationMinutes: duration, count }, context, deps);
  const notes = [...peopleNotes(people, intent), ...leftOutNote(assistant?.leftOut ?? 0), ...result.notes];
  return { window, addresses, duration, count, slots: result.slots, notes, failed: result.failed };
}

async function findSlotsAnswer(intent: FindSlotsIntent, options: ExecuteOptions): Promise<CalendarAgentAnswer> {
  const found = await slotsFor(intent, options);
  if (!found) return blank("clarify", UNCLEAR_WINDOW);
  if (found.failed) return blank("error", "Could not read your calendar. Try again.", found.notes);
  const who = found.addresses.length > 0 ? `you and ${plural(found.addresses.length, "other person", "other people")} are` : "you are";
  const label = windowLabel(found.window, options.context.timeZone);
  const text = found.slots.length === 0
    ? `No ${durationLabel(found.duration)} slot where ${who} free in working hours, ${label}.`
    : `${firstOf(found.slots.length, found.count, "time")} when ${who} free for ${durationLabel(found.duration)}, ${label}.`;
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
  const notes = peopleNotes(people, intent);
  const duration = intent.durationMinutes ?? context.defaultDurationMinutes;
  const day = intent.date ? resolveDateRef(intent.date, context) : null;
  if (intent.date && !day) return blank("clarify", UNCLEAR_WINDOW);
  const minute = parseWallTime(intent.time);

  let startMs: number | null = null;
  if (day && minute !== null) {
    startMs = instantToMs(instantOnDay(day, minute, context));
  } else if (minute !== null && intent.window) {
    // A time within a stretch of days: that exact time, on the first of those days everyone is free.
    const window = windowFor(intent.window, DEFAULT_SEARCH, context, true);
    if (!window) return blank("clarify", UNCLEAR_WINDOW);
    const starts = startsAtTime(window, minute, context);
    if (starts.length === 0) return blank("clarify", `${clockLabel(minute)} has passed on every day you named. Tell me the date.`);
    const found = await searchAtTime({ addresses: people.addresses, window, minuteOfDay: minute, lengthMs: duration * MS_PER_MINUTE, count: 1 }, context, deps);
    notes.push(...found.notes);
    if (found.slots[0]) startMs = instantToMs(found.slots[0].start);
    else {
      startMs = starts[0];
      // A failed read already says so; it is not a finding that nobody is free.
      if (!found.failed) notes.push(`I found no day when everyone is free at ${clockLabel(minute)}, so check the time in the draft.`);
    }
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
  if (intent.date && !day) return blank("clarify", UNCLEAR_WINDOW);
  const minute = parseWallTime(intent.time);
  // A move keeps the event's length and guests; asking to change them is answered, not dropped.
  const keeps = intent.asksForChanges ? [`Moving "${event.title}" keeps its length and guests. Change those in the draft.`] : [];
  if (day && minute !== null) {
    const slot = slotFrom(instantToMs(instantOnDay(day, minute, context)));
    return {
      kind: "reschedule", eventId: event.id, durationMinutes: duration, events: [ref], slots: [slot], notes: keeps,
      text: `Move "${event.title}" to ${rangeLabel(slot.start, slot.end, context.timeZone)}? Open the draft to check and send the update. ${NOTHING_SENT}`,
    };
  }
  const window = day
    ? resolveWindow({ type: "day", date: { type: "date", date: day } }, context, { fromNow: true })
    : windowFor(intent.window, DEFAULT_SEARCH, context, true);
  if (!window) return blank("clarify", UNCLEAR_WINDOW);
  const owner = context.ownerAddress?.toLowerCase() ?? null;
  // Every guest is checked (the app reads them in batches), so "everyone is free" means everyone.
  const guests = cappedAddresses(event.attendees.map((attendee) => attendee.address.trim().toLowerCase()), owner);
  const addresses = guests.addresses;
  const count = intent.count ?? DEFAULT_RESCHEDULE_COUNT;
  const label = windowLabel(window, context.timeZone);
  if (minute !== null) {
    // A time with no date: that exact time on the days ahead, never another time of day.
    const clock = clockLabel(minute);
    const found = await searchAtTime(
      { addresses, window, minuteOfDay: minute, lengthMs, count, excludeEventId: event.id, skipStartMs: instantToMs(event.start) },
      context,
      deps,
    );
    if (found.failed) return blank("error", "Could not read your calendar. Try again.", found.notes);
    const notes = [...keeps, ...leftOutNote(guests.leftOut), ...found.notes];
    const text = found.slots.length === 0
      ? `No day when everyone on "${event.title}" is free at ${clock}, ${label}. Tell me the date to move it to.`
      : `${firstOf(found.slots.length, count, "time")} to move "${event.title}" (${eventLabel(ref, context.timeZone)}) to ${clock} when everyone is free. Pick one to open the draft. ${NOTHING_SENT}`;
    return { kind: "reschedule", eventId: event.id, durationMinutes: duration, events: [ref], slots: found.slots, notes, text };
  }
  // Free time is searched inside working hours, whole minutes at a time; a longer event cannot fit, so the owner names the time.
  const searchMinutes = Math.max(1, Math.ceil(duration));
  if (searchMinutes > context.workingHours.endMinute - context.workingHours.startMinute) {
    return blank("clarify", `"${event.title}" lasts ${durationLabel(searchMinutes)}, longer than your working hours, so I cannot look for a free time for it. Tell me the date and time to move it to.`);
  }
  const found = await searchAvailability({ addresses, window, durationMinutes: searchMinutes, count: count + 1, excludeEventId: event.id }, context, deps);
  if (found.failed) return blank("error", "Could not read your calendar. Try again.", found.notes);
  // The event's current time is not a new time. A free slot of the rounded-up length holds the exact one.
  found.slots = found.slots
    .filter((slot) => instantToMs(slot.start) !== instantToMs(event.start))
    .slice(0, count)
    .map((slot) => slotFrom(instantToMs(slot.start)));
  const text = found.slots.length === 0
    ? `No time when everyone on "${event.title}" is free, ${label}.`
    : `${firstOf(found.slots.length, count, "time")} to move "${event.title}" (${eventLabel(ref, context.timeZone)}) when everyone is free. Pick one to open the draft. ${NOTHING_SENT}`;
  return { kind: "reschedule", eventId: event.id, durationMinutes: duration, events: [ref], slots: found.slots, notes: [...keeps, ...leftOutNote(guests.leftOut), ...found.notes], text };
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
