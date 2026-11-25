import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayKeyAt,
  daySlice,
  instantAtWall,
  resolveTimeZone,
  startOfWeek,
  wallMinutesAt,
  weekdayOf,
} from "../../../../home/apps/calendar/src/model/dates";
import { shiftAnchor, viewRange, type RangeOptions } from "../../../../home/apps/calendar/src/model/ranges";

const NY = "America/New_York";
const BERLIN = "Europe/Berlin";
const ms = (iso: string) => Date.parse(iso);

function options(overrides: Partial<RangeOptions> = {}): RangeOptions {
  return { timeZone: NY, weekStart: 1, workDays: [1, 2, 3, 4, 5], agendaDays: 14, ...overrides };
}

describe("civil date arithmetic", () => {
  it("adds days across month and year ends without touching time zones", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("clamps the day when adding months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
  });

  it("finds the start of the week for any configured first weekday", () => {
    // 2026-11-25 is a Wednesday.
    expect(weekdayOf("2026-11-25")).toBe(3);
    expect(startOfWeek("2026-11-25", 1)).toBe("2026-11-23");
    expect(startOfWeek("2026-11-25", 0)).toBe("2026-11-22");
    expect(startOfWeek("2026-11-25", 6)).toBe("2026-11-21");
    expect(startOfWeek("2026-11-23", 1)).toBe("2026-11-23");
  });

  it("rejects malformed day keys", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("26-1-1", 1)).toThrow(RangeError);
  });
});

describe("zone-aware day slicing", () => {
  it("gives the spring-forward day 23 hours and the fall-back day 25 hours", () => {
    const spring = daySlice("2026-03-08", NY);
    expect(spring.startMs).toBe(ms("2026-03-08T05:00:00Z"));
    expect(spring.endMs).toBe(ms("2026-03-09T04:00:00Z"));
    expect(spring.lengthMinutes).toBe(23 * 60);

    const fall = daySlice("2026-11-01", NY);
    expect(fall.startMs).toBe(ms("2026-11-01T04:00:00Z"));
    expect(fall.endMs).toBe(ms("2026-11-02T05:00:00Z"));
    expect(fall.lengthMinutes).toBe(25 * 60);

    expect(daySlice("2026-11-02", NY).lengthMinutes).toBe(24 * 60);
  });

  it("reads the calendar day and wall clock of a moment in the viewer's zone", () => {
    const moment = ms("2026-11-23T03:30:00Z");
    expect(dayKeyAt(moment, NY)).toBe("2026-11-22");
    expect(dayKeyAt(moment, BERLIN)).toBe("2026-11-23");
    expect(wallMinutesAt(moment, NY)).toBe(22 * 60 + 30);
    expect(wallMinutesAt(moment, BERLIN)).toBe(4 * 60 + 30);
  });

  it("turns a wall-clock minute of a day into an instant with that day's offset", () => {
    expect(instantAtWall("2026-03-07", 9 * 60, NY)).toBe("2026-03-07T09:00:00-05:00");
    expect(instantAtWall("2026-03-09", 9 * 60, NY)).toBe("2026-03-09T09:00:00-04:00");
    expect(instantAtWall("2026-03-08", 24 * 60, NY)).toBe("2026-03-09T00:00:00-04:00");
  });

  it("falls back to UTC for unknown zones", () => {
    expect(resolveTimeZone("Not/AZone")).toBe("UTC");
    expect(resolveTimeZone(BERLIN)).toBe(BERLIN);
  });
});

describe("view ranges", () => {
  it("covers one zoned day for the day view, even on a 23 hour day", () => {
    const range = viewRange("day", "2026-03-08", options());
    expect(range.days).toEqual(["2026-03-08"]);
    expect(range.start).toBe("2026-03-08T00:00:00-05:00");
    expect(range.end).toBe("2026-03-09T00:00:00-04:00");
    expect(Date.parse(range.end) - Date.parse(range.start)).toBe(23 * 3_600_000);
  });

  it("honours the week start in the week view and crosses a DST change", () => {
    const monday = viewRange("week", "2026-11-04", options({ weekStart: 1 }));
    expect(monday.days[0]).toBe("2026-11-02");
    expect(monday.days).toHaveLength(7);
    expect(monday.endKey).toBe("2026-11-09");

    const sunday = viewRange("week", "2026-11-04", options({ weekStart: 0 }));
    expect(sunday.days[0]).toBe("2026-11-01");
    expect(sunday.start).toBe("2026-11-01T00:00:00-04:00");
    expect(sunday.end).toBe("2026-11-08T00:00:00-05:00");
    expect(Date.parse(sunday.end) - Date.parse(sunday.start)).toBe((7 * 24 + 1) * 3_600_000);
  });

  it("keeps only working days in the work week view", () => {
    const range = viewRange("workWeek", "2026-11-26", options({ weekStart: 0, workDays: [1, 2, 3, 4, 5] }));
    expect(range.days).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);
    expect(range.start).toBe("2026-11-23T00:00:00-05:00");
    expect(range.end).toBe("2026-11-28T00:00:00-05:00");
  });

  it("builds whole weeks around the month and expresses them in the viewer's zone", () => {
    const range = viewRange("month", "2026-11-17", options({ weekStart: 1, timeZone: BERLIN }));
    expect(range.monthKey).toBe("2026-11");
    expect(range.days[0]).toBe("2026-10-26");
    expect(range.days.length % 7).toBe(0);
    expect(range.days.at(-1)).toBe("2026-12-06");
    expect(range.start).toBe("2026-10-26T00:00:00+01:00");

    const february = viewRange("month", "2027-02-10", options({ weekStart: 1 }));
    expect(february.days).toHaveLength(28);
  });

  it("starts the agenda on the anchor and caps its length at the provider range limit", () => {
    const range = viewRange("agenda", "2026-11-22", options({ agendaDays: 500 }));
    expect(range.days[0]).toBe("2026-11-22");
    expect(range.days).toHaveLength(62);
  });

  it("gives the same range for the same day in different zones but different instants", () => {
    const ny = viewRange("day", "2026-11-23", options({ timeZone: NY }));
    const berlin = viewRange("day", "2026-11-23", options({ timeZone: BERLIN }));
    expect(ny.days).toEqual(berlin.days);
    expect(Date.parse(ny.start) - Date.parse(berlin.start)).toBe(6 * 3_600_000);
  });

  it("moves the anchor by one view length", () => {
    expect(shiftAnchor("day", "2026-11-30", 1, options())).toBe("2026-12-01");
    expect(shiftAnchor("week", "2026-11-30", -1, options())).toBe("2026-11-23");
    expect(shiftAnchor("workWeek", "2026-11-30", 1, options())).toBe("2026-12-07");
    expect(shiftAnchor("month", "2026-01-31", 1, options())).toBe("2026-02-28");
    expect(shiftAnchor("agenda", "2026-11-22", 1, options({ agendaDays: 7 }))).toBe("2026-11-29");
  });
});
