import { describe, expect, it } from "vitest";
import {
  endOfDayInstant,
  parseDateRef,
  parseWallTime,
  parseWindowRef,
  resolveDateRef,
  resolveWindow,
  type DateContext,
} from "../../../../home/apps/calendar/src/agent/relative-dates";

// Monday 23 November 2026, 10:00 in New York.
const NOW = Date.parse("2026-11-23T15:00:00Z");
const NY: DateContext = { now: NOW, timeZone: "America/New_York", weekStart: 1 };

describe("calendar agent: resolving days in code", () => {
  it("resolves today, tomorrow, yesterday and offsets in the owner's zone", () => {
    expect(resolveDateRef({ type: "today" }, NY)).toBe("2026-11-23");
    expect(resolveDateRef({ type: "tomorrow" }, NY)).toBe("2026-11-24");
    expect(resolveDateRef({ type: "yesterday" }, NY)).toBe("2026-11-22");
    expect(resolveDateRef({ type: "offset", days: 10 }, NY)).toBe("2026-12-03");
  });

  it("uses the owner's zone, not UTC, to decide which day today is", () => {
    // 03:30 UTC on the 24th is still 22:30 on Monday the 23rd in New York.
    const lateEvening = { ...NY, now: Date.parse("2026-11-24T03:30:00Z") };
    expect(resolveDateRef({ type: "today" }, lateEvening)).toBe("2026-11-23");
    expect(resolveDateRef({ type: "tomorrow" }, lateEvening)).toBe("2026-11-24");
    expect(resolveDateRef({ type: "today" }, { ...lateEvening, timeZone: "Asia/Tokyo" })).toBe("2026-11-24");
  });

  it("reads a bare weekday as the coming one and 'next' as the one in next week", () => {
    expect(resolveDateRef({ type: "weekday", day: "thursday" }, NY)).toBe("2026-11-26");
    expect(resolveDateRef({ type: "weekday", day: "monday" }, NY)).toBe("2026-11-23");
    expect(resolveDateRef({ type: "weekday", day: "sunday" }, NY)).toBe("2026-11-29");
    expect(resolveDateRef({ type: "weekday", day: "thursday", which: "next" }, NY)).toBe("2026-12-03");
    // With Sunday-start weeks, "next Sunday" is the start of next week.
    expect(resolveDateRef({ type: "weekday", day: "sunday", which: "next" }, { ...NY, weekStart: 0 })).toBe("2026-11-29");
  });

  it("finds the next such day of the month, skipping months without it", () => {
    expect(resolveDateRef({ type: "day_of_month", day: 30 }, NY)).toBe("2026-11-30");
    expect(resolveDateRef({ type: "day_of_month", day: 23 }, NY)).toBe("2026-11-23");
    expect(resolveDateRef({ type: "day_of_month", day: 15 }, NY)).toBe("2026-12-15");
    expect(resolveDateRef({ type: "day_of_month", day: 31 }, NY)).toBe("2026-12-31");
    expect(resolveDateRef({ type: "day_of_month", day: 3, month: 3 }, NY)).toBe("2027-03-03");
    expect(resolveDateRef({ type: "day_of_month", day: 29, month: 2 }, NY)).toBe("2028-02-29");
  });

  it("returns the end of a day for a series' last date", () => {
    expect(endOfDayInstant("2026-11-30", NY)).toBe("2026-11-30T23:59:59-05:00");
  });
});

describe("calendar agent: resolving windows", () => {
  it("starts 'this week' at now so nothing in the past is searched", () => {
    expect(resolveWindow({ type: "this_week" }, NY, { fromNow: true })).toEqual({
      start: "2026-11-23T10:00:00-05:00",
      end: "2026-11-30T00:00:00-05:00",
    });
    expect(resolveWindow({ type: "this_week" }, NY)).toEqual({
      start: "2026-11-23T00:00:00-05:00",
      end: "2026-11-30T00:00:00-05:00",
    });
  });

  it("resolves next week, a day, and a span of days", () => {
    expect(resolveWindow({ type: "next_week" }, NY)).toEqual({ start: "2026-11-30T00:00:00-05:00", end: "2026-12-07T00:00:00-05:00" });
    expect(resolveWindow({ type: "day", date: { type: "tomorrow" } }, NY)).toEqual({ start: "2026-11-24T00:00:00-05:00", end: "2026-11-25T00:00:00-05:00" });
    expect(resolveWindow({ type: "between", from: { type: "tomorrow" }, to: { type: "weekday", day: "wednesday" } }, NY))
      .toEqual({ start: "2026-11-24T00:00:00-05:00", end: "2026-11-26T00:00:00-05:00" });
    expect(resolveWindow({ type: "between", from: { type: "weekday", day: "friday" }, to: { type: "tomorrow" } }, NY)).toBeNull();
  });

  it("reads 'before Friday' as now until Friday starts, and next Friday when said on a Friday", () => {
    expect(resolveWindow({ type: "before", date: { type: "weekday", day: "friday" } }, NY)).toEqual({
      start: "2026-11-23T10:00:00-05:00",
      end: "2026-11-27T00:00:00-05:00",
    });
    const friday = { ...NY, now: Date.parse("2026-11-27T15:00:00Z") };
    expect(resolveWindow({ type: "before", date: { type: "weekday", day: "friday" } }, friday)?.end).toBe("2026-12-04T00:00:00-05:00");
  });

  it("keeps each day's own offset across a daylight-saving change", () => {
    const berlin: DateContext = { now: Date.parse("2027-03-23T09:00:00Z"), timeZone: "Europe/Berlin", weekStart: 1 };
    expect(resolveWindow({ type: "this_week" }, berlin)).toEqual({
      start: "2027-03-22T00:00:00+01:00",
      end: "2027-03-29T00:00:00+02:00",
    });
  });

  it("caps a window at 62 days", () => {
    const window = resolveWindow({ type: "between", from: { type: "today" }, to: { type: "offset", days: 200 } }, NY);
    expect(window?.end).toBe("2027-01-24T00:00:00-05:00");
  });
});

describe("calendar agent: validating references from the model", () => {
  it("accepts the documented shapes", () => {
    expect(parseDateRef({ type: "weekday", day: "Thu", which: "next" })).toEqual({ type: "weekday", day: "thursday", which: "next" });
    expect(parseDateRef({ type: "date", date: "2026-12-01" })).toEqual({ type: "date", date: "2026-12-01" });
    expect(parseWindowRef({ type: "before", date: { type: "weekday", day: "friday" } }))
      .toEqual({ type: "before", date: { type: "weekday", day: "friday" } });
    expect(parseWallTime("9:30")).toBe(570);
    expect(parseWallTime("23:59")).toBe(1439);
  });

  it("rejects anything malformed instead of guessing", () => {
    expect(parseDateRef({ type: "weekday", day: "funday" })).toBeNull();
    expect(parseDateRef({ type: "offset", days: 1.5 })).toBeNull();
    expect(parseDateRef({ type: "offset", days: 100_000 })).toBeNull();
    expect(parseDateRef({ type: "date", date: "2026-02-30" })).toBeNull();
    expect(parseDateRef({ type: "date", date: "2026-11-23T10:00:00Z" })).toBeNull();
    expect(parseDateRef({ type: "day_of_month", day: 32 })).toBeNull();
    expect(parseDateRef("tomorrow")).toBeNull();
    expect(parseWindowRef({ type: "between", from: { type: "today" } })).toBeNull();
    expect(parseWindowRef({ type: "next_days", days: 400 })).toBeNull();
    expect(parseWindowRef({ type: "forever" })).toBeNull();
    expect(parseWallTime("24:00")).toBeNull();
    expect(parseWallTime("3pm")).toBeNull();
  });
});
