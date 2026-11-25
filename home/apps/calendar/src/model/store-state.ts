/**
 * The Calendar store's state. Plain, serialisable data only: arrays and
 * records, no Map, Set, class instance or function.
 */
import type {
  BusyBlock,
  CalendarAccount,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  IsoInstant,
} from "../../../_shared/office-accounts/types/calendar";
import { emptyCache, eventsInRange, type EventCache } from "./cache";
import { dayKeyAt, resolveTimeZone, type DayKey } from "./dates";
import type { DraftState } from "./drafts";
import type { CalendarPreferences } from "./preferences";
import type { Proposal } from "./proposals";
import { viewRange, type ViewRange } from "./ranges";
import type { BusyOverlay } from "./slots";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** One connected calendar account and the provider adapter that serves it. */
export interface CalendarConnection {
  account: CalendarAccount;
  provider: CalendarProvider;
}

/** A write that the provider has not confirmed yet. */
export interface PendingWrite {
  id: string;
  kind: "create" | "update" | "delete" | "respond";
  /** For a create, the temporary id of the optimistic event. */
  eventId: string;
  /** What the grid shows meanwhile; null for a delete. */
  optimistic: CalendarEvent | null;
  /** What to put back if the write fails; null for a create. */
  previous: CalendarEvent | null;
}

export interface AssistantState {
  /** People whose busy time is overlaid, lower-cased, at most `MAX_FREE_BUSY_ADDRESSES`. */
  attendees: string[];
  status: LoadStatus;
  error: string | null;
  busy: BusyBlock[];
  /** Range the busy blocks were fetched for; null before the first fetch. */
  busyStart: IsoInstant | null;
  busyEnd: IsoInstant | null;
  /** Busy bands per visible day, ready to draw. */
  overlays: Record<DayKey, BusyOverlay[]>;
  /** Meeting length the assistant searches for. */
  durationMinutes: number;
}

export interface CalendarState {
  preferences: CalendarPreferences;
  /** The zone the grid is drawn in: the preference, else the viewer's zone. */
  timeZone: string;
  /** Today's date in `timeZone`, as of the last navigation. */
  today: DayKey;
  range: ViewRange;

  accounts: CalendarAccount[];
  /** `visible` here is the effective choice: the owner's saved one, else the provider's. */
  calendars: CalendarInfo[];
  accountsStatus: LoadStatus;
  accountsError: string | null;

  eventsStatus: LoadStatus;
  eventsError: string | null;
  /** Events of visible calendars in the current range, ordered by start. */
  events: CalendarEvent[];
  cache: EventCache;

  pending: PendingWrite[];
  /** Ids of events with an unconfirmed write, for a "saving" style. */
  pendingEventIds: string[];
  /** The last failed write, as a fixed sentence. */
  mutationError: string | null;

  draft: DraftState | null;
  assistant: AssistantState;
  /** Candidate slots on the grid, earliest first. */
  proposals: Proposal[];
}

export const MAX_ACCOUNTS = 10;
export const MAX_CALENDARS_PER_ACCOUNT = 200;
export const MAX_BUSY_BLOCKS = 5_000;

export function emptyAssistant(durationMinutes: number): AssistantState {
  return {
    attendees: [],
    status: "idle",
    error: null,
    busy: [],
    busyStart: null,
    busyEnd: null,
    overlays: {},
    durationMinutes,
  };
}

export function rangeFor(preferences: CalendarPreferences, timeZone: string, anchor: DayKey, view = preferences.view): ViewRange {
  return viewRange(view, anchor, {
    timeZone,
    weekStart: preferences.weekStart,
    workDays: preferences.workDays,
    agendaDays: preferences.agendaDays,
  });
}

export function initialState(preferences: CalendarPreferences, now: number): CalendarState {
  const timeZone = resolveTimeZone(preferences.timeZone);
  const today = dayKeyAt(now, timeZone);
  return {
    preferences,
    timeZone,
    today,
    range: rangeFor(preferences, timeZone, today),
    accounts: [],
    calendars: [],
    accountsStatus: "idle",
    accountsError: null,
    eventsStatus: "idle",
    eventsError: null,
    events: [],
    cache: emptyCache(),
    pending: [],
    pendingEventIds: [],
    mutationError: null,
    draft: null,
    assistant: emptyAssistant(preferences.defaultDurationMinutes),
    proposals: [],
  };
}

/**
 * The proposals without the scheduling assistant's: they were found from
 * availability and events that are being replaced, and come back when the
 * search runs on the new ones. Returns the same array when there are none.
 */
export function withoutAssistantProposals(proposals: Proposal[]): Proposal[] {
  return proposals.some((proposal) => proposal.source === "assistant")
    ? proposals.filter((proposal) => proposal.source !== "assistant")
    : proposals;
}

/** Recomputes the fields derived from the cache, calendars, range and pending writes. */
export function withDerived(state: CalendarState): CalendarState {
  const visibleIds = state.calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id);
  return {
    ...state,
    events: eventsInRange(state.cache, visibleIds, state.range.start, state.range.end),
    pendingEventIds: [...new Set(state.pending.map((write) => write.eventId))],
  };
}

/** What the store's action groups share. Internal to the model. */
export interface StoreContext {
  get(): CalendarState;
  /** Applies an update and recomputes derived fields, then notifies subscribers. */
  set(update: (state: CalendarState) => CalendarState): void;
  connections(): readonly CalendarConnection[];
  connectionFor(accountId: string): CalendarConnection | null;
  now(): number;
  /** A process-unique id with a prefix, for temporary event ids and write ids. */
  nextId(prefix: string): string;
  /** Logs the real error and returns the fixed sentence to show. */
  report(action: string, error: unknown): string;
}
