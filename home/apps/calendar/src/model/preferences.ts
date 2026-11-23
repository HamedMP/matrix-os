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
export const PREFERENCES_ROW_NAME = "preferences";
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
  insert(table: string, data: Record<string, unknown>): Promise<{ id: string }>;
  update(table: string, id: string, data: Record<string, unknown>): Promise<unknown>;
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

/**
 * Preferences live in one `calendar_preferences` row named `preferences`;
 * agent proposals are rows of `calendar_proposals`.
 */
export function createDbPersistence(db: PreferencesDb): CalendarPersistence {
  let rowId: string | null = null;
  const findRow = async () => {
    const rows = await db.find(PREFERENCES_TABLE, { where: { name: PREFERENCES_ROW_NAME }, orderBy: { updated_at: "desc" }, limit: 1 });
    const row = rows[0];
    rowId = row && typeof row.id === "string" ? row.id : null;
    return row ?? null;
  };
  return {
    async loadPreferences() {
      const row = await findRow();
      return row ? parseJsonValue(row.value) : null;
    },
    async savePreferences(preferences) {
      if (rowId === null) await findRow();
      if (rowId !== null) {
        await db.update(PREFERENCES_TABLE, rowId, { name: PREFERENCES_ROW_NAME, value: preferences });
        return;
      }
      rowId = (await db.insert(PREFERENCES_TABLE, { name: PREFERENCES_ROW_NAME, value: preferences })).id;
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
