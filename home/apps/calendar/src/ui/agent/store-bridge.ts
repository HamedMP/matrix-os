/**
 * Connects the Calendar agent to the Calendar store.
 *
 * - `agentContext(state, now)` is what the agent may read.
 * - `createStoreAgentDeps(store, options)` gives the agent read-only access:
 *   the model call, events and free-busy for exactly the window it asks
 *   about, whatever view the grid shows. There is no write path here.
 * - `openAgentDraft`, `openRescheduleDraft` and `openSlotDraft` put an agent
 *   result into the event composer. They only open drafts; sending stays an
 *   explicit click in the composer.
 */
import type { MatrixOSBridge } from "../../../../_shared/matrix-os";
import {
  instantInZone,
  instantToMs,
  wallTimeOf,
  type EventDraft,
  type IsoInstant,
} from "../../../../_shared/office-accounts/types/calendar";
import type { CalendarAgentContext, CalendarAgentDeps, SlotRef } from "../../agent";
import { dayKeyAt, type CalendarState, type CalendarStore, type Proposal } from "../../model";

export function agentContext(state: CalendarState, now: number): CalendarAgentContext {
  return {
    now,
    timeZone: state.timeZone,
    weekStart: state.preferences.weekStart,
    workingHours: state.preferences.workingHours,
    defaultDurationMinutes: state.preferences.defaultDurationMinutes,
    // An empty address means the account's address is unknown.
    ownerAddress: state.accounts[0]?.address.toLowerCase() || null,
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

export interface StoreAgentOptions {
  /** One model call; defaults to `MatrixOS.ai.generate`. */
  generate?: (prompt: string) => Promise<string>;
  /** Free-busy straight from a provider; defaults to the store's provider lookup. */
  getFreeBusy?: CalendarAgentDeps["getFreeBusy"];
  log?: (action: string, error: unknown) => void;
  /** False once the request was stopped or its panel closed; the grid is then left where it is. Default: always true. */
  isActive?: () => boolean;
}

export function createStoreAgentDeps(store: CalendarStore, options: StoreAgentOptions = {}): CalendarAgentDeps {
  return {
    generate: options.generate ?? bridgeGenerate,
    async listEvents(start, end) {
      // The whole window is read directly, so the answer never depends on the
      // view; a calendar that cannot be read fails the read instead of leaving a gap.
      const events = await store.readEvents(start, end);
      // The grid then shows the window's first day, so the answer is what the owner sees.
      const state = store.getSnapshot();
      if ((options.isActive?.() ?? true) && !covers(state, start, end)) store.goToDate(dayKeyAt(instantToMs(start), state.timeZone));
      return events;
    },
    getFreeBusy(addresses, start, end) {
      return options.getFreeBusy ? options.getFreeBusy(addresses, start, end) : store.readFreeBusy(addresses, start, end);
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

/** Opens the event's edit draft moved to start at `slot`, keeping the event's own length. Saving it is the owner's click. */
export function openRescheduleDraft(store: CalendarStore, eventId: string, slot: SlotRef): boolean {
  if (!store.openEditDraft(eventId)) return false;
  const opened = store.getSnapshot().draft?.draft;
  const zone = opened?.timeZone || store.getSnapshot().timeZone;
  const startMs = instantToMs(slot.start);
  const lengthMs = opened ? Math.max(0, instantToMs(opened.end) - instantToMs(opened.start)) : instantToMs(slot.end) - startMs;
  store.setDraftTimes(wall(slot.start, zone), wall(new Date(startMs + lengthMs).toISOString(), zone), zone);
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
