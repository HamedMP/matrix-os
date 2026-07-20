import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTE_COLOR,
  MAX_NOTE_TEXT,
  MAX_NOTES,
  NOTES_KEY,
  NOTE_COLORS,
  colorFor,
  createNote,
  formatNoteTime,
  isNoteColorId,
  noteSnippet,
  parseStickyNotes,
  sortNotesByRecency,
} from "../../home/apps/win-sticky-notes/src/sticky-notes-model";

describe("NOTE_COLORS", () => {
  it("ships a yellow default plus pastel variants", () => {
    expect(DEFAULT_NOTE_COLOR).toBe("yellow");
    expect(NOTE_COLORS.map((c) => c.id)).toContain("yellow");
    expect(NOTE_COLORS.length).toBeGreaterThanOrEqual(5);
    for (const color of NOTE_COLORS) {
      expect(color.paper).toMatch(/^#[0-9a-f]{6}$/i);
      expect(color.chrome).toMatch(/^#[0-9a-f]{6}$/i);
      expect(color.label.length).toBeGreaterThan(0);
    }
  });

  it("colorFor falls back to the default for unknown ids", () => {
    expect(colorFor("blue").id).toBe("blue");
    expect(colorFor("nope" as never).id).toBe(DEFAULT_NOTE_COLOR);
  });

  it("isNoteColorId validates ids", () => {
    expect(isNoteColorId("purple")).toBe(true);
    expect(isNoteColorId("orange")).toBe(false);
    expect(isNoteColorId(42)).toBe(false);
  });
});

describe("parseStickyNotes", () => {
  it("returns [] for non-arrays", () => {
    expect(parseStickyNotes(null)).toEqual([]);
    expect(parseStickyNotes(undefined)).toEqual([]);
    expect(parseStickyNotes("notes")).toEqual([]);
    expect(parseStickyNotes({})).toEqual([]);
  });

  it("restores notes from string-backed bridge storage", () => {
    expect(parseStickyNotes(JSON.stringify([
      { id: "saved", text: "keep me", color: "blue", createdAt: 10, updatedAt: 20 },
    ]))).toEqual([
      { id: "saved", text: "keep me", color: "blue", createdAt: 10, updatedAt: 20 },
    ]);
  });

  it("coerces valid records and drops malformed ones", () => {
    const parsed = parseStickyNotes([
      { id: "a", text: "hello", color: "green", createdAt: 10, updatedAt: 20 },
      { id: "", text: "no id" },
      null,
      "junk",
      { id: "b" },
    ]);
    expect(parsed).toEqual([
      { id: "a", text: "hello", color: "green", createdAt: 10, updatedAt: 20 },
      { id: "b", text: "", color: DEFAULT_NOTE_COLOR, createdAt: 0, updatedAt: 0 },
    ]);
  });

  it("defaults an unknown color to the default and caps text length", () => {
    const parsed = parseStickyNotes([
      { id: "a", text: "x".repeat(MAX_NOTE_TEXT + 500), color: "orange", updatedAt: 1 },
    ]);
    expect(parsed[0].color).toBe(DEFAULT_NOTE_COLOR);
    expect(parsed[0].text).toHaveLength(MAX_NOTE_TEXT);
  });

  it("caps the number of notes and repairs bad timestamps", () => {
    const many = Array.from({ length: MAX_NOTES + 25 }, (_, i) => ({ id: `n-${i}`, updatedAt: -5 }));
    const parsed = parseStickyNotes(many);
    expect(parsed).toHaveLength(MAX_NOTES);
    expect(parsed.every((n) => n.updatedAt >= 0)).toBe(true);
  });

  it("keeps a maximum notes document below the bridge request limit", () => {
    const notes = Array.from({ length: MAX_NOTES }, (_, index) => ({
      id: `note-${index}`,
      text: "\\".repeat(MAX_NOTE_TEXT),
      color: "yellow",
      createdAt: index,
      updatedAt: index,
    }));
    const storedValue = JSON.stringify(notes);
    const requestBody = JSON.stringify({
      action: "write",
      app: "win-sticky-notes",
      key: NOTES_KEY,
      value: storedValue,
    });

    expect(new TextEncoder().encode(requestBody).byteLength).toBeLessThan(1_000_000);
  });
});

describe("createNote", () => {
  it("creates an empty yellow note stamped with now", () => {
    expect(createNote("id-1", 123)).toEqual({
      id: "id-1",
      text: "",
      color: "yellow",
      createdAt: 123,
      updatedAt: 123,
    });
  });
});

describe("noteSnippet", () => {
  it("uses the first non-empty line", () => {
    expect(noteSnippet("\n\n  Hello world \nsecond line")).toBe("Hello world");
  });

  it("falls back to a placeholder for empty text", () => {
    expect(noteSnippet("")).toBe("New note");
    expect(noteSnippet("   \n  ")).toBe("New note");
  });

  it("truncates very long lines", () => {
    const snippet = noteSnippet("y".repeat(200));
    expect(snippet.length).toBeLessThanOrEqual(81);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("sortNotesByRecency", () => {
  it("orders by updatedAt descending without mutating the input", () => {
    const input = [
      { id: "old", text: "", color: "yellow" as const, createdAt: 0, updatedAt: 10 },
      { id: "new", text: "", color: "yellow" as const, createdAt: 0, updatedAt: 30 },
      { id: "mid", text: "", color: "yellow" as const, createdAt: 0, updatedAt: 20 },
    ];
    const sorted = sortNotesByRecency(input);
    expect(sorted.map((n) => n.id)).toEqual(["new", "mid", "old"]);
    expect(input[0].id).toBe("old");
  });
});

describe("formatNoteTime", () => {
  const now = new Date("2026-06-15T12:00:00").getTime();

  it("labels recent edits", () => {
    expect(formatNoteTime(now - 10_000, now)).toBe("Just now");
    expect(formatNoteTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatNoteTime(now - 3 * 3_600_000, now)).toBe("3 hr ago");
  });

  it("labels yesterday and older dates", () => {
    expect(formatNoteTime(new Date("2026-06-14T09:00:00").getTime(), now)).toBe("Yesterday");
    expect(formatNoteTime(new Date("2026-03-04T09:00:00").getTime(), now)).toBe("Mar 4");
    expect(formatNoteTime(new Date("2025-11-02T09:00:00").getTime(), now)).toBe("Nov 2, 2025");
  });

  it("labels the previous calendar day across a daylight-saving transition", () => {
    const originalTimeZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const afterSpringForward = new Date(2026, 2, 9, 12).getTime();
      const previousCalendarDay = new Date(2026, 2, 8, 9).getTime();

      expect(formatNoteTime(previousCalendarDay, afterSpringForward)).toBe("Yesterday");
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });
});
