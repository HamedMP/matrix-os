/**
 * Optimistic writes: the grid changes at once, the provider is called, and on
 * failure the change is rolled back and a fixed sentence is shown.
 *
 * Writes run only from an explicit owner action. `sendInvites` is whatever
 * the owner confirmed in the app; the store never decides it.
 */
import {
  eventDraftIssues,
  instantToMs,
  type CalendarEvent,
  type EventChanges,
  type EventResponse,
  type InviteOptions,
  type RespondOptions,
} from "../../../_shared/office-accounts/types/calendar";
import { eventOverlaps, findCachedEvent, replaceEvent, type EventCache } from "./cache";
import { applyEventChanges, eventFromDraft, draftChanges } from "./drafts";
import type { CalendarConnection, CalendarState, PendingWrite, StoreContext } from "./store-state";
import { zonedInstant } from "./dates";

export const READ_ONLY_MESSAGE = "This calendar is read-only.";
export const NOT_FOUND_MESSAGE = "This event is no longer available.";

/** At most this many confirmed writes are kept for reads still out; a read that outlives them fails instead of answering. */
export const MAX_CONFIRMED_WRITES = 200;

/** A write the provider confirmed: `confirmed` replaces `eventId` (null for a delete). */
export interface ConfirmedWrite {
  seq: number;
  eventId: string;
  confirmed: CalendarEvent | null;
}

/**
 * Writes confirmed while event reads were out. A reply the provider gave
 * before a write landed must not undo that write once it has left `pending`,
 * so each read takes a mark when it asks and, when it answers, gets every
 * write confirmed since that mark to put on top of the reply.
 */
export interface WriteLog {
  /** Call just before a read asks the provider; returns its mark. */
  beginRead(): number;
  /** Ends the read: the writes confirmed since `mark`, oldest first, or null when the log no longer reaches back that far. */
  endRead(mark: number): ConfirmedWrite[] | null;
  record(eventId: string, confirmed: CalendarEvent | null): void;
}

export function createWriteLog(limit = MAX_CONFIRMED_WRITES): WriteLog {
  let seq = 0;
  let reads = 0;
  /** Writes up to this seq are no longer in `log`. */
  let droppedThrough = 0;
  let log: ConfirmedWrite[] = [];
  return {
    beginRead() {
      reads += 1;
      return seq;
    },
    endRead(mark) {
      reads = Math.max(0, reads - 1);
      const writes = droppedThrough > mark ? null : log.filter((write) => write.seq > mark);
      if (reads === 0) {
        // No read is out, so no reply can need these any more.
        log = [];
        droppedThrough = seq;
      }
      return writes;
    },
    record(eventId, confirmed) {
      seq += 1;
      if (reads === 0) {
        droppedThrough = seq;
        return;
      }
      log.push({ seq, eventId, confirmed });
      while (log.length > Math.max(1, limit)) droppedThrough = log.shift()?.seq ?? droppedThrough;
    },
  };
}

/** A reply's events for one calendar and range with confirmed writes put on top, in the order they were confirmed. */
export function withConfirmedWrites(
  events: readonly CalendarEvent[],
  writes: readonly ConfirmedWrite[],
  calendarId: string,
  startMs: number,
  endMs: number,
): CalendarEvent[] {
  let next = [...events];
  for (const write of writes) {
    next = next.filter((event) => event.id !== write.eventId && event.id !== write.confirmed?.id);
    if (write.confirmed && write.confirmed.calendarId === calendarId && eventOverlaps(write.confirmed, startMs, endMs)) next.push(write.confirmed);
  }
  return next;
}

/** Puts every pending write back on top of the cache, so a reload cannot undo an unconfirmed change. */
export function reapplyPending(cache: EventCache, pending: readonly PendingWrite[]): EventCache {
  let next = cache;
  for (const write of pending) next = replaceEvent(next, write.eventId, write.optimistic);
  return next;
}

function connectionForCalendar(ctx: StoreContext, state: CalendarState, calendarId: string, needsWrite: boolean): CalendarConnection | string {
  const calendar = state.calendars.find((item) => item.id === calendarId);
  if (!calendar) return NOT_FOUND_MESSAGE;
  if (needsWrite && !calendar.writable) return READ_ONLY_MESSAGE;
  return ctx.connectionFor(calendar.accountId) ?? NOT_FOUND_MESSAGE;
}

function begin(ctx: StoreContext, write: PendingWrite): void {
  ctx.set((state) => ({
    ...state,
    mutationError: null,
    pending: [...state.pending, write],
    cache: replaceEvent(state.cache, write.eventId, write.optimistic),
  }));
}

function settle(ctx: StoreContext, log: WriteLog, write: PendingWrite, outcome: { confirmed: CalendarEvent | null } | { error: string }): void {
  if (!("error" in outcome)) log.record(write.eventId, outcome.confirmed);
  ctx.set((state) => {
    const pending = state.pending.filter((item) => item.id !== write.id);
    if ("error" in outcome) {
      // Roll back: drop the optimistic event and restore what was there before.
      const restored = reapplyPending(replaceEvent(state.cache, write.eventId, write.previous), pending);
      return { ...state, pending, cache: restored, mutationError: outcome.error };
    }
    let cache = replaceEvent(state.cache, write.eventId, outcome.confirmed);
    cache = reapplyPending(cache, pending);
    return { ...state, pending, cache };
  });
}

export interface WriteActions {
  /** Creates the open draft. Returns true once the provider confirms. */
  saveDraft(options: InviteOptions): Promise<boolean>;
  updateEvent(eventId: string, changes: EventChanges, options: InviteOptions): Promise<boolean>;
  /** Moves an event to a new start (drag on the grid), keeping its length. */
  moveEvent(eventId: string, startMs: number, options: InviteOptions): Promise<boolean>;
  deleteEvent(eventId: string, options: InviteOptions): Promise<boolean>;
  /** Answers an invitation as the owner. */
  respond(eventId: string, response: EventResponse, options?: RespondOptions): Promise<boolean>;
  clearMutationError(): void;
}

export function createWriteActions(ctx: StoreContext, hooks: { log: WriteLog; onProposalUsed(proposalId: string): void }): WriteActions {
  async function createFromDraft(options: InviteOptions): Promise<boolean> {
    const state = ctx.get();
    const draftState = state.draft;
    if (!draftState || draftState.status === "saving") return false;
    const issues = eventDraftIssues(draftState.draft);
    if (issues.length > 0) {
      ctx.set((current) => (current.draft ? { ...current, draft: { ...current.draft, issues } } : current));
      return false;
    }
    const connection = connectionForCalendar(ctx, state, draftState.draft.calendarId, true);
    if (typeof connection === "string") {
      ctx.set((current) => (current.draft ? { ...current, draft: { ...current.draft, error: connection } } : current));
      return false;
    }
    const draft = draftState.draft;
    const tempId = ctx.nextId("pending");
    const write: PendingWrite = { id: ctx.nextId("write"), kind: "create", eventId: tempId, optimistic: eventFromDraft(draft, tempId), previous: null };
    ctx.set((current) => (current.draft ? { ...current, draft: { ...current.draft, status: "saving", error: null } } : current));
    begin(ctx, write);
    try {
      const created = await connection.provider.createEvent(draft, { sendInvites: options.sendInvites === true });
      settle(ctx, hooks.log, write, { confirmed: created });
      ctx.set((current) => (current.draft?.draft === draft ? { ...current, draft: null } : current));
      if (draftState.proposalId) hooks.onProposalUsed(draftState.proposalId);
      return true;
    } catch (error: unknown) {
      const message = ctx.report("create event", error);
      settle(ctx, hooks.log, write, { error: message });
      ctx.set((current) => (current.draft?.draft === draft
        ? { ...current, draft: { ...current.draft, status: "editing", error: message } }
        : current));
      return false;
    }
  }

  async function updateExisting(eventId: string, changes: EventChanges, options: InviteOptions): Promise<boolean> {
    const state = ctx.get();
    const previous = findCachedEvent(state.cache, eventId);
    if (!previous) {
      ctx.set((current) => ({ ...current, mutationError: NOT_FOUND_MESSAGE }));
      return false;
    }
    const connection = connectionForCalendar(ctx, state, previous.calendarId, true);
    if (typeof connection === "string") {
      ctx.set((current) => ({ ...current, mutationError: connection }));
      return false;
    }
    if (Object.keys(changes).length === 0) return true;
    const write: PendingWrite = { id: ctx.nextId("write"), kind: "update", eventId, optimistic: applyEventChanges(previous, changes), previous };
    begin(ctx, write);
    try {
      const updated = await connection.provider.updateEvent(eventId, changes, { sendInvites: options.sendInvites === true });
      settle(ctx, hooks.log, write, { confirmed: updated });
      return true;
    } catch (error: unknown) {
      settle(ctx, hooks.log, write, { error: ctx.report("update event", error) });
      return false;
    }
  }

  return {
    async saveDraft(options) {
      const draftState = ctx.get().draft;
      if (!draftState) return false;
      if (draftState.mode === "create") return createFromDraft(options);
      if (!draftState.eventId || !draftState.original || draftState.status === "saving") return false;
      const issues = eventDraftIssues(draftState.draft);
      if (issues.length > 0) {
        ctx.set((current) => (current.draft ? { ...current, draft: { ...current.draft, issues } } : current));
        return false;
      }
      const draft = draftState.draft;
      ctx.set((current) => (current.draft ? { ...current, draft: { ...current.draft, status: "saving", error: null } } : current));
      const ok = await updateExisting(draftState.eventId, draftChanges(draftState.original, draft), options);
      ctx.set((current) => {
        if (current.draft?.draft !== draft) return current;
        if (ok) return { ...current, draft: null };
        return { ...current, draft: { ...current.draft, status: "editing", error: current.mutationError } };
      });
      return ok;
    },

    updateEvent: updateExisting,

    async moveEvent(eventId, startMs, options) {
      const event = findCachedEvent(ctx.get().cache, eventId);
      if (!event) {
        ctx.set((current) => ({ ...current, mutationError: NOT_FOUND_MESSAGE }));
        return false;
      }
      const duration = instantToMs(event.end) - instantToMs(event.start);
      const zone = event.allDay ? "UTC" : event.timeZone;
      return updateExisting(eventId, {
        start: zonedInstant(startMs, zone),
        end: zonedInstant(startMs + duration, zone),
        allDay: event.allDay,
        timeZone: event.timeZone,
      }, options);
    },

    async deleteEvent(eventId, options) {
      const state = ctx.get();
      const previous = findCachedEvent(state.cache, eventId);
      if (!previous) {
        ctx.set((current) => ({ ...current, mutationError: NOT_FOUND_MESSAGE }));
        return false;
      }
      const connection = connectionForCalendar(ctx, state, previous.calendarId, true);
      if (typeof connection === "string") {
        ctx.set((current) => ({ ...current, mutationError: connection }));
        return false;
      }
      const write: PendingWrite = { id: ctx.nextId("write"), kind: "delete", eventId, optimistic: null, previous };
      begin(ctx, write);
      try {
        await connection.provider.deleteEvent(eventId, { sendInvites: options.sendInvites === true });
        settle(ctx, hooks.log, write, { confirmed: null });
        return true;
      } catch (error: unknown) {
        settle(ctx, hooks.log, write, { error: ctx.report("delete event", error) });
        return false;
      }
    },

    async respond(eventId, response, options) {
      const state = ctx.get();
      const previous = findCachedEvent(state.cache, eventId);
      if (!previous) {
        ctx.set((current) => ({ ...current, mutationError: NOT_FOUND_MESSAGE }));
        return false;
      }
      // Answering an invitation does not need write access to the calendar.
      const connection = connectionForCalendar(ctx, state, previous.calendarId, false);
      if (typeof connection === "string") {
        ctx.set((current) => ({ ...current, mutationError: connection }));
        return false;
      }
      // An empty account address is unknown: no attendee is guessed to be the owner.
      const owner = connection.account.address.toLowerCase();
      const optimistic: CalendarEvent = {
        ...previous,
        myResponse: response,
        attendees: previous.attendees.map((attendee) => (owner && attendee.address.toLowerCase() === owner ? { ...attendee, response } : attendee)),
      };
      const write: PendingWrite = { id: ctx.nextId("write"), kind: "respond", eventId, optimistic, previous };
      begin(ctx, write);
      try {
        await connection.provider.respond(eventId, response, options);
        settle(ctx, hooks.log, write, { confirmed: optimistic });
        return true;
      } catch (error: unknown) {
        settle(ctx, hooks.log, write, { error: ctx.report("respond to event", error) });
        return false;
      }
    },

    clearMutationError() {
      ctx.set((state) => ({ ...state, mutationError: null }));
    },
  };
}
