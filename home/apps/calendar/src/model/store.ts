/**
 * The Calendar store: one serialisable state object with `subscribe` and
 * `getSnapshot` (ready for React's `useSyncExternalStore`), plus actions.
 *
 * Navigation, accounts, calendar visibility and event loading live here;
 * writes are in `store-writes.ts`, drafts, the scheduling assistant and
 * proposals in `store-schedule.ts`.
 */
import {
  MAX_EVENT_RANGE_DAYS,
  ProviderError,
  instantToMs,
  toProviderError,
  type CalendarEvent,
  type CalendarInfo,
  type IsoInstant,
} from "../../../_shared/office-accounts/types/calendar";
import { cacheKey, eventsInRange, freshEntry, invalidate, putEntry, touchEntries, type EventCache } from "./cache";
import { dayKeyAt, isDayKey, resolveTimeZone, type DayKey } from "./dates";
import {
  DEFAULT_PREFERENCES,
  createMemoryPersistence,
  parsePreferences,
  withCalendarVisibility,
  type CalendarPersistence,
  type CalendarPreferences,
} from "./preferences";
import { isCalendarView, shiftAnchor, type CalendarView } from "./ranges";
import { busyNeedsReload, createScheduleActions, type ScheduleActions } from "./store-schedule";
import {
  MAX_ACCOUNTS,
  MAX_CALENDARS_PER_ACCOUNT,
  initialState,
  rangeFor,
  withDerived,
  withoutAssistantProposals,
  type CalendarConnection,
  type CalendarState,
  type StoreContext,
} from "./store-state";
import { createWriteActions, createWriteLog, reapplyPending, withConfirmedWrites, type ConfirmedWrite, type WriteActions } from "./store-writes";

export const MAX_SUBSCRIBERS = 64;
const MS_PER_DAY = 86_400_000;

export interface CalendarStoreOptions {
  /** Lists connected accounts with their provider adapters. */
  connect(): Promise<CalendarConnection[]>;
  persistence?: CalendarPersistence;
  now?: () => number;
  /** Where real errors are logged; the state only ever holds fixed sentences. */
  log?: (action: string, error: unknown) => void;
}

/** Preference fields the owner can change from settings. */
export type PreferenceChanges = Partial<Pick<CalendarPreferences,
  "weekStart" | "workDays" | "workingHours" | "agendaDays" | "timeZone" | "defaultDurationMinutes">>;

export interface CalendarStore extends WriteActions, ScheduleActions {
  getSnapshot(): CalendarState;
  /** Returns an unsubscribe function. At most `MAX_SUBSCRIBERS` at once. */
  subscribe(listener: () => void): () => void;
  /** Loads preferences, accounts, calendars, events and agent proposals. */
  init(): Promise<void>;
  loadAccounts(): Promise<void>;
  /** Loads events of visible calendars for the current range; cached ranges are reused unless `force`. */
  loadEvents(options?: { force?: boolean }): Promise<void>;
  /**
   * Events of visible calendars in `[start, end)`, at most `MAX_EVENT_RANGE_DAYS`
   * long, fetched for exactly that range (fresh cache entries are reused) and
   * with unconfirmed writes applied. The grid does not move. Rejects, instead
   * of answering in part, when any calendar cannot be read.
   */
  readEvents(start: IsoInstant, end: IsoInstant): Promise<CalendarEvent[]>;
  /** Drops the cache and reloads. */
  refresh(): Promise<void>;
  setView(view: CalendarView): void;
  goToDate(day: DayKey): void;
  /** Moves whole views forward (positive) or back. */
  shift(steps: number): void;
  goToToday(): void;
  setCalendarVisible(calendarId: string, visible: boolean): void;
  setPreferences(changes: PreferenceChanges): void;
  /** Resolves when every queued preference write has finished. */
  flush(): Promise<void>;
}

function defaultLog(action: string, error: unknown): void {
  console.warn(`[calendar] ${action} failed`, error);
}

export function createCalendarStore(options: CalendarStoreOptions): CalendarStore {
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  const persistence = options.persistence ?? createMemoryPersistence();
  let state = initialState(DEFAULT_PREFERENCES, now());
  let connections: CalendarConnection[] = [];
  const listeners: Array<() => void> = [];
  let idCounter = 0;
  let eventsToken = 0;
  let saveQueue: Promise<void> = Promise.resolve();
  let inflight: { key: string; promise: Promise<void> } | null = null;

  const ctx: StoreContext = {
    get: () => state,
    set(update) {
      const next = update(state);
      if (next === state) return;
      state = withDerived(next);
      for (const listener of [...listeners]) listener();
    },
    connections: () => connections,
    connectionFor: (accountId) => connections.find((connection) => connection.account.id === accountId) ?? null,
    now,
    nextId(prefix) {
      idCounter += 1;
      return `${prefix}:${idCounter}`;
    },
    report(action, error) {
      log(action, error);
      return toProviderError(error).message;
    },
  };

  const schedule = createScheduleActions(ctx, persistence);
  const writeLog = createWriteLog();
  const writes = createWriteActions(ctx, { log: writeLog, onProposalUsed: (id) => schedule.proposalUsed(id) });

  function savePreferences(): void {
    const snapshot = state.preferences;
    saveQueue = saveQueue
      .then(() => persistence.savePreferences(snapshot))
      .catch((error: unknown) => log("save preferences", error));
  }

  function applyCalendarVisibility(calendars: CalendarInfo[], preferences: CalendarPreferences): CalendarInfo[] {
    return calendars.map((calendar) => ({ ...calendar, visible: preferences.calendarVisibility[calendar.id] ?? calendar.visible }));
  }

  /** After the range changed: overlays follow, events and stale busy time are fetched. */
  function afterNavigation(): void {
    if (busyNeedsReload(state)) {
      ctx.set((current) => ({ ...current, assistant: { ...current.assistant, overlays: {} } }));
      void schedule.loadBusy();
    }
    void loadEvents();
  }

  function navigate(anchor: DayKey, view: CalendarView = state.preferences.view): void {
    ctx.set((current) => ({
      ...current,
      today: dayKeyAt(now(), current.timeZone),
      range: rangeFor(current.preferences, current.timeZone, anchor, view),
    }));
    afterNavigation();
  }

  /** The same request while one is in flight returns that request instead of fetching twice. */
  function loadEvents(loadOptions: { force?: boolean } = {}): Promise<void> {
    const { range, calendars } = state;
    const key = [range.start, range.end, loadOptions.force ? "force" : "", ...calendars.filter((c) => c.visible).map((c) => c.id)].join("|");
    if (inflight?.key === key) return inflight.promise;
    const promise = runLoadEvents(loadOptions).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { key, promise };
    return promise;
  }

  interface Fetched {
    results: PromiseSettledResult<{ calendarIds: string[]; events: CalendarEvent[] }>[];
    /** When the reply was asked for, so a later reply for an overlapping range wins. */
    askedAt: number;
    /** Writes confirmed while the read was out; null when too many were to keep track of. */
    confirmed: ConfirmedWrite[] | null;
  }

  /** One `listEvents` call per account for the given calendars and range. */
  async function fetchEvents(calendars: readonly CalendarInfo[], start: IsoInstant, end: IsoInstant): Promise<Fetched> {
    const byAccount: Record<string, string[]> = {};
    for (const calendar of calendars) (byAccount[calendar.accountId] ??= []).push(calendar.id);
    const askedAt = now();
    const mark = writeLog.beginRead();
    const results = await Promise.allSettled(Object.entries(byAccount).map(async ([accountId, calendarIds]) => {
      const connection = ctx.connectionFor(accountId);
      if (!connection) throw new ProviderError("not_connected");
      const events = await connection.provider.listEvents({ calendarIds, start, end });
      return { calendarIds, events };
    }));
    return { results, askedAt, confirmed: writeLog.endRead(mark) };
  }

  /**
   * The cache with every fulfilled result stored for the range, writes
   * confirmed meanwhile put on top; the first failure, reported, as a fixed sentence.
   */
  function storeResults(cache: EventCache, fetched: Fetched, start: IsoInstant, end: IsoInstant, action: string): { cache: EventCache; error: string | null } {
    const { confirmed } = fetched;
    if (confirmed === null) {
      // The reply may predate writes no longer on record; storing it could undo them.
      return { cache, error: ctx.report(action, new ProviderError("failed")) };
    }
    let error: string | null = null;
    let nextCache = cache;
    const startMs = instantToMs(start);
    const endMs = instantToMs(end);
    for (const result of fetched.results) {
      if (result.status === "rejected") {
        error ??= ctx.report(action, result.reason);
        continue;
      }
      for (const calendarId of result.value.calendarIds) {
        const events = withConfirmedWrites(result.value.events.filter((event) => event.calendarId === calendarId), confirmed, calendarId, startMs, endMs);
        nextCache = putEntry(nextCache, { calendarId, start, end, events, fetchedAt: fetched.askedAt });
      }
    }
    return { cache: nextCache, error };
  }

  async function runLoadEvents(loadOptions: { force?: boolean }): Promise<void> {
    // Every load supersedes the one before, including one answered from the cache,
    // so an abandoned range's late reply never sets the shown range's status.
    const token = ++eventsToken;
    const { range, calendars, cache } = state;
    const visible = calendars.filter((calendar) => calendar.visible);
    const keys = visible.map((calendar) => cacheKey(calendar.id, range.start, range.end));
    const at = now();
    const missing = visible.filter((_, index) => loadOptions.force || !freshEntry(cache, keys[index], at));
    ctx.set((current) => ({ ...current, cache: touchEntries(current.cache, keys) }));
    if (missing.length === 0) {
      ctx.set((current) => ({ ...current, eventsStatus: "ready", eventsError: null }));
      return;
    }
    ctx.set((current) => ({ ...current, eventsStatus: "loading", eventsError: null, proposals: withoutAssistantProposals(current.proposals) }));
    const fetched = await fetchEvents(missing, range.start, range.end);
    ctx.set((current) => {
      const stored = storeResults(current.cache, fetched, range.start, range.end, "load events");
      const nextCache = reapplyPending(stored.cache, current.pending);
      if (token !== eventsToken) return { ...current, cache: nextCache };
      return { ...current, cache: nextCache, eventsStatus: stored.error ? "error" : "ready", eventsError: stored.error };
    });
  }

  async function readEvents(start: IsoInstant, end: IsoInstant): Promise<CalendarEvent[]> {
    const startMs = instantToMs(start);
    const endMs = instantToMs(end);
    if (!(endMs > startMs) || endMs - startMs > MAX_EVENT_RANGE_DAYS * MS_PER_DAY) {
      throw new RangeError(`An event range must end after it starts and span at most ${MAX_EVENT_RANGE_DAYS} days`);
    }
    const visible = state.calendars.filter((calendar) => calendar.visible);
    const keys = visible.map((calendar) => cacheKey(calendar.id, start, end));
    const at = now();
    const missing = visible.filter((_, index) => !freshEntry(state.cache, keys[index], at));
    if (missing.length > 0) {
      const fetched = await fetchEvents(missing, start, end);
      let error: string | null = null;
      ctx.set((current) => {
        const stored = storeResults(current.cache, fetched, start, end, "read events");
        error = stored.error;
        return { ...current, cache: reapplyPending(stored.cache, current.pending) };
      });
      if (error !== null) throw new ProviderError("failed");
    }
    ctx.set((current) => ({ ...current, cache: touchEntries(current.cache, keys) }));
    const { cache, calendars } = state;
    const ids = calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id);
    // Every visible calendar must have this range cached; a calendar shown or evicted meanwhile is not an answer.
    if (ids.some((id) => !cache.entries[cacheKey(id, start, end)])) throw new ProviderError("failed");
    return eventsInRange(cache, ids, start, end);
  }

  async function loadAccounts(): Promise<void> {
    ctx.set((current) => ({ ...current, accountsStatus: "loading", accountsError: null }));
    try {
      connections = (await options.connect()).slice(0, MAX_ACCOUNTS);
    } catch (error: unknown) {
      const message = ctx.report("list accounts", error);
      ctx.set((current) => ({ ...current, accountsStatus: "error", accountsError: message }));
      return;
    }
    const results = await Promise.allSettled(connections.map((connection) => connection.provider.listCalendars()));
    let error: string | null = null;
    const calendars: CalendarInfo[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        error ??= ctx.report("list calendars", result.reason);
        return;
      }
      const accountId = connections[index].account.id;
      calendars.push(...result.value.slice(0, MAX_CALENDARS_PER_ACCOUNT).map((calendar) => ({ ...calendar, accountId })));
    });
    ctx.set((current) => ({
      ...current,
      accounts: connections.map((connection) => ({ ...connection.account })),
      calendars: applyCalendarVisibility(calendars, current.preferences),
      accountsStatus: error && calendars.length === 0 ? "error" : "ready",
      accountsError: error,
    }));
    await loadEvents();
  }

  function applyPreferences(preferences: CalendarPreferences, anchor: DayKey): void {
    const timeZone = resolveTimeZone(preferences.timeZone);
    ctx.set((current) => ({
      ...current,
      preferences,
      timeZone,
      today: dayKeyAt(now(), timeZone),
      range: rangeFor(preferences, timeZone, anchor),
      calendars: applyCalendarVisibility(current.calendars, preferences),
      assistant: current.assistant.attendees.length > 0
        ? current.assistant
        : { ...current.assistant, durationMinutes: preferences.defaultDurationMinutes },
    }));
  }

  return {
    ...writes,
    ...schedule,
    getSnapshot: () => state,
    subscribe(listener) {
      if (listeners.length >= MAX_SUBSCRIBERS) throw new RangeError("Too many calendar store subscribers");
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },

    async init() {
      try {
        const stored = parsePreferences(await persistence.loadPreferences());
        applyPreferences(stored, dayKeyAt(now(), resolveTimeZone(stored.timeZone)));
      } catch (error: unknown) {
        log("load preferences", error);
      }
      await Promise.all([loadAccounts(), schedule.loadAgentProposals()]);
    },

    loadAccounts,
    loadEvents,
    readEvents,

    async refresh() {
      ctx.set((current) => ({ ...current, cache: reapplyPending(invalidate(current.cache), current.pending) }));
      await loadEvents({ force: true });
    },

    setView(view) {
      if (!isCalendarView(view) || view === state.preferences.view) return;
      ctx.set((current) => ({ ...current, preferences: { ...current.preferences, view } }));
      savePreferences();
      navigate(state.range.anchor, view);
    },

    goToDate(day) {
      if (!isDayKey(day)) return;
      navigate(day);
    },

    shift(steps) {
      if (!Number.isInteger(steps) || steps === 0) return;
      const { range, preferences, timeZone } = state;
      navigate(shiftAnchor(range.view, range.anchor, steps, {
        timeZone,
        weekStart: preferences.weekStart,
        workDays: preferences.workDays,
        agendaDays: preferences.agendaDays,
      }));
    },

    goToToday() {
      navigate(dayKeyAt(now(), state.timeZone));
    },

    setCalendarVisible(calendarId, visible) {
      const calendar = state.calendars.find((item) => item.id === calendarId);
      if (!calendar || calendar.visible === visible) return;
      ctx.set((current) => {
        const preferences = withCalendarVisibility(current.preferences, calendarId, visible);
        return { ...current, preferences, calendars: applyCalendarVisibility(current.calendars, preferences) };
      });
      savePreferences();
      if (visible) void loadEvents();
    },

    setPreferences(changes) {
      const merged = parsePreferences({ ...state.preferences, ...changes });
      applyPreferences(merged, state.range.anchor);
      savePreferences();
      afterNavigation();
    },

    flush() {
      return saveQueue;
    },
  };
}
