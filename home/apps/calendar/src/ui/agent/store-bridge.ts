/**
 * Connects the Calendar agent to the Calendar store.
 *
 * - `agentContext(state, now)` is what the agent may read.
 * - `createStoreAgentDeps(store, options)` gives the agent read-only access:
 *   the model call, events (loaded through the store's own cache) and
 *   free-busy. There is no write path here.
 * - `openAgentDraft`, `openRescheduleDraft` and `openSlotDraft` put an agent
 *   result into the event composer. They only open drafts; sending stays an
 *   explicit click in the composer.
 */
import type { MatrixOSBridge } from "../../../../_shared/matrix-os";
import {
  instantInZone,
  instantToMs,
  wallTimeOf,
  type BusyBlock,
  type CalendarEvent,
  type EventDraft,
  type IsoInstant,
} from "../../../../_shared/office-accounts/types/calendar";
import type { CalendarAgentContext, CalendarAgentDeps, SlotRef } from "../../agent";
import { dayKeyAt, eventsInRange, type CalendarState, type CalendarStore, type Proposal } from "../../model";

/** Views the walk may step through to cover one window; the window itself is at most 62 days. */
export const MAX_WALK_STEPS = 12;

export function agentContext(state: CalendarState, now: number): CalendarAgentContext {
  return {
    now,
    timeZone: state.timeZone,
    weekStart: state.preferences.weekStart,
    workingHours: state.preferences.workingHours,
    defaultDurationMinutes: state.preferences.defaultDurationMinutes,
    ownerAddress: state.accounts[0]?.address.toLowerCase() ?? null,
    calendars: state.calendars,
    events: state.events,
    assistantAttendees: state.assistant.attendees,
  };
}

function bridge(): MatrixOSBridge | null {
  return typeof window !== "undefined" && window.MatrixOS ? window.MatrixOS : null;
}

/** `MatrixOS.ai.generate`, returning the reply text. Rejects when the host has no AI bridge. */
export async function bridgeGenerate(prompt: string): Promise<string> {
  const host = bridge();
  if (!host?.ai) throw new Error("AI bridge unavailable");
  const result = await host.ai.generate({ prompt });
  return typeof result?.text === "string" ? result.text : "";
}

function covers(state: CalendarState, start: IsoInstant, end: IsoInstant): boolean {
  return instantToMs(state.range.start) <= instantToMs(start) && instantToMs(state.range.end) >= instantToMs(end);
}

/**
 * Steps the grid through the views that cover `[start, end)`, loading each,
 * and calls `visit` with the state after every load. The grid is left on the
 * first day of the window, so the answer is what the owner sees.
 */
async function walkWindow(store: CalendarStore, start: IsoInstant, end: IsoInstant, visit: (state: CalendarState) => Promise<void> | void): Promise<void> {
  const first = store.getSnapshot();
  if (covers(first, start, end) && first.eventsStatus === "ready") {
    await visit(first);
    return;
  }
  const startDay = dayKeyAt(instantToMs(start), first.timeZone);
  store.goToDate(startDay);
  for (let step = 0; step < MAX_WALK_STEPS; step += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose: each step moves the one grid the store owns.
    await store.loadEvents();
    const state = store.getSnapshot();
    if (state.eventsStatus === "error") throw new Error("Calendar events could not be loaded");
    await visit(state);
    if (instantToMs(state.range.end) >= instantToMs(end)) break;
    store.shift(1);
  }
  store.goToDate(startDay);
}

export interface StoreAgentOptions {
  /** One model call; defaults to `MatrixOS.ai.generate`. */
  generate?: (prompt: string) => Promise<string>;
  /** Free-busy straight from a provider; defaults to the store's scheduling assistant. */
  getFreeBusy?: CalendarAgentDeps["getFreeBusy"];
  log?: (action: string, error: unknown) => void;
}

export function createStoreAgentDeps(store: CalendarStore, options: StoreAgentOptions = {}): CalendarAgentDeps {
  return {
    generate: options.generate ?? bridgeGenerate,
    async listEvents(start, end) {
      // Keyed by id so a view loaded twice does not list an event twice; bounded by the window's events.
      const found: Record<string, CalendarEvent> = Object.create(null);
      await walkWindow(store, start, end, (state) => {
        const visible = state.calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id);
        for (const event of eventsInRange(state.cache, visible, start, end)) found[event.id] = event;
      });
      return Object.values(found).sort((a, b) => instantToMs(a.start) - instantToMs(b.start));
    },
    async getFreeBusy(addresses, start, end) {
      if (options.getFreeBusy) return options.getFreeBusy(addresses, start, end);
      // The scheduling assistant fetches busy time for the visible range and
      // draws it on the grid, so the owner sees whose time was checked.
      const blocks: BusyBlock[] = [];
      await walkWindow(store, start, end, async (state) => {
        if (state.assistant.attendees.join(",") !== addresses.join(",")) await store.setAssistantAttendees(addresses);
        else await store.loadBusy();
        const after = store.getSnapshot();
        if (after.assistant.status === "error") throw new Error("Free-busy could not be loaded");
        blocks.push(...after.assistant.busy);
      });
      return blocks;
    },
    log: options.log ?? ((action, error) => console.warn(`[calendar] ${action} failed`, error)),
  };
}

function wall(instant: IsoInstant, timeZone: string): string {
  return wallTimeOf(instantInZone(instantToMs(instant), timeZone)).slice(0, 16);
}

/** Opens a new-event draft holding everything in the agent's draft. Returns false when no draft could open. */
export function openAgentDraft(store: CalendarStore, draft: EventDraft): boolean {
  const durationMinutes = Math.max(5, Math.round((instantToMs(draft.end) - instantToMs(draft.start)) / 60_000));
  if (!store.openNewDraft({ start: draft.start, durationMinutes, calendarId: draft.calendarId })) return false;
  store.patchDraft({ title: draft.title, location: draft.location, descriptionText: draft.descriptionText });
  if (draft.timeZone && store.getSnapshot().draft?.draft.timeZone !== draft.timeZone) {
    store.setDraftTimes(wall(draft.start, draft.timeZone), wall(draft.end, draft.timeZone), draft.timeZone);
  }
  for (const attendee of draft.attendees) store.addDraftAttendee(attendee);
  store.setDraftOnlineMeeting(draft.addOnlineMeeting);
  if (draft.recurrence) store.setDraftRecurrence(draft.recurrence);
  if (draft.reminders) store.setDraftReminders(draft.reminders);
  return true;
}

/** Opens the event's edit draft moved to `slot`. Saving it is the owner's click. */
export function openRescheduleDraft(store: CalendarStore, eventId: string, slot: SlotRef): boolean {
  if (!store.openEditDraft(eventId)) return false;
  const zone = store.getSnapshot().draft?.draft.timeZone || store.getSnapshot().timeZone;
  store.setDraftTimes(wall(slot.start, zone), wall(slot.end, zone), zone);
  return true;
}

/** Opens a new draft at a free slot, with the people whose time was checked. */
export function openSlotDraft(store: CalendarStore, slot: SlotRef, attendees: readonly string[] = []): boolean {
  const durationMinutes = Math.max(5, Math.round((instantToMs(slot.end) - instantToMs(slot.start)) / 60_000));
  if (!store.openNewDraft({ start: slot.start, durationMinutes })) return false;
  for (const address of attendees) store.addDraftAttendee({ address });
  return true;
}

/** Puts agent proposals on the grid (replacing the agent's earlier ones) and returns them as the store holds them. */
export function placeProposals(store: CalendarStore, proposals: readonly Proposal[]): Proposal[] {
  return store.receiveProposals(proposals, "agent");
}

/** Opens a draft from a proposal; when it was dismissed from the grid meanwhile, from its slot instead. */
export function openProposalDraft(store: CalendarStore, proposal: Proposal): boolean {
  if (store.getSnapshot().proposals.some((item) => item.id === proposal.id)) return store.openDraftFromProposal(proposal.id);
  if (!openSlotDraft(store, { id: proposal.id, start: proposal.start, end: proposal.end }, proposal.attendees.map((item) => item.address))) return false;
  if (proposal.title) store.patchDraft({ title: proposal.title });
  return true;
}
