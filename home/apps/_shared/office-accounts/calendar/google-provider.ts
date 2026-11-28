/**
 * Google Calendar behind `CalendarProvider`, through the `google_calendar`
 * integration actions (`packages/gateway/src/integrations`).
 */
import { CALENDAR_SERVICE_IDS, MAX_EVENT_ATTENDEES, ProviderError } from "../types/calendar.js";
import type {
  BusyBlock,
  CalendarAccount,
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
import { isValidMailAddress } from "../types/addresses.js";
import { mergeBusyIntervals, unknownBlock } from "./busy.js";
import {
  EventCache,
  allDayDates,
  changeNeedsStoredTimes,
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
  requireRecurrence,
  requireReminders,
  requireTitle,
  resolveChangedTimes,
  sortEvents,
} from "./common.js";
import type { CachedEvent, ResolvedTimes } from "./common.js";
import { normalizeGoogleCalendar, normalizeGoogleEvent } from "./google-normalize.js";
import { rruleForDraft } from "./recurrence.js";
import { asArray, asRecord, asString, createCalendarCaller, requireRecord } from "./service.js";
import type { CalendarCaller, CalendarProviderOptions, CalendarServiceBridge, JsonRecord } from "./service.js";

const PAGE_SIZE = 250;
/**
 * At most this many pages per list: 2,500 events per calendar, 2,500 calendars.
 * A longer list is refused rather than returned in part.
 */
const MAX_PAGES = 10;
const MAX_SUMMARY = 1024;
const MAX_LOCATION = 1024;
const MAX_DESCRIPTION = 8192;
const MAX_COMMENT = 1024;
const SERVICE = CALENDAR_SERVICE_IDS.google;
const CHANGE_KEYS = ["title", "start", "end", "allDay", "timeZone", "location", "descriptionText", "attendees", "recurrence", "reminders"] as const;

function nextPageToken(reply: JsonRecord): string | undefined {
  // Passed back unchanged; the gateway validates it.
  return asString(reply.nextPageToken) || undefined;
}

/** Each page of `list_calendars` until `visit` returns true or the list ends. */
async function eachCalendarPage(caller: CalendarCaller, visit: (items: unknown[]) => boolean): Promise<void> {
  let pageToken: string | undefined;
  for (let page = 0; ; page++) {
    const params = { maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) };
    const reply = requireRecord(await caller.call("list_calendars", params), SERVICE, "list_calendars");
    if (visit(asArray(reply.items))) return;
    pageToken = nextPageToken(reply);
    if (!pageToken) return;
    if (page + 1 >= MAX_PAGES) throw notSupported("This account has too many calendars to list.");
  }
}

/** The id of the primary calendar, which Google sets to the account's own address. */
function primaryAddress(items: unknown[]): string | undefined {
  for (const item of items) {
    const calendar = asRecord(item);
    const id = asString(calendar.id).trim().toLowerCase();
    if (calendar.primary === true && isValidMailAddress(id)) return id;
  }
  return undefined;
}

/**
 * The account's own address, read from its primary calendar, or undefined when
 * none is listed. Rejects with a `ProviderError` when the calendar list fails.
 */
export async function readGoogleAccountAddress(bridge: CalendarServiceBridge, label: string | undefined): Promise<string | undefined> {
  let address: string | undefined;
  await eachCalendarPage(createCalendarCaller(bridge, SERVICE, label), (items) => {
    address = primaryAddress(items);
    return address !== undefined;
  });
  return address;
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
  const service = SERVICE;
  const caller = createCalendarCaller(options.bridge, service, options.label);
  const cache = new EventCache();
  const salt = randomSalt();
  // Empty until known: the host may list an account by its label only.
  let ownerAddress = isValidMailAddress(account.address) ? account.address : "";

  function owner(): CalendarAccount {
    return ownerAddress === account.address ? account : { ...account, address: ownerAddress };
  }

  function remember(entry: CachedEvent | undefined): CalendarEvent {
    if (!entry) throw new ProviderError("failed");
    cache.set(entry);
    return entry.event;
  }

  function eventFromReply(data: unknown, calendarId: string, fallbackZone: string | undefined): CalendarEvent {
    return remember(normalizeGoogleEvent(requireRecord(data, service, "event"), calendarId, owner(), fallbackZone));
  }

  /** The event as the provider holds it now. */
  async function readEvent(eventId: string): Promise<CachedEvent> {
    const { calendarId, providerEventId } = requireEventId(eventId);
    const reply = requireRecord(await caller.call("get_event", { calendarId, eventId: providerEventId }), service, "get_event");
    const entry = normalizeGoogleEvent(reply, calendarId, owner());
    if (!entry || entry.event.id !== eventId) throw notSupported("This event cannot be found.");
    cache.set(entry);
    return entry;
  }

  /** The cached event, or the provider's when the cache no longer holds it (or holds only part of its guests). */
  async function storedEvent(eventId: string, needAllGuests: boolean): Promise<CachedEvent> {
    const cached = cache.get(eventId);
    if (cached && (!needAllGuests || cached.attendeesComplete)) return cached;
    return readEvent(eventId);
  }

  async function listCalendars(): Promise<CalendarInfo[]> {
    const calendars: CalendarInfo[] = [];
    await eachCalendarPage(caller, (items) => {
      for (const item of items) {
        const calendar = normalizeGoogleCalendar(asRecord(item), account);
        if (calendar) calendars.push(calendar);
      }
      ownerAddress ||= primaryAddress(items) ?? "";
      return false;
    });
    return calendars;
  }

  async function listEvents(request: ListEventsRequest): Promise<CalendarEvent[]> {
    requireRange(request.start, request.end);
    const events: CalendarEvent[] = [];
    // One calendar at a time keeps within the gateway's in-flight budget.
    for (const calendarId of new Set(request.calendarIds)) {
      if (!calendarId || calendarId.includes("/")) throw notSupported("Choose a calendar.");
      let pageToken: string | undefined;
      for (let page = 0; ; page++) {
        const params = { calendarId, timeMin: request.start, timeMax: request.end, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) };
        const reply = requireRecord(await caller.call("list_events", params), service, "list_events");
        const zone = asString(reply.timeZone) || undefined;
        for (const item of asArray(reply.items)) {
          const entry = normalizeGoogleEvent(asRecord(item), calendarId, owner(), zone);
          if (entry) events.push(remember(entry));
        }
        pageToken = nextPageToken(reply);
        if (!pageToken) break;
        if (page + 1 >= MAX_PAGES) throw notSupported("This range has too many events to show. Choose a shorter range.");
      }
    }
    return sortEvents(events);
  }

  /** The replacing guest list. `stored` is the event being changed, with all its guests and rooms. */
  function attendeeParams(list: readonly EventDraftAttendee[], stored: CachedEvent | undefined): JsonRecord[] {
    requireAttendees(list);
    if (stored && !stored.attendeesComplete) throw notSupported("The guest list of this event cannot be changed here.");
    const known = new Map((stored?.event.attendees ?? []).map((attendee) => [attendee.address, attendee.response]));
    const people: JsonRecord[] = normalizeAttendees(list, ownerAddress).map((attendee) => {
      const answer = known.get(attendee.address);
      return {
        email: attendee.address,
        ...(attendee.name ? { displayName: attendee.name } : {}),
        ...(attendee.optional ? { optional: true } : {}),
        ...(answer && answer !== "needsAction" ? { responseStatus: answer } : {}),
      };
    });
    // The list replaces the stored one, so booked rooms are sent back unchanged; never dropped to make space.
    const rooms = stored?.resources ?? [];
    if (people.length + rooms.length > MAX_EVENT_ATTENDEES) throw notSupported("An event can have at most 100 guests, rooms included.");
    for (const room of rooms) {
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
    // Every check that needs no provider call runs before any call.
    if (!CHANGE_KEYS.some((key) => changes[key] !== undefined) && changes.addOnlineMeeting !== true) throw notSupported("Nothing to change.");
    const summary = changes.title !== undefined ? requireLength(requireTitle(changes.title), MAX_SUMMARY, "title") : undefined;
    const description = changes.descriptionText !== undefined ? requireLength(changes.descriptionText, MAX_DESCRIPTION, "description") : undefined;
    const location = changes.location !== undefined ? requireLength(changes.location, MAX_LOCATION, "location") : undefined;
    if (changes.attendees !== undefined) requireAttendees(changes.attendees);
    const recurrence = changes.recurrence !== undefined ? requireRecurrence(changes.recurrence) : undefined;
    const reminderList = changes.reminders !== undefined ? requireReminders(changes.reminders) : undefined;

    // The guest list, the repeat rule and a partial time change all depend on
    // the stored event; the cache may have evicted it, so read it then.
    const needsStored = changes.attendees !== undefined || recurrence !== undefined || changeNeedsStoredTimes(changes);
    const stored = needsStored ? await storedEvent(eventId, changes.attendees !== undefined) : cache.get(eventId);
    if (recurrence && stored?.event.seriesId) throw notSupported("Change how the whole series repeats, not one occurrence.");
    const times = resolveChangedTimes(changes, stored?.event);
    const allDay = times?.allDay ?? stored?.event.allDay;
    if (recurrence && allDay === undefined) throw notSupported("This event cannot be found.");

    const params: JsonRecord = {
      calendarId,
      eventId: providerEventId,
      ...(summary !== undefined ? { summary } : {}),
      ...(times ? timeParams(times) : {}),
      ...(description !== undefined ? { description } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(changes.attendees !== undefined ? { attendees: attendeeParams(changes.attendees, stored) } : {}),
      ...(changes.addOnlineMeeting ? { conferenceRequestId: meetingRequestId(salt, { eventId, changes }) } : {}),
      ...(recurrence ? { recurrence: [rruleForDraft(recurrence, allDay === true)] } : {}),
      ...(reminderList ? { reminders: reminders(reminderList) } : {}),
      sendUpdates: invite.sendInvites ? "all" : "none",
    };
    const data = await caller.call("update_event_details", params);
    const fallbackZone = times && !times.allDay ? times.timeZone : stored?.event.timeZone;
    return eventFromReply(data, calendarId, fallbackZone);
  }

  async function deleteEvent(eventId: string, invite: InviteOptions): Promise<void> {
    const { calendarId, providerEventId } = requireEventId(eventId);
    await caller.call("delete_event", { calendarId, eventId: providerEventId, sendUpdates: invite.sendInvites ? "all" : "none" });
    cache.delete(eventId);
  }

  /**
   * The address to answer as: the attendee entry Google marks as the owner's,
   * else the account's own address. Never an account label.
   */
  async function replyAddress(eventId: string): Promise<string> {
    const cached = cache.get(eventId);
    if (cached?.selfAddress) return cached.selfAddress;
    if (ownerAddress) return ownerAddress;
    const read = await readEvent(eventId);
    if (read.selfAddress) return read.selfAddress;
    throw notSupported("Answering needs this account's email address, which is not available. Reconnect the account and try again.");
  }

  async function respond(eventId: string, answer: EventResponse, options: RespondOptions = {}): Promise<void> {
    const { calendarId, providerEventId } = requireEventId(eventId);
    if (answer !== "accepted" && answer !== "declined" && answer !== "tentative") throw notSupported();
    const comment = options.comment?.trim();
    if (comment) requireLength(comment, MAX_COMMENT, "comment");
    const selfEmail = await replyAddress(eventId);
    await caller.call("respond_event", {
      calendarId,
      eventId: providerEventId,
      selfEmail,
      response: answer,
      ...(comment ? { comment } : {}),
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
