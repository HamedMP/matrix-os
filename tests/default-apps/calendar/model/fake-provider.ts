import {
  MAX_FREE_BUSY_ADDRESSES,
  ProviderError,
  composeEventId,
  instantsOverlap,
  type BusyBlock,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarProvider,
  type EventChanges,
  type EventDraft,
  type EventResponse,
  type InviteOptions,
  type ListEventsRequest,
} from "../../../../home/apps/_shared/office-accounts/types/calendar";

interface Deferred {
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * An in-memory calendar provider. It behaves like a real adapter (stores
 * events, filters by range and calendar) and records every call, so store
 * tests can check what reached the provider. `failNext` makes the next write
 * reject; `hold` makes writes wait until released, to observe optimistic state.
 */
export class FakeCalendarProvider implements CalendarProvider {
  calendars: CalendarInfo[];
  events: CalendarEvent[] = [];
  busy: BusyBlock[] = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  failNext: ProviderError | null = null;
  holdWrites = false;
  /** Event reads answer with what the calendar held when they were asked, after `releaseReads`. */
  holdReads = false;
  private held: Deferred[] = [];
  private heldReads: Deferred[] = [];
  private counter = 0;

  constructor(calendars: CalendarInfo[]) {
    this.calendars = calendars;
  }

  release(): void {
    for (const deferred of this.held.splice(0)) deferred.resolve();
  }

  private async write(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this.holdWrites) await new Promise<void>((resolve, reject) => this.held.push({ resolve, reject }));
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  /** Answers the held event reads, or fails them all with `error`. */
  releaseReads(error?: unknown): void {
    for (const deferred of this.heldReads.splice(0)) {
      if (error === undefined) deferred.resolve();
      else deferred.reject(error);
    }
  }

  callsTo(method: string) {
    return this.calls.filter((call) => call.method === method);
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    this.calls.push({ method: "listCalendars", args: [] });
    return this.calendars.map((calendar) => ({ ...calendar }));
  }

  async listEvents(request: ListEventsRequest): Promise<CalendarEvent[]> {
    this.calls.push({ method: "listEvents", args: [request] });
    const events = this.events.filter((event) => request.calendarIds.includes(event.calendarId)
      && instantsOverlap(event.start, event.end, request.start, request.end));
    if (this.holdReads) await new Promise<void>((resolve, reject) => this.heldReads.push({ resolve, reject }));
    return events;
  }

  async createEvent(draft: EventDraft, options: InviteOptions): Promise<CalendarEvent> {
    await this.write("createEvent", [draft, options]);
    this.counter += 1;
    const event: CalendarEvent = {
      id: composeEventId(draft.calendarId, `created${this.counter}`),
      calendarId: draft.calendarId,
      title: draft.title,
      start: draft.start,
      end: draft.end,
      allDay: draft.allDay,
      timeZone: draft.timeZone,
      location: draft.location,
      descriptionText: draft.descriptionText,
      attendees: draft.attendees.map((attendee) => ({ address: attendee.address, name: attendee.name ?? "", response: "needsAction", organizer: false })),
      myResponse: null,
    };
    this.events.push(event);
    return event;
  }

  async updateEvent(eventId: string, changes: EventChanges, options: InviteOptions): Promise<CalendarEvent> {
    await this.write("updateEvent", [eventId, changes, options]);
    const index = this.events.findIndex((event) => event.id === eventId);
    if (index === -1) throw new ProviderError("failed");
    const { attendees: _attendees, addOnlineMeeting: _meeting, recurrence: _recurrence, reminders: _reminders, ...simple } = changes;
    this.events[index] = { ...this.events[index], ...simple };
    return this.events[index];
  }

  async deleteEvent(eventId: string, options: InviteOptions): Promise<void> {
    await this.write("deleteEvent", [eventId, options]);
    this.events = this.events.filter((event) => event.id !== eventId);
  }

  async respond(eventId: string, response: EventResponse): Promise<void> {
    await this.write("respond", [eventId, response]);
    this.events = this.events.map((event) => (event.id === eventId ? { ...event, myResponse: response } : event));
  }

  async getFreeBusy(addresses: string[], start: string, end: string): Promise<BusyBlock[]> {
    this.calls.push({ method: "getFreeBusy", args: [addresses, start, end] });
    // Like the real adapters: one call answers for at most MAX_FREE_BUSY_ADDRESSES people.
    if (addresses.length > MAX_FREE_BUSY_ADDRESSES) throw new ProviderError("not_supported");
    return this.busy.filter((block) => addresses.includes(block.address) && instantsOverlap(block.start, block.end, start, end));
  }
}

export function calendarInfo(id: string, overrides: Partial<CalendarInfo> = {}): CalendarInfo {
  return { id, accountId: "google:me@example.com", name: id, color: "#3366cc", primary: false, writable: true, visible: true, ...overrides };
}
