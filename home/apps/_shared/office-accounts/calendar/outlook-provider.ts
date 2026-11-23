/**
 * Outlook Calendar behind `CalendarProvider`, through the
 * `microsoft_outlook_calendar` integration actions (see
 * `specs/2710-office-mail-suite/integration-actions.md`).
 *
 * Outlook tells guests about every change to a meeting on its own. When the
 * owner has not agreed to notify anyone (`sendInvites: false`), a write that
 * would reach guests is refused with `not_supported` instead.
 */
import { CALENDAR_SERVICE_IDS, ProviderError, instantInZone, instantToMs, toUtcInstant, wallTimeOf } from "../types/calendar.js";
import type {
  BusyBlock,
  BusyStatus,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  EventChanges,
  EventDraft,
  EventDraftAttendee,
  EventResponse,
  InviteOptions,
  IsoInstant,
  ListEventsRequest,
  RespondOptions,
} from "../types/calendar.js";
import { mergeBusyIntervals, unknownBlock } from "./busy.js";
import type { BusyInterval } from "./busy.js";
import {
  EventCache,
  allDayDates,
  freeBusyAddresses,
  normalizeAttendees,
  notSupported,
  requireAttendees,
  requireDraft,
  requireEventId,
  requireLength,
  requireRange,
  requireTitle,
  resolveChangedTimes,
  sortEvents,
} from "./common.js";
import type { CachedEvent, ResolvedTimes } from "./common.js";
import { GRAPH_ID, graphInstant, normalizeOutlookCalendar, normalizeOutlookEvent } from "./outlook-normalize.js";
import { graphRecurrence } from "./recurrence.js";
import { asArray, asRecord, asString, createCalendarCaller, requireRecord } from "./service.js";
import type { CalendarProviderOptions, JsonRecord } from "./service.js";
import { ianaZone } from "./zones.js";

const CALENDAR_PAGE_SIZE = 100;
/** Events carry their HTML bodies, so pages stay small to fit the reply cap. */
const EVENT_PAGE_SIZE = 50;
const MAX_CALENDAR_PAGES = 10;
const MAX_EVENT_PAGES = 50;
const MAX_SKIP = 100_000;
const MAX_SUBJECT = 255;
const MAX_LOCATION = 255;
const MAX_BODY = 8192;
const MAX_COMMENT = 1024;
const MAX_ATTENDEES = 100;

const SCHEDULE_STATUS: Readonly<Record<string, BusyStatus>> = {
  busy: "busy", tentative: "tentative", oof: "outOfOffice", unknown: "unknown",
};

/** The `$skip` of Graph's next link, or undefined when there is no further page. */
export function skipFromNextLink(reply: JsonRecord): number | undefined {
  const link = asString(reply["@odata.nextLink"]);
  if (!link) return undefined;
  let skip: string | null;
  try {
    skip = new URL(link).searchParams.get("$skip");
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
  if (!skip || !/^\d{1,6}$/.test(skip)) return undefined;
  const value = Number(skip);
  return value > 0 && value <= MAX_SKIP ? value : undefined;
}

function requireGraphId(id: string): string {
  if (!GRAPH_ID.test(id)) throw notSupported("This event cannot be found.");
  return id;
}

/** Wall-clock times in the event's zone, the form Outlook's write actions take. */
function timeParams(times: ResolvedTimes): JsonRecord {
  if (times.allDay) {
    const { startDate, endDate } = allDayDates(times.start, times.end);
    return { startDateTime: `${startDate}T00:00:00`, endDateTime: `${endDate}T00:00:00`, timeZone: "UTC", isAllDay: true };
  }
  const zone = ianaZone(times.timeZone);
  const wall = (instant: IsoInstant) => wallTimeOf(instantInZone(instantToMs(instant), zone));
  return { startDateTime: wall(times.start), endDateTime: wall(times.end), timeZone: zone, isAllDay: false };
}

export function createOutlookCalendarProvider(options: CalendarProviderOptions): CalendarProvider {
  const { account } = options;
  const service = CALENDAR_SERVICE_IDS.outlook;
  const caller = createCalendarCaller(options.bridge, service, options.label);
  const cache = new EventCache();

  function remember(entry: CachedEvent | undefined): CalendarEvent {
    if (!entry) throw new ProviderError("failed");
    cache.set(entry);
    return entry.event;
  }

  /** Guests other than the owner; undefined when the event is not known. */
  function guestsOf(cached: CachedEvent | undefined): string[] | undefined {
    return cached?.event.attendees.map((attendee) => attendee.address).filter((address) => address !== account.address);
  }

  function attendeeParams(list: readonly EventDraftAttendee[], cached: CachedEvent | undefined): JsonRecord[] {
    requireAttendees(list);
    const people: JsonRecord[] = normalizeAttendees(list, account.address).map((attendee) => ({
      address: attendee.address,
      ...(attendee.name ? { name: attendee.name } : {}),
      type: attendee.optional ? "optional" : "required",
    }));
    // The list replaces the stored one, so booked rooms are sent back.
    for (const room of cached?.resources ?? []) {
      if (people.length >= MAX_ATTENDEES) break;
      people.push({ address: room.address, ...(room.name ? { name: room.name.slice(0, 128) } : {}), type: "required" });
    }
    return people;
  }

  async function listCalendars(): Promise<CalendarInfo[]> {
    const calendars: CalendarInfo[] = [];
    let skip: number | undefined;
    for (let page = 0; page < MAX_CALENDAR_PAGES; page++) {
      const reply = requireRecord(await caller.call("list_calendars", { limit: CALENDAR_PAGE_SIZE, ...(skip ? { skip } : {}) }), service, "list_calendars");
      for (const item of asArray(reply.value)) {
        const calendar = normalizeOutlookCalendar(asRecord(item), account);
        if (calendar) calendars.push(calendar);
      }
      skip = skipFromNextLink(reply);
      if (!skip) break;
    }
    return calendars;
  }

  async function listEvents(request: ListEventsRequest): Promise<CalendarEvent[]> {
    requireRange(request.start, request.end);
    const startDateTime = toUtcInstant(request.start);
    const endDateTime = toUtcInstant(request.end);
    const events: CalendarEvent[] = [];
    // One calendar at a time keeps within the gateway's in-flight budget.
    for (const calendarId of new Set(request.calendarIds)) {
      if (!GRAPH_ID.test(calendarId)) throw notSupported("Choose a calendar.");
      let skip: number | undefined;
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const params = { calendarId, startDateTime, endDateTime, limit: EVENT_PAGE_SIZE, ...(skip ? { skip } : {}) };
        const reply = requireRecord(await caller.call("list_events", params), service, "list_events");
        for (const item of asArray(reply.value)) {
          const entry = normalizeOutlookEvent(asRecord(item), calendarId);
          if (entry) events.push(remember(entry));
        }
        skip = skipFromNextLink(reply);
        if (!skip) break;
      }
    }
    return sortEvents(events);
  }

  async function createEvent(draft: EventDraft, invite: InviteOptions): Promise<CalendarEvent> {
    requireDraft(draft);
    if (!GRAPH_ID.test(draft.calendarId)) throw notSupported("Choose a calendar.");
    const guests = normalizeAttendees(draft.attendees, account.address);
    if (guests.length > 0 && !invite.sendInvites) throw notSupported("Outlook always sends invitations to guests.");
    const times: ResolvedTimes = { allDay: draft.allDay, start: draft.start, end: draft.end, timeZone: draft.timeZone };
    const params: JsonRecord = {
      calendarId: draft.calendarId,
      subject: requireLength(requireTitle(draft.title), MAX_SUBJECT, "title"),
      ...timeParams(times),
      ...(guests.length > 0 ? { attendees: attendeeParams(draft.attendees, undefined) } : {}),
      ...(draft.descriptionText ? { body: requireLength(draft.descriptionText, MAX_BODY, "description") } : {}),
      ...(draft.location ? { location: requireLength(draft.location, MAX_LOCATION, "location") } : {}),
      ...(draft.addOnlineMeeting ? { isOnlineMeeting: true } : {}),
      ...(draft.recurrence ? { recurrence: graphRecurrence(draft.recurrence, draft.start, ianaZone(draft.timeZone), draft.allDay) } : {}),
      ...(draft.reminders && draft.reminders.length > 0 ? { reminderMinutesBeforeStart: draft.reminders[0].minutesBefore } : {}),
    };
    const data = await caller.call("create_event_with_attendees", params);
    return remember(normalizeOutlookEvent(requireRecord(data, service, "create_event_with_attendees"), draft.calendarId));
  }

  async function updateEvent(eventId: string, changes: EventChanges, invite: InviteOptions): Promise<CalendarEvent> {
    const { calendarId, providerEventId } = requireEventId(eventId);
    requireGraphId(providerEventId);
    const cached = cache.get(eventId);
    const guests = changes.attendees !== undefined
      ? normalizeAttendees(changes.attendees, account.address).map((attendee) => attendee.address)
      : guestsOf(cached);
    if (!invite.sendInvites && (guests === undefined || guests.length > 0)) {
      throw notSupported("Outlook always tells guests about changes.");
    }
    const times = resolveChangedTimes(changes, cached?.event);
    let recurrence: JsonRecord | undefined;
    if (changes.recurrence) {
      const base = times ?? (cached ? { ...cached.event } : undefined);
      if (!base) throw notSupported("Give the start of the series.");
      recurrence = { recurrence: graphRecurrence(changes.recurrence, base.start, ianaZone(base.timeZone), base.allDay) };
    }
    const params: JsonRecord = {
      eventId: providerEventId,
      ...(changes.title !== undefined ? { subject: requireLength(requireTitle(changes.title), MAX_SUBJECT, "title") } : {}),
      ...(times ? timeParams(times) : {}),
      ...(changes.attendees !== undefined ? { attendees: attendeeParams(changes.attendees, cached) } : {}),
      ...(changes.descriptionText !== undefined ? { body: requireLength(changes.descriptionText, MAX_BODY, "description") } : {}),
      ...(changes.location !== undefined ? { location: requireLength(changes.location, MAX_LOCATION, "location") } : {}),
      ...(changes.addOnlineMeeting ? { isOnlineMeeting: true } : {}),
      ...recurrence,
      ...(changes.reminders && changes.reminders.length > 0 ? { reminderMinutesBeforeStart: changes.reminders[0].minutesBefore } : {}),
    };
    if (Object.keys(params).length === 1) throw notSupported("Nothing to change.");
    const data = await caller.call("update_event", params);
    return remember(normalizeOutlookEvent(requireRecord(data, service, "update_event"), calendarId));
  }

  async function deleteEvent(eventId: string, invite: InviteOptions): Promise<void> {
    const { providerEventId } = requireEventId(eventId);
    requireGraphId(providerEventId);
    const cached = cache.get(eventId);
    // Deleting an invitation is silent; an organiser's delete cancels for every guest.
    const organised = cached ? cached.event.myResponse === null : true;
    const guests = guestsOf(cached);
    if (!invite.sendInvites && organised && (guests === undefined || guests.length > 0)) {
      throw notSupported("Outlook always sends a cancellation to guests.");
    }
    await caller.call("delete_event", { eventId: providerEventId });
    cache.delete(eventId);
  }

  async function respond(eventId: string, answer: EventResponse, options: RespondOptions = {}): Promise<void> {
    const { providerEventId } = requireEventId(eventId);
    requireGraphId(providerEventId);
    if (answer !== "accepted" && answer !== "declined" && answer !== "tentative") throw notSupported();
    const comment = options.comment?.trim();
    await caller.call("respond_event", {
      eventId: providerEventId,
      response: answer,
      ...(comment ? { comment: requireLength(comment, MAX_COMMENT, "comment") } : {}),
      sendResponse: options.notifyOrganizer !== false,
    });
    const cached = cache.get(eventId);
    if (cached) cache.set({ ...cached, event: { ...cached.event, myResponse: answer } });
  }

  async function getFreeBusy(addresses: string[], start: IsoInstant, end: IsoInstant): Promise<BusyBlock[]> {
    const people = freeBusyAddresses(addresses);
    const { startMs, endMs } = requireRange(start, end);
    if (people.length === 0) return [];
    const params = { schedules: people, startDateTime: toUtcInstant(start), endDateTime: toUtcInstant(end) };
    const reply = requireRecord(await caller.call("get_schedule", params), service, "get_schedule");
    const schedules = new Map(asArray(reply.value).map((item) => {
      const schedule = asRecord(item);
      return [asString(schedule.scheduleId).trim().toLowerCase(), schedule] as const;
    }));
    return people.flatMap((address) => {
      const schedule = schedules.get(address);
      if (!schedule || schedule.error !== undefined) return [unknownBlock(address, start, end)];
      const intervals: BusyInterval[] = [];
      for (const item of asArray(schedule.scheduleItems)) {
        const entry = asRecord(item);
        // Free and working-elsewhere time is open for meetings.
        const status = SCHEDULE_STATUS[asString(entry.status)];
        const from = graphInstant(entry.start);
        const to = graphInstant(entry.end);
        if (status && from && to) intervals.push({ startMs: instantToMs(from), endMs: instantToMs(to), status });
      }
      return mergeBusyIntervals(address, intervals, startMs, endMs);
    });
  }

  return { listCalendars, listEvents, createEvent, updateEvent, deleteEvent, respond, getFreeBusy };
}
