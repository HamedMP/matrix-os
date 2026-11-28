/**
 * Draft editing, the scheduling assistant and proposals.
 *
 * The assistant fetches attendees' busy time for the visible range, draws it
 * as overlays, and finds common free slots that become "assistant" proposals.
 * Agent proposals arrive through `receiveProposals` or the proposals table.
 * Clicking a proposal opens a draft; nothing is created until the owner saves.
 */
import { isValidMailAddress } from "../../../_shared/office-accounts/types/addresses";
import {
  MAX_EVENT_ATTENDEES,
  MAX_FREE_BUSY_ADDRESSES,
  ProviderError,
  instantToMs,
  type BusyBlock,
  type CalendarInfo,
  type CalendarProvider,
  type EventDraft,
  type EventDraftAttendee,
  type EventReminder,
  type IsoInstant,
  type Recurrence,
} from "../../../_shared/office-accounts/types/calendar";
import { findCachedEvent } from "./cache";
import { MINUTES_PER_DAY, MS_PER_MINUTE, daySlices, type DayKey } from "./dates";
import {
  addDraftAttendee,
  allDayDraft,
  draftAt,
  draftForGrid,
  draftFromEvent,
  draftFromProposal,
  draftState,
  eventRepeat,
  removeDraftAttendee,
  setAttendeeOptional,
  setDraftAllDay,
  setDraftOnlineMeeting,
  setDraftRecurrence,
  setDraftReminders,
  setDraftTimes,
  withDraft,
  type DraftBase,
} from "./drafts";
import type { CalendarPersistence } from "./preferences";
import { mergeProposals, parseProposals, proposalsFromSlots, type Proposal, type ProposalSource } from "./proposals";
import { MAX_SLOT_RESULTS, busyOverlays, findSlots, isSlotDuration } from "./slots";
import { MAX_BUSY_BLOCKS, shownRangeTruncated, withoutAssistantProposals, type CalendarConnection, type CalendarState, type StoreContext } from "./store-state";

export const NO_CALENDAR_MESSAGE = "Connect a calendar you can write to first.";

/** The calendar new events go on: a writable primary calendar, else any writable one. */
export function defaultCalendar(calendars: readonly CalendarInfo[], preferredId?: string): CalendarInfo | null {
  const writable = calendars.filter((calendar) => calendar.writable);
  return writable.find((calendar) => calendar.id === preferredId)
    ?? writable.find((calendar) => calendar.primary && calendar.visible)
    ?? writable.find((calendar) => calendar.primary)
    ?? writable[0]
    ?? null;
}

/** Lower-cased, valid, unique addresses, at most `MAX_EVENT_ATTENDEES` (every guest an event can have). */
export function normalizeAttendeeAddresses(addresses: readonly string[]): string[] {
  const result = new Set<string>();
  for (const raw of addresses) {
    const address = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!address || !isValidMailAddress(address) || result.has(address)) continue;
    result.add(address);
    if (result.size >= MAX_EVENT_ATTENDEES) break;
  }
  return [...result];
}

/**
 * Busy time for every one of `addresses` (normalized), asked in batches of
 * `MAX_FREE_BUSY_ADDRESSES`, the most one provider call answers for. Rejects
 * when any batch fails, so nobody is left out and taken for free. At most
 * `MAX_BUSY_BLOCKS` blocks are kept; a person whose blocks did not fit gets
 * one unknown block for the range instead, so they never look free either.
 */
export async function readBusyInBatches(
  provider: Pick<CalendarProvider, "getFreeBusy">,
  addresses: readonly string[],
  start: IsoInstant,
  end: IsoInstant,
): Promise<BusyBlock[]> {
  const people = normalizeAttendeeAddresses(addresses);
  const batches: string[][] = [];
  for (let index = 0; index < people.length; index += MAX_FREE_BUSY_ADDRESSES) batches.push(people.slice(index, index + MAX_FREE_BUSY_ADDRESSES));
  // At most MAX_EVENT_ATTENDEES / MAX_FREE_BUSY_ADDRESSES (5) calls, asked together.
  const blocks = (await Promise.all(batches.map((batch) => provider.getFreeBusy(batch, start, end)))).flat();
  if (blocks.length <= MAX_BUSY_BLOCKS) return blocks;
  const kept = blocks.slice(0, MAX_BUSY_BLOCKS - people.length);
  const cut = new Set(blocks.slice(kept.length).map((block) => block.address.toLowerCase()));
  return [...kept, ...[...cut].map((address): BusyBlock => ({ address, start, end, status: "unknown" }))];
}

/** The owner's own timed events in the range as busy blocks (declined and all-day events do not block). */
export function ownerBusy(state: CalendarState): BusyBlock[] {
  // An empty address means the account's address is unknown; the blocks still count as the owner's.
  const owner = state.accounts[0]?.address || "me";
  return state.events
    .filter((event) => !event.allDay && event.myResponse !== "declined")
    .map((event) => ({ address: owner, start: event.start, end: event.end, status: event.myResponse === "tentative" ? "tentative" : "busy" }));
}

export interface FindSlotsRequest {
  durationMinutes?: number;
  maxResults?: number;
  /** Count the owner's own events as busy. Default true. */
  includeOwnEvents?: boolean;
  /** Title and attendees copied onto each proposal. */
  title?: string;
}

export interface ScheduleActions {
  openNewDraft(input?: { start?: IsoInstant; durationMinutes?: number; calendarId?: string }): boolean;
  /** A click or drag on the time grid: wall-clock minutes on a day in the grid's zone. */
  openDraftForGrid(day: DayKey, startMinute: number, endMinute?: number): boolean;
  /** A click in the bar row or a month cell. */
  openAllDayDraft(startDay: DayKey, lastDay?: DayKey): boolean;
  openEditDraft(eventId: string): boolean;
  openDraftFromProposal(proposalId: string): boolean;
  patchDraft(patch: Partial<Pick<EventDraft, "title" | "location" | "descriptionText" | "calendarId">>): void;
  setDraftTimes(startWall: string, endWall: string, timeZone?: string): void;
  setDraftAllDay(allDay: boolean): void;
  addDraftAttendee(attendee: EventDraftAttendee): void;
  removeDraftAttendee(address: string): void;
  setDraftAttendeeOptional(address: string, optional: boolean): void;
  setDraftOnlineMeeting(on: boolean): void;
  setDraftRecurrence(recurrence: Recurrence | null): void;
  setDraftReminders(reminders: readonly EventReminder[] | null): void;
  closeDraft(): void;

  /** Whose busy time to overlay. Fetches it for the visible range; a changed list drops the assistant's suggestions. */
  setAssistantAttendees(addresses: readonly string[]): Promise<void>;
  setAssistantDuration(minutes: number): void;
  /** (Re)fetches busy time for the visible range. */
  loadBusy(): Promise<void>;
  /**
   * Busy time of people for any range, straight from the provider that serves
   * the draft's (else the default) calendar. Read only: the grid's overlays are
   * not changed. Rejects when no calendar is connected or the lookup fails.
   */
  readFreeBusy(addresses: readonly string[], start: IsoInstant, end: IsoInstant): Promise<BusyBlock[]>;
  /**
   * Finds common free slots in the visible range and shows them as assistant
   * proposals. A length the search does not support (see `isSlotDuration`)
   * finds nothing and clears the assistant's earlier suggestions.
   */
  findSlots(request?: FindSlotsRequest): Proposal[];

  /** Validates and shows proposals from an untrusted source, replacing that source's earlier ones. */
  receiveProposals(raw: unknown, source?: ProposalSource): Proposal[];
  /** Reads the agent's proposals from the proposals table. */
  loadAgentProposals(): Promise<void>;
  dismissProposal(proposalId: string): void;
  clearProposals(source?: ProposalSource): void;
  /** Removes a proposal after it became an event (also deletes its stored row). */
  proposalUsed(proposalId: string): void;
}

export function createScheduleActions(ctx: StoreContext, persistence: CalendarPersistence): ScheduleActions {
  let busyToken = 0;

  function base(calendarId?: string): DraftBase | null {
    const state = ctx.get();
    const calendar = defaultCalendar(state.calendars, calendarId);
    if (!calendar) {
      ctx.set((current) => ({ ...current, mutationError: NO_CALENDAR_MESSAGE }));
      return null;
    }
    return { calendarId: calendar.id, timeZone: state.timeZone };
  }

  /** True while a draft is being saved: it stays until the save settles, so a failed save keeps its edits. */
  function saving(): boolean {
    return ctx.get().draft?.status === "saving";
  }

  function open(draft: EventDraft, extra: Parameters<typeof draftState>[1] = {}): boolean {
    if (saving()) return false;
    ctx.set((state) => ({ ...state, mutationError: null, draft: draftState(draft, extra) }));
    return true;
  }

  function edit(update: (draft: EventDraft, state: CalendarState) => EventDraft): void {
    ctx.set((state) => {
      if (!state.draft || state.draft.status === "saving") return state;
      try {
        return { ...state, draft: withDraft(state.draft, update(state.draft.draft, state)) };
      } catch (error: unknown) {
        if (!(error instanceof RangeError)) throw error;
        return { ...state, draft: { ...state.draft, issues: ["invalid_time"] } };
      }
    });
  }

  function recomputeOverlays(state: CalendarState): CalendarState {
    return {
      ...state,
      assistant: { ...state.assistant, overlays: busyOverlays(state.assistant.busy, daySlices(state.range.days, state.timeZone), state.timeZone) },
    };
  }

  /** The connection that answers free-busy: the draft's calendar account, else the default calendar's, else any. */
  function busyConnection(state: CalendarState): CalendarConnection | null {
    const calendarId = state.draft?.draft.calendarId ?? defaultCalendar(state.calendars)?.id;
    const accountId = state.calendars.find((calendar) => calendar.id === calendarId)?.accountId;
    return (accountId ? ctx.connectionFor(accountId) : null) ?? ctx.connections()[0] ?? null;
  }

  async function loadBusy(): Promise<void> {
    // Every call supersedes the one before, including calls that return early,
    // so a slow earlier reply can never repaint guests that were cleared.
    const token = ++busyToken;
    const state = ctx.get();
    const { attendees } = state.assistant;
    if (attendees.length === 0) {
      ctx.set((current) => ({
        ...current,
        assistant: { ...current.assistant, status: "idle", error: null, busy: [], busyStart: null, busyEnd: null, overlays: {} },
        proposals: withoutAssistantProposals(current.proposals),
      }));
      return;
    }
    const connection = busyConnection(state);
    if (!connection) {
      ctx.set((current) => ({
        ...current,
        assistant: { ...current.assistant, status: "error", error: NO_CALENDAR_MESSAGE, busy: [], busyStart: null, busyEnd: null, overlays: {} },
        proposals: withoutAssistantProposals(current.proposals),
      }));
      return;
    }
    const { start, end } = state.range;
    ctx.set((current) => ({
      ...current,
      assistant: { ...current.assistant, status: "loading", error: null },
      proposals: withoutAssistantProposals(current.proposals),
    }));
    try {
      const busy = await readBusyInBatches(connection.provider, attendees, start, end);
      if (token !== busyToken) return;
      ctx.set((current) => recomputeOverlays({
        ...current,
        assistant: { ...current.assistant, status: "ready", busy, busyStart: start, busyEnd: end },
      }));
    } catch (error: unknown) {
      const message = ctx.report("load free-busy", error);
      if (token !== busyToken) return;
      ctx.set((current) => ({ ...current, assistant: { ...current.assistant, status: "error", error: message } }));
    }
  }

  function removeProposal(proposalId: string): void {
    const proposal = ctx.get().proposals.find((item) => item.id === proposalId);
    ctx.set((state) => ({ ...state, proposals: state.proposals.filter((item) => item.id !== proposalId) }));
    if (proposal?.source === "agent" && proposal.rowId) {
      persistence.deleteProposal(proposal.rowId).catch((error: unknown) => {
        ctx.report("delete proposal", error);
      });
    }
  }

  return {
    openNewDraft(input = {}) {
      const draftBase = base(input.calendarId);
      if (!draftBase) return false;
      const duration = input.durationMinutes ?? ctx.get().preferences.defaultDurationMinutes;
      const step = 30 * MS_PER_MINUTE;
      const startMs = input.start ? instantToMs(input.start) : Math.ceil(ctx.now() / step) * step;
      return open(draftAt(startMs, duration, draftBase));
    },

    openDraftForGrid(day, startMinute, endMinute) {
      const draftBase = base();
      if (!draftBase) return false;
      const duration = ctx.get().preferences.defaultDurationMinutes;
      const end = Math.min(MINUTES_PER_DAY, endMinute !== undefined && endMinute > startMinute ? endMinute : startMinute + duration);
      return open(draftForGrid(day, startMinute, end, draftBase));
    },

    openAllDayDraft(startDay, lastDay) {
      const draftBase = base();
      if (!draftBase) return false;
      return open(allDayDraft(startDay, lastDay ?? startDay, draftBase));
    },

    openEditDraft(eventId) {
      const event = findCachedEvent(ctx.get().cache, eventId);
      if (!event || eventId.startsWith("pending:")) return false;
      const draft = draftFromEvent(event);
      return open(draft, { mode: "edit", eventId, original: draft, repeat: eventRepeat(event) });
    },

    openDraftFromProposal(proposalId) {
      const proposal = ctx.get().proposals.find((item) => item.id === proposalId);
      if (!proposal) return false;
      const draftBase = base(proposal.calendarId);
      if (!draftBase) return false;
      return open(draftFromProposal(proposal, draftBase), { proposalId });
    },

    patchDraft(patch) {
      edit((draft) => ({ ...draft, ...patch }));
    },
    setDraftTimes(startWall, endWall, timeZone) {
      edit((draft, state) => setDraftTimes(draft, startWall, endWall, timeZone ?? (draft.allDay ? state.timeZone : draft.timeZone)));
    },
    setDraftAllDay(allDay) {
      edit((draft, state) => setDraftAllDay(draft, allDay, state.timeZone));
    },
    addDraftAttendee(attendee) {
      edit((draft) => addDraftAttendee(draft, attendee));
    },
    removeDraftAttendee(address) {
      edit((draft) => removeDraftAttendee(draft, address));
    },
    setDraftAttendeeOptional(address, optional) {
      edit((draft) => setAttendeeOptional(draft, address, optional));
    },
    // The provider can add a video meeting to an existing event but not remove one.
    setDraftOnlineMeeting(on) {
      const current = ctx.get().draft;
      if (!on && current?.mode === "edit" && current.original?.addOnlineMeeting) return;
      edit((draft) => setDraftOnlineMeeting(draft, on));
    },
    // An existing event's repeat rule and reminders are not read back from the
    // provider, so an edit draft leaves them as the provider holds them.
    setDraftRecurrence(recurrence) {
      if (ctx.get().draft?.mode === "edit") return;
      edit((draft) => setDraftRecurrence(draft, recurrence));
    },
    setDraftReminders(reminders) {
      if (ctx.get().draft?.mode === "edit") return;
      edit((draft) => setDraftReminders(draft, reminders));
    },
    closeDraft() {
      ctx.set((state) => (state.draft?.status === "saving" ? state : { ...state, draft: null }));
    },

    async setAssistantAttendees(addresses) {
      const attendees = normalizeAttendeeAddresses(addresses);
      ctx.set((state) => {
        const changed = attendees.join(",") !== state.assistant.attendees.join(",");
        // Suggestions were checked against the earlier guests only; they go until a new search runs.
        return { ...state, assistant: { ...state.assistant, attendees }, proposals: changed ? withoutAssistantProposals(state.proposals) : state.proposals };
      });
      await loadBusy();
    },
    setAssistantDuration(minutes) {
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > MINUTES_PER_DAY) return;
      ctx.set((state) => ({ ...state, assistant: { ...state.assistant, durationMinutes: minutes } }));
    },
    loadBusy,

    async readFreeBusy(addresses, start, end) {
      if (normalizeAttendeeAddresses(addresses).length === 0) return [];
      const connection = busyConnection(ctx.get());
      if (!connection) throw new ProviderError("not_connected");
      return readBusyInBatches(connection.provider, addresses, start, end);
    },

    findSlots(request = {}) {
      const state = ctx.get();
      const durationMinutes = request.durationMinutes ?? state.assistant.durationMinutes;
      const maxResults = request.maxResults ?? 5;
      // With the owner's events counted, a range missing some of them would offer times over hidden meetings.
      const ownEventsMissing = request.includeOwnEvents !== false && shownRangeTruncated(state);
      if (ownEventsMissing || !isSlotDuration(durationMinutes) || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SLOT_RESULTS) {
        ctx.set((current) => (current.proposals.some((item) => item.source === "assistant")
          ? { ...current, proposals: current.proposals.filter((item) => item.source !== "assistant") }
          : current));
        return [];
      }
      const busy = [
        ...(state.assistant.busyStart === state.range.start && state.assistant.busyEnd === state.range.end ? state.assistant.busy : []),
        ...(request.includeOwnEvents === false ? [] : ownerBusy(state)),
      ];
      const slots = findSlots({
        busy,
        rangeStart: state.range.start,
        rangeEnd: state.range.end,
        durationMinutes,
        maxResults,
        timeZone: state.timeZone,
        workingHours: state.preferences.workingHours,
        notBefore: ctx.now(),
        distinct: true,
      });
      const attendees = state.assistant.attendees.map((address) => ({ address }));
      const proposals = proposalsFromSlots(slots, { title: request.title ?? state.draft?.draft.title, attendees });
      ctx.set((current) => ({ ...current, proposals: mergeProposals(current.proposals, proposals, "assistant") }));
      return proposals;
    },

    receiveProposals(raw, source = "agent") {
      const proposals = parseProposals(raw, source);
      ctx.set((state) => ({ ...state, proposals: mergeProposals(state.proposals, proposals, source) }));
      return proposals;
    },

    async loadAgentProposals() {
      try {
        const rows = await persistence.loadProposals();
        const proposals = parseProposals(rows, "agent");
        ctx.set((state) => ({ ...state, proposals: mergeProposals(state.proposals, proposals, "agent") }));
      } catch (error: unknown) {
        ctx.report("load proposals", error);
      }
    },

    dismissProposal: removeProposal,
    proposalUsed: removeProposal,

    clearProposals(source) {
      ctx.set((state) => ({ ...state, proposals: source ? state.proposals.filter((item) => item.source !== source) : [] }));
    },
  };
}

/** Called by the store after navigation: overlays follow the new range, and stale busy data is refetched. */
export function busyNeedsReload(state: CalendarState): boolean {
  return state.assistant.attendees.length > 0
    && (state.assistant.busyStart !== state.range.start || state.assistant.busyEnd !== state.range.end);
}
