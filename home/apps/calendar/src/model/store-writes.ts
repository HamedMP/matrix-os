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
import { findCachedEvent, replaceEvent, type EventCache } from "./cache";
import { applyEventChanges, eventFromDraft, draftChanges } from "./drafts";
import type { CalendarConnection, CalendarState, PendingWrite, StoreContext } from "./store-state";
import { zonedInstant } from "./dates";

export const READ_ONLY_MESSAGE = "This calendar is read-only.";
export const NOT_FOUND_MESSAGE = "This event is no longer available.";

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

function settle(ctx: StoreContext, write: PendingWrite, outcome: { confirmed: CalendarEvent | null } | { error: string }): void {
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

export function createWriteActions(ctx: StoreContext, hooks: { onProposalUsed(proposalId: string): void }): WriteActions {
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
      settle(ctx, write, { confirmed: created });
      ctx.set((current) => (current.draft?.draft === draft ? { ...current, draft: null } : current));
      if (draftState.proposalId) hooks.onProposalUsed(draftState.proposalId);
      return true;
    } catch (error: unknown) {
      const message = ctx.report("create event", error);
      settle(ctx, write, { error: message });
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
      settle(ctx, write, { confirmed: updated });
      return true;
    } catch (error: unknown) {
      settle(ctx, write, { error: ctx.report("update event", error) });
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
        settle(ctx, write, { confirmed: null });
        return true;
      } catch (error: unknown) {
        settle(ctx, write, { error: ctx.report("delete event", error) });
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
        settle(ctx, write, { confirmed: optimistic });
        return true;
      } catch (error: unknown) {
        settle(ctx, write, { error: ctx.report("respond to event", error) });
        return false;
      }
    },

    clearMutationError() {
      ctx.set((state) => ({ ...state, mutationError: null }));
    },
  };
}
