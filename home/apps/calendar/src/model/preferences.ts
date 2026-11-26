/**
 * Owner preferences (view, week start, working hours, per-calendar
 * visibility) and where they are kept.
 *
 * Persistence goes through `CalendarPersistence`. In the app it is
 * `createDbPersistence(window.MatrixOS.db)`, backed by the tables declared in
 * matrix.json; tests and hosts without a bridge use `createMemoryPersistence`.
 */
import { MAX_EVENT_RANGE_DAYS } from "../../../_shared/office-accounts/types/calendar";
import { isValidTimeZone, isWeekdayIndex, type WeekdayIndex } from "./dates";
import { isCalendarView, type CalendarView } from "./ranges";
import { DEFAULT_WORKING_HOURS, isValidWorkingHours, type WorkingHours } from "./slots";
import { MAX_PROPOSALS } from "./proposals";

export const PREFERENCES_TABLE = "calendar_preferences";
export const PROPOSALS_TABLE = "calendar_proposals";
/** The unique `slot` of the one row that holds the preferences. */
export const PREFERENCES_SLOT = "preferences";
/** Attempts before a save that keeps losing to other windows is given up (and logged by the caller). */
const MAX_WRITE_ATTEMPTS = 5;
/** Calendars whose show or hide choice is remembered; the oldest choices are dropped first. */
export const MAX_VISIBILITY_ENTRIES = 500;
const MAX_CALENDAR_ID_LENGTH = 512;

export interface CalendarPreferences {
  version: 1;
  view: CalendarView;
  weekStart: WeekdayIndex;
  /** Days the work week view shows. */
  workDays: WeekdayIndex[];
  workingHours: WorkingHours;
  agendaDays: number;
  /** IANA zone the grid is drawn in; null follows the viewer's zone. */
  timeZone: string | null;
  defaultDurationMinutes: number;
  /** The owner's show or hide choice per calendar id; absent means the provider's default. */
  calendarVisibility: Record<string, boolean>;
}

export const DEFAULT_PREFERENCES: CalendarPreferences = Object.freeze({
  version: 1,
  view: "week",
  weekStart: 1,
  workDays: [1, 2, 3, 4, 5],
  workingHours: { days: [1, 2, 3, 4, 5], startMinute: DEFAULT_WORKING_HOURS.startMinute, endMinute: DEFAULT_WORKING_HOURS.endMinute },
  agendaDays: 14,
  timeZone: null,
  defaultDurationMinutes: 30,
  calendarVisibility: {},
}) as CalendarPreferences;

function weekdays(value: unknown, fallback: WeekdayIndex[]): WeekdayIndex[] {
  if (!Array.isArray(value) || value.length > 7 || !value.every(isWeekdayIndex)) return [...fallback];
  return [...new Set(value as WeekdayIndex[])].sort((a, b) => a - b);
}

function visibility(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([id, shown]) => id.length > 0 && id.length <= MAX_CALENDAR_ID_LENGTH && typeof shown === "boolean");
  for (const [id, shown] of entries.slice(-MAX_VISIBILITY_ENTRIES)) result[id] = shown as boolean;
  return result;
}

/** Reads stored preferences field by field; anything malformed falls back to the default. */
export function parsePreferences(raw: unknown): CalendarPreferences {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const defaults = DEFAULT_PREFERENCES;
  const duration = source.defaultDurationMinutes;
  const agendaDays = source.agendaDays;
  const workingHours = isValidWorkingHours(source.workingHours)
    ? { ...source.workingHours, days: weekdays(source.workingHours.days, defaults.workingHours.days as WeekdayIndex[]) }
    : { ...defaults.workingHours, days: [...defaults.workingHours.days] };
  return {
    version: 1,
    view: isCalendarView(source.view) ? source.view : defaults.view,
    weekStart: isWeekdayIndex(source.weekStart) ? source.weekStart : defaults.weekStart,
    workDays: weekdays(source.workDays, defaults.workDays),
    workingHours,
    agendaDays: typeof agendaDays === "number" && Number.isInteger(agendaDays) && agendaDays >= 1 && agendaDays <= MAX_EVENT_RANGE_DAYS
      ? agendaDays
      : defaults.agendaDays,
    timeZone: isValidTimeZone(source.timeZone) ? source.timeZone : null,
    defaultDurationMinutes: typeof duration === "number" && Number.isInteger(duration) && duration >= 5 && duration <= 1440
      ? duration
      : defaults.defaultDurationMinutes,
    calendarVisibility: visibility(source.calendarVisibility),
  };
}

/** Records a show or hide choice, keeping at most `MAX_VISIBILITY_ENTRIES` (the newest choices). */
export function withCalendarVisibility(preferences: CalendarPreferences, calendarId: string, visible: boolean): CalendarPreferences {
  const rest = Object.entries(preferences.calendarVisibility).filter(([id]) => id !== calendarId);
  const kept = rest.slice(Math.max(0, rest.length - (MAX_VISIBILITY_ENTRIES - 1)));
  return { ...preferences, calendarVisibility: { ...Object.fromEntries(kept), [calendarId]: visible } };
}

export interface CalendarPersistence {
  loadPreferences(): Promise<unknown>;
  savePreferences(preferences: CalendarPreferences): Promise<void>;
  /** Raw proposal rows written by the agent; validated with `parseProposals`. */
  loadProposals(): Promise<unknown>;
  deleteProposal(rowId: string): Promise<void>;
}

/** Keeps everything in memory for this window only. */
export function createMemoryPersistence(initial: { preferences?: unknown; proposals?: unknown[] } = {}): CalendarPersistence & {
  readonly saved: CalendarPreferences | null;
} {
  let preferences: unknown = initial.preferences ?? null;
  let saved: CalendarPreferences | null = null;
  let proposals: unknown[] = [...(initial.proposals ?? [])].slice(0, MAX_PROPOSALS * 4);
  return {
    get saved() {
      return saved;
    },
    async loadPreferences() {
      return preferences;
    },
    async savePreferences(next) {
      saved = structuredClone(next);
      preferences = saved;
    },
    async loadProposals() {
      return proposals;
    },
    async deleteProposal(rowId) {
      proposals = proposals.filter((row) => !(row && typeof row === "object" && (row as { id?: unknown }).id === rowId));
    },
  };
}

/** The subset of `window.MatrixOS.db` the persistence needs. */
export interface PreferencesDb {
  find(table: string, options?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number }): Promise<Record<string, unknown>[]>;
  /** INSERT ... ON CONFLICT DO NOTHING: a row whose unique `slot` is taken is skipped. */
  bulkInsert(table: string, rows: Record<string, unknown>[]): Promise<{ ids: string[] }>;
  /** Updates the row only while its stored `payload` still equals `expectedPayload`. */
  compareAndSwap(table: string, id: string, expectedPayload: Record<string, unknown>, data: Record<string, unknown>): Promise<{ ok: boolean }>;
  delete(table: string, id: string): Promise<unknown>;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type PlainField = Exclude<keyof CalendarPreferences, "version" | "calendarVisibility">;
const PLAIN_FIELDS: readonly PlainField[] = ["view", "weekStart", "workDays", "workingHours", "agendaDays", "timeZone", "defaultDurationMinutes"];

/**
 * `stored` with the choices `next` made since `base` put on top: a field
 * another window changed meanwhile keeps its stored value unless this window
 * changed it too. Visibility is merged per calendar.
 */
export function mergePreferences(stored: CalendarPreferences, base: CalendarPreferences, next: CalendarPreferences): CalendarPreferences {
  let merged: CalendarPreferences = { ...stored };
  const fields = merged as unknown as Record<PlainField, unknown>;
  for (const field of PLAIN_FIELDS) if (!same(base[field], next[field])) fields[field] = next[field];
  for (const [calendarId, shown] of Object.entries(next.calendarVisibility)) {
    if (base.calendarVisibility[calendarId] !== shown) merged = withCalendarVisibility(merged, calendarId, shown);
  }
  return merged;
}

interface StoredPreferences {
  id: string;
  /** The payload exactly as read, for the compare-and-swap. */
  payload: Record<string, unknown>;
}

/**
 * Preferences live in one `calendar_preferences` row whose unique `slot` is
 * `preferences`; agent proposals are rows of `calendar_proposals`.
 *
 * Every save is one database statement: the row is created with `bulkInsert`
 * (ON CONFLICT DO NOTHING on the unique slot) and changed with
 * `compareAndSwap` against the payload that was read. When another window
 * wrote in between, this window's changes are put onto the newer payload and
 * tried again, so neither window's choices are lost.
 */
export function createDbPersistence(db: PreferencesDb): CalendarPersistence {
  /** What this window last read or saved: its next changes are measured against it. */
  let base: CalendarPreferences = DEFAULT_PREFERENCES;

  async function read(): Promise<StoredPreferences | null> {
    const [row] = await db.find(PREFERENCES_TABLE, { where: { slot: PREFERENCES_SLOT }, limit: 1 });
    if (row === undefined) return null;
    const payload = parseJsonValue(row.payload);
    if (typeof row.id !== "string" || !isRecord(payload)) throw new Error("the calendar preferences row cannot be read");
    return { id: row.id, payload };
  }

  return {
    async loadPreferences() {
      const stored = await read();
      base = parsePreferences(stored?.payload ?? null);
      return stored?.payload ?? null;
    },
    async savePreferences(preferences) {
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const stored = await read();
        const current = parsePreferences(stored?.payload ?? null);
        const merged = mergePreferences(current, base, preferences);
        if (stored !== null && same(merged, current)) {
          base = preferences;
          return;
        }
        const payload = { ...merged } as unknown as Record<string, unknown>;
        const written = stored === null
          ? (await db.bulkInsert(PREFERENCES_TABLE, [{ slot: PREFERENCES_SLOT, payload }])).ids.length > 0
          : (await db.compareAndSwap(PREFERENCES_TABLE, stored.id, stored.payload, { payload })).ok;
        if (written) {
          base = preferences;
          return;
        }
      }
      throw new Error("the calendar preferences kept changing in another window");
    },
    async loadProposals() {
      const rows = await db.find(PROPOSALS_TABLE, { orderBy: { created_at: "desc" }, limit: MAX_PROPOSALS });
      return rows.map((row) => ({ ...row, attendees: parseJsonValue(row.attendees), calendarId: row.calendar_id }));
    },
    async deleteProposal(id) {
      await db.delete(PROPOSALS_TABLE, id);
    },
  };
}
