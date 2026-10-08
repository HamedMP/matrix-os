import { formatRelativeTime, formatUpdated } from "../lib/relative-time";

// Thursday 8 October 2026, 15:30 local time.
const now = new Date(2026, 9, 8, 15, 30, 0);
const ago = (ms: number) => new Date(now.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("formatRelativeTime", () => {
  it("says now within the first minute, and for a time slightly in the future", () => {
    expect(formatRelativeTime(ago(20_000), now)).toBe("now");
    expect(formatRelativeTime(new Date(now.getTime() + 5_000), now)).toBe("now");
  });

  it("counts minutes under an hour and hours under a day", () => {
    expect(formatRelativeTime(ago(2 * MINUTE), now)).toBe("2m");
    expect(formatRelativeTime(ago(59 * MINUTE), now)).toBe("59m");
    expect(formatRelativeTime(ago(HOUR), now)).toBe("1h");
    expect(formatRelativeTime(ago(14 * HOUR), now)).toBe("14h");
  });

  it("says Yesterday for the previous calendar day once a day has passed", () => {
    expect(formatRelativeTime(new Date(2026, 9, 7, 9, 0, 0), now)).toBe("Yesterday");
    // 23 hours ago is still counted in hours, although it is yesterday's date.
    expect(formatRelativeTime(ago(23 * HOUR), now)).toBe("23h");
  });

  it("names the weekday within the last week", () => {
    expect(formatRelativeTime(new Date(2026, 9, 5, 12, 0, 0), now)).toBe("Mon");
    expect(formatRelativeTime(new Date(2026, 9, 2, 12, 0, 0), now)).toBe("Fri");
  });

  it("gives the month and day beyond a week, with the year when it differs", () => {
    expect(formatRelativeTime(new Date(2026, 8, 30, 12, 0, 0), now)).toBe("Sep 30");
    expect(formatRelativeTime(new Date(2026, 8, 28, 12, 0, 0), now)).toBe("Sep 28");
    expect(formatRelativeTime(new Date(2025, 11, 3, 12, 0, 0), now)).toBe("Dec 3, 2025");
  });

  it("accepts ISO strings and returns an empty string for a missing or unreadable time", () => {
    expect(formatRelativeTime(ago(5 * MINUTE).toISOString(), now)).toBe("5m");
    expect(formatRelativeTime(undefined, now)).toBe("");
    expect(formatRelativeTime(null, now)).toBe("");
    expect(formatRelativeTime("not a date", now)).toBe("");
  });
});

describe("formatUpdated", () => {
  it("describes when something last changed", () => {
    expect(formatUpdated(ago(3 * HOUR), now)).toBe("Updated today");
    expect(formatUpdated(new Date(2026, 9, 7, 23, 0, 0), now)).toBe("Updated yesterday");
    expect(formatUpdated(new Date(2026, 9, 5, 12, 0, 0), now)).toBe("Updated Mon");
    expect(formatUpdated(new Date(2026, 8, 30, 12, 0, 0), now)).toBe("Updated Sep 30");
  });

  it("returns an empty string for a missing time", () => {
    expect(formatUpdated(undefined, now)).toBe("");
  });
});
