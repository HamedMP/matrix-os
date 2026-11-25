/**
 * Google Calendar behind `CalendarProvider`, through the `google_calendar`
 * integration actions (`packages/gateway/src/integrations`).
 */
import { CALENDAR_SERVICE_IDS, ProviderError } from "../types/calendar.js";
import type {
  BusyBlock,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  EventChanges,
  EventDraft,
  EventDraftAttendee,
  EventReminder,
  EventResponse,
  InviteOptions,
  IsoInstant,
  ListEventsRequest,
  RespondOptions,
} from "../types/calendar.js";
import { mergeBusyIntervals, unknownBlock } from "./busy.js";
import {
  EventCache,
  allDayDates,
  freeBusyAddresses,
  meetingRequestId,
  normalizeAttendees,
  notSupported,
  randomSalt,
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
import { normalizeGoogleCalendar, normalizeGoogleEvent } from "./google-normalize.js";
import { rruleForDraft } from "./recurrence.js";
import { asArray, asRecord, asString, createCalendarCaller, requireRecord } from "./service.js";
import type { CalendarProviderOptions, JsonRecord } from "./service.js";

const PAGE_SIZE = 250;
/** At most this many pages per list: 2,500 events per calendar, 2,500 calendars. */
const MAX_PAGES = 10;
const MAX_SUMMARY = 1024;
const MAX_LOCATION = 1024;
const MAX_DESCRIPTION = 8192;
const MAX_COMMENT = 1024;

function nextPageToken(reply: JsonRecord): string | undefined {
  // Passed back unchanged; the gateway validates it.
  return asString(reply.nextPageToken) || undefined;
}

function reminders(list: readonly EventReminder[]): { method: string; minutes: number }[] {
  return list.map((reminder) => ({ method: reminder.method, minutes: reminder.minutesBefore }));
}

function timeParams(times: ResolvedTimes): JsonRecord {
  return times.allDay
    ? allDayDates(times.start, times.end)
    : { start: times.start, end: times.end, timeZone: times.timeZone };
}

export function createGoogleCalendarProvider(options: CalendarProviderOptions): CalendarProvider {
  const { account } = options;
  const service = CALENDAR_SERVICE_IDS.google;
  const caller = createCalendarCaller(options.bridge, service, options.label);
  const cache = new EventCache();
  const salt = randomSalt();

  function remember(entry: CachedEvent | undefined): CalendarEvent {
    if (!entry) throw new ProviderError("failed");
    cache.set(entry);
    return entry.event;
  }

  function eventFromReply(data: unknown, calendarId: string, fallbackZone: string | undefined): CalendarEvent {
    return remember(normalizeGoogleEvent(requireRecord(data, service, "event"), calendarId, account, fallbackZone));
  }

  async function listCalendars(): Promise<CalendarInfo[]> {
    const calendars: CalendarInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = requireRecord(await caller.call("list_calendars", { maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }), service, "list_calendars");
      for (const item of asArray(reply.items)) {
        const calendar = normalizeGoogleCalendar(asRecord(item), account);
        if (calendar) calendars.push(calendar);
      }
      pageToken = nextPageToken(reply);
      if (!pageToken) break;
    }
    return calendars;
  }

  async function listEvents(request: ListEventsRequest): Promise<CalendarEvent[]> {
    requireRange(request.start, request.end);
    const events: CalendarEvent[] = [];
    // One calendar at a time keeps within the gateway's in-flight budget.
    for (const calendarId of new Set(request.calendarIds)) {
      if (!calendarId || calendarId.includes("/")) throw notSupported("Choose a calendar.");
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = { calendarId, timeMin: request.start, timeMax: request.end, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) };
        const reply = requireRecord(await caller.call("list_events", params), service, "list_events");
        const zone = asString(reply.timeZone) || undefined;
        for (const item of asArray(reply.items)) {
          const entry = normalizeGoogleEvent(asRecord(item), calendarId, account, zone);
          if (entry) events.push(remember(entry));
        }
        pageToken = nextPageToken(reply);
        if (!pageToken) break;
      }
    }
    return sortEvents(events);
  }

  function attendeeParams(list: readonly EventDraftAttendee[], cached: CachedEvent | undefined): JsonRecord[] {
    requireAttendees(list);
    const known = new Map((cached?.event.attendees ?? []).map((attendee) => [attendee.address, attendee.response]));
    const people: JsonRecord[] = normalizeAttendees(list, account.address).map((attendee) => {
      const answer = known.get(attendee.address);
      return {
        email: attendee.address,
        ...(attendee.name ? { displayName: attendee.name } : {}),
        ...(attendee.optional ? { optional: true } : {}),
        ...(cached && answer && answer !== "needsAction" ? { responseStatus: answer } : {}),
      };
    });
    // The list replaces the stored one, so booked rooms are sent back unchanged.
    for (const room of cached?.resources ?? []) {
      if (people.length >= 100) break;
      people.push({ email: room.address, ...(room.name ? { displayName: room.name.slice(0, 128) } : {}), responseStatus: room.response });
    }
    return people;
  }

  async function createEvent(draft: EventDraft, invite: InviteOptions): Promise<CalendarEvent> {
    requireDraft(draft);
    const times: ResolvedTimes = { allDay: draft.allDay, start: draft.start, end: draft.end, timeZone: draft.timeZone };
    const params: JsonRecord = {
      calendarId: draft.calendarId,
      summary: requireLength(requireTitle(draft.title), MAX_SUMMARY, "title"),
      ...timeParams(times),
      ...(draft.descriptionText ? { description: requireLength(draft.descriptionText, MAX_DESCRIPTION, "description") } : {}),
      ...(draft.location ? { location: requireLength(draft.location, MAX_LOCATION, "location") } : {}),
      ...(draft.attendees.length > 0 ? { attendees: attendeeParams(draft.attendees, undefined) } : {}),
      ...(draft.addOnlineMeeting ? { conferenceRequestId: meetingRequestId(salt, draft) } : {}),
      ...(draft.recurrence ? { recurrence: [rruleForDraft(draft.recurrence, draft.allDay)] } : {}),
      ...(draft.reminders ? { reminders: reminders(draft.reminders) } : {}),
      sendUpdates: invite.sendInvites ? "all" : "none",
    };
    const data = await caller.call("create_event_with_attendees", params);
    return eventFromReply(data, draft.calendarId, draft.allDay ? undefined : draft.timeZone);
  }

  async function updateEvent(eventId: string, changes: EventChanges, invite: InviteOptions): Promise<CalendarEvent> {
    const { calendarId, providerEventId } = requireEventId(eventId);
    const cached = cache.get(eventId);
    const times = resolveChangedTimes(changes, cached?.event);
    const allDay = times?.allDay ?? cached?.event.allDay ?? false;
    const params: JsonRecord = {
      calendarId,
      eventId: providerEventId,
      ...(changes.title !== undefined ? { summary: requireLength(requireTitle(changes.title), MAX_SUMMARY, "title") } : {}),
      ...(times ? timeParams(times) : {}),
      ...(changes.descriptionText !== undefined ? { description: requireLength(changes.descriptionText, MAX_DESCRIPTION, "description") } : {}),
      ...(changes.location !== undefined ? { location: requireLength(changes.location, MAX_LOCATION, "location") } : {}),
      ...(changes.attendees !== undefined ? { attendees: attendeeParams(changes.attendees, cached) } : {}),
      ...(changes.addOnlineMeeting ? { conferenceRequestId: meetingRequestId(salt, { eventId, changes }) } : {}),
      ...(changes.recurrence ? { recurrence: [rruleForDraft(changes.recurrence, allDay)] } : {}),
      ...(changes.reminders ? { reminders: reminders(changes.reminders) } : {}),
      sendUpdates: invite.sendInvites ? "all" : "none",
    };
    if (Object.keys(params).length === 3) throw notSupported("Nothing to change.");
    const data = await caller.call("update_event_details", params);
    const fallbackZone = times && !times.allDay ? times.timeZone : cached?.event.timeZone;
    return eventFromReply(data, calendarId, fallbackZone);
  }

  async function deleteEvent(eventId: string, invite: InviteOptions): Promise<void> {
    const { calendarId, providerEventId } = requireEventId(eventId);
    await caller.call("delete_event", { calendarId, eventId: providerEventId, sendUpdates: invite.sendInvites ? "all" : "none" });
    cache.delete(eventId);
  }

  async function respond(eventId: string, answer: EventResponse, options: RespondOptions = {}): Promise<void> {
    const { calendarId, providerEventId } = requireEventId(eventId);
    if (answer !== "accepted" && answer !== "declined" && answer !== "tentative") throw notSupported();
    const comment = options.comment?.trim();
    await caller.call("respond_event", {
      calendarId,
      eventId: providerEventId,
      selfEmail: account.address,
      response: answer,
      ...(comment ? { comment: requireLength(comment, MAX_COMMENT, "comment") } : {}),
      sendUpdates: options.notifyOrganizer === false ? "none" : "all",
    });
    const cached = cache.get(eventId);
    if (cached) cache.set({ ...cached, event: { ...cached.event, myResponse: answer } });
  }

  async function getFreeBusy(addresses: string[], start: IsoInstant, end: IsoInstant): Promise<BusyBlock[]> {
    const people = freeBusyAddresses(addresses);
    const { startMs, endMs } = requireRange(start, end);
    if (people.length === 0) return [];
    const reply = requireRecord(await caller.call("free_busy", { items: people, timeMin: start, timeMax: end }), service, "free_busy");
    const calendars = new Map(Object.entries(asRecord(reply.calendars)).map(([key, value]) => [key.toLowerCase(), asRecord(value)]));
    return people.flatMap((address) => {
      const entry = calendars.get(address);
      if (!entry || asArray(entry.errors).length > 0) return [unknownBlock(address, start, end)];
      const intervals = asArray(entry.busy).map((item) => {
        const block = asRecord(item);
        return { startMs: Date.parse(asString(block.start)), endMs: Date.parse(asString(block.end)), status: "busy" as const };
      });
      return mergeBusyIntervals(address, intervals, startMs, endMs);
    });
  }

  return { listCalendars, listEvents, createEvent, updateEvent, deleteEvent, respond, getFreeBusy };
}
