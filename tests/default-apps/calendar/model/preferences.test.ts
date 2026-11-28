import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  MAX_VISIBILITY_ENTRIES,
  PREFERENCES_TABLE,
  PROPOSALS_TABLE,
  createDbPersistence,
  parsePreferences,
  withCalendarVisibility,
  type PreferencesDb,
} from "../../../../home/apps/calendar/src/model/preferences";
import { parseProposals } from "../../../../home/apps/calendar/src/model/proposals";

/**
 * A table store with the bridge's semantics: rows get an id; find filters by
 * equality; bulkInsert skips a row whose `slot` is taken (ON CONFLICT DO
 * NOTHING on the unique index); compareAndSwap writes only while `payload`
 * still equals the expected one.
 */
function memoryDb(): PreferencesDb & {
  tables: Record<string, Record<string, unknown>[]>;
  insert(table: string, data: Record<string, unknown>): Promise<{ id: string }>;
} {
  const tables: Record<string, Record<string, unknown>[]> = {};
  let counter = 0;
  const add = (table: string, data: Record<string, unknown>) => {
    counter += 1;
    const id = `row-${counter}`;
    (tables[table] ??= []).push({ ...structuredClone(data), id });
    return id;
  };
  return {
    tables,
    async find(table, options = {}) {
      const rows = (tables[table] ?? []).filter((row) => Object.entries(options.where ?? {}).every(([key, value]) => row[key] === value));
      return rows.slice(0, options.limit ?? rows.length).map((row) => structuredClone(row));
    },
    async insert(table, data) {
      return { id: add(table, data) };
    },
    async bulkInsert(table, rows) {
      const ids: string[] = [];
      for (const row of rows) {
        if ((tables[table] ?? []).some((other) => other.slot !== undefined && other.slot === row.slot)) continue;
        ids.push(add(table, row));
      }
      return { ids };
    },
    async compareAndSwap(table, id, expectedPayload, data) {
      const row = (tables[table] ?? []).find((item) => item.id === id);
      if (!row || JSON.stringify(row.payload) !== JSON.stringify(expectedPayload)) return { ok: false };
      Object.assign(row, structuredClone(data));
      return { ok: true };
    },
    async delete(table, id) {
      tables[table] = (tables[table] ?? []).filter((row) => row.id !== id);
      return { ok: true };
    },
  };
}

describe("calendar preferences", () => {
  it("falls back field by field for malformed values", () => {
    const parsed = parsePreferences({
      view: "year",
      weekStart: 0,
      workDays: [5, 1, 1, 9],
      workingHours: { days: [1], startMinute: 600, endMinute: 500 },
      timeZone: "Mars/Olympus",
      defaultDurationMinutes: 45,
      calendarVisibility: { a: false, b: "yes", "": true },
    });
    expect(parsed).toMatchObject({
      view: DEFAULT_PREFERENCES.view,
      weekStart: 0,
      workDays: DEFAULT_PREFERENCES.workDays,
      workingHours: DEFAULT_PREFERENCES.workingHours,
      timeZone: null,
      defaultDurationMinutes: 45,
      calendarVisibility: { a: false },
    });
    expect(parsePreferences("garbage")).toEqual(DEFAULT_PREFERENCES);
  });

  it("caps remembered visibility choices, dropping the oldest", () => {
    let preferences = DEFAULT_PREFERENCES;
    for (let index = 0; index < MAX_VISIBILITY_ENTRIES + 5; index += 1) preferences = withCalendarVisibility(preferences, `cal-${index}`, false);
    const ids = Object.keys(preferences.calendarVisibility);
    expect(ids).toHaveLength(MAX_VISIBILITY_ENTRIES);
    expect(ids[0]).toBe("cal-5");
    expect(ids.at(-1)).toBe(`cal-${MAX_VISIBILITY_ENTRIES + 4}`);
  });

  it("keeps preferences in one database row and reads agent proposal rows", async () => {
    const db = memoryDb();
    const persistence = createDbPersistence(db);
    expect(await persistence.loadPreferences()).toBeNull();
    await persistence.savePreferences(withCalendarVisibility(DEFAULT_PREFERENCES, "work", false));
    await persistence.savePreferences(withCalendarVisibility(DEFAULT_PREFERENCES, "work", true));
    expect(db.tables[PREFERENCES_TABLE]).toHaveLength(1);
    expect(db.tables[PREFERENCES_TABLE][0].slot).toBe("preferences");
    const reopened = createDbPersistence(db);
    expect(parsePreferences(await reopened.loadPreferences()).calendarVisibility).toEqual({ work: true });

    await db.insert(PROPOSALS_TABLE, {
      start_at: "2026-11-24T15:00:00Z", end_at: "2026-11-24T15:30:00Z", title: "Sync",
      attendees: JSON.stringify([{ address: "ana@example.com" }]), calendar_id: "work", time_zone: "Europe/Berlin",
    });
    const [proposal] = parseProposals(await reopened.loadProposals(), "agent");
    expect(proposal).toMatchObject({ id: "agent:row-2", rowId: "row-2", calendarId: "work", timeZone: "Europe/Berlin", attendees: [{ address: "ana@example.com" }] });
    await reopened.deleteProposal("row-2");
    expect(db.tables[PROPOSALS_TABLE]).toEqual([]);
  });

  // Outcome: choices made in two Calendar windows both survive a reopen.
  // Fault: both windows find no row and insert one each (check-then-insert), or one window's
  // whole-snapshot save overwrites the other's change, so a saved choice appears to revert.
  it("keeps one row and both windows' choices when two windows save their first change together", async () => {
    const db = memoryDb();
    const first = createDbPersistence(db);
    const second = createDbPersistence(db);
    const [loadedA, loadedB] = await Promise.all([first.loadPreferences(), second.loadPreferences()]);
    const a = parsePreferences(loadedA);
    const b = parsePreferences(loadedB);
    await Promise.all([
      first.savePreferences({ ...a, view: "agenda" }),
      second.savePreferences(withCalendarVisibility(b, "work", false)),
    ]);
    expect(db.tables[PREFERENCES_TABLE]).toHaveLength(1);
    // The second window changes something else; the first window's view stays.
    await second.savePreferences({ ...withCalendarVisibility(b, "work", false), weekStart: 0 });

    const reopened = parsePreferences(await createDbPersistence(db).loadPreferences());
    expect(reopened).toMatchObject({ view: "agenda", weekStart: 0, calendarVisibility: { work: false } });
  });
});
