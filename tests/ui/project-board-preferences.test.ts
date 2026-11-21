import { describe, expect, it } from "vitest";
import { EMPTY_BOARD_FILTER } from "../../packages/ui/src/project-board/board-model";
import {
  DEFAULT_BOARD_PREFERENCES, boardPreferencesKey, readBoardPreferences, writeBoardPreferences, type PreferenceStorage,
} from "../../packages/ui/src/project-board/board-preferences";

function memoryStorage(): PreferenceStorage & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  return { values, getItem: (key) => values[key] ?? null, setItem: (key, value) => { values[key] = value; } };
}

describe("board preferences", () => {
  it("remembers layout and filters per surface and project", () => {
    const storage = memoryStorage();
    const web = boardPreferencesKey("web", "proj_a");
    const saved = { layout: "list" as const, filter: { ...EMPTY_BOARD_FILTER, labels: ["bug"], assignees: ["user:ana" as const], showCanceled: true } };
    writeBoardPreferences(storage, web, saved);
    expect(readBoardPreferences(storage, web)).toEqual(saved);
    expect(readBoardPreferences(storage, boardPreferencesKey("web", "proj_b"))).toEqual(DEFAULT_BOARD_PREFERENCES);
    expect(readBoardPreferences(storage, boardPreferencesKey("electron", "proj_a"))).toEqual(DEFAULT_BOARD_PREFERENCES);
  });

  it("falls back to defaults for corrupt, invalid or unreadable storage", () => {
    const storage = memoryStorage();
    storage.values.bad = "{not json";
    storage.values.wrong = JSON.stringify({ layout: "grid", filter: EMPTY_BOARD_FILTER });
    expect(readBoardPreferences(storage, "bad")).toEqual(DEFAULT_BOARD_PREFERENCES);
    expect(readBoardPreferences(storage, "wrong")).toEqual(DEFAULT_BOARD_PREFERENCES);
    expect(readBoardPreferences(undefined, "x")).toEqual(DEFAULT_BOARD_PREFERENCES);
    const throwing: PreferenceStorage = { getItem: () => { throw new DOMException("denied", "SecurityError"); }, setItem: () => { throw new DOMException("full", "QuotaExceededError"); } };
    expect(readBoardPreferences(throwing, "x")).toEqual(DEFAULT_BOARD_PREFERENCES);
    expect(() => writeBoardPreferences(throwing, "x", DEFAULT_BOARD_PREFERENCES)).not.toThrow();
  });
});

describe("board preferences with long labels", () => {
  it("keeps a saved label filter up to the contract's label length", () => {
    const values: Record<string, string> = {};
    const storage = { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } };
    const label = "l".repeat(48);
    const saved = { layout: "list" as const, filter: { ...EMPTY_BOARD_FILTER, labels: [label] } };
    writeBoardPreferences(storage, "k", saved);
    expect(readBoardPreferences(storage, "k")).toEqual(saved);
  });
});
