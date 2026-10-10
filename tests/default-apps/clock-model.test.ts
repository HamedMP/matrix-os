import { describe, expect, it } from "vitest";
import {
  alarmMinuteKey,
  computeLaps,
  DEFAULT_WORLD_ZONES,
  formatClock,
  formatStopwatch,
  formatZoneTime,
  lapExtremes,
  parseDuration,
  parseRepeat,
  repeatLabel,
  searchZones,
  serializeRepeat,
  shouldAlarmFire,
  zoneCityLabel,
  zoneOffsetMinutes,
  zoneRegionLabel,
  type AlarmModel,
  type WeekDay,
} from "../../home/apps/clock/src/clock-model";

// A fixed instant: 2026-06-01T12:00:00Z (Monday).
const FIXED = new Date("2026-06-01T12:00:00.000Z");

describe("default world-clock zones", () => {
  it("seeds valid, unique IANA time zones", () => {
    expect(DEFAULT_WORLD_ZONES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(DEFAULT_WORLD_ZONES).size).toBe(DEFAULT_WORLD_ZONES.length);
    for (const tz of DEFAULT_WORLD_ZONES) {
      // Throws RangeError on an unknown IANA zone.
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz })).not.toThrow();
      expect(zoneCityLabel(tz).length).toBeGreaterThan(0);
    }
  });
});

describe("timezone helpers", () => {
  it("UTC offset is zero", () => {
    expect(zoneOffsetMinutes("UTC", FIXED)).toBe(0);
  });

  it("computes a positive offset for an ahead-of-UTC zone", () => {
    // Tokyo is UTC+9 year-round.
    expect(zoneOffsetMinutes("Asia/Tokyo", FIXED)).toBe(9 * 60);
  });

  it("computes a negative offset for a behind-UTC zone", () => {
    // New York in June is DST: UTC-4.
    expect(zoneOffsetMinutes("America/New_York", FIXED)).toBe(-4 * 60);
  });

  it("renders zone time with offset and day labels relative to local", () => {
    const tokyo = formatZoneTime("Asia/Tokyo", "UTC", FIXED);
    expect(tokyo.time).toBe("21:00");
    expect(tokyo.meridiem).toBe("PM");
    expect(tokyo.hour12).toBe("9");
    expect(tokyo.offsetLabel).toBe("+9h");
    expect(tokyo.dayLabel).toContain("Today");
  });

  it("marks a zone past midnight as Tomorrow", () => {
    // At 12:00 UTC, Tokyo is 21:00 same day; pick a late-UTC instant where Tokyo rolls over.
    const late = new Date("2026-06-01T20:00:00.000Z"); // Tokyo = 05:00 next day
    const tokyo = formatZoneTime("Asia/Tokyo", "UTC", late);
    expect(tokyo.dayLabel).toContain("Tomorrow");
  });

  it("computes analog hand angles", () => {
    // 21:00 -> hour hand at 9 o'clock = 270deg, minute at 0.
    const tokyo = formatZoneTime("Asia/Tokyo", "UTC", FIXED);
    expect(tokyo.hourAngle).toBe(270);
    expect(tokyo.minuteAngle).toBe(0);
  });

  it("labels city and region", () => {
    expect(zoneCityLabel("America/New_York")).toBe("New York");
    expect(zoneRegionLabel("America/New_York")).toBe("America");
  });

  it("searches the zone list case-insensitively, including spaces", () => {
    const zones = ["America/New_York", "Asia/Tokyo", "Europe/London"];
    expect(searchZones(zones, "tokyo")).toEqual(["Asia/Tokyo"]);
    expect(searchZones(zones, "new york")).toEqual(["America/New_York"]);
    expect(searchZones(zones, "")).toEqual(zones);
    expect(searchZones(zones, "xyz")).toEqual([]);
  });

  it("respects the search limit", () => {
    const zones = Array.from({ length: 100 }, (_, i) => `Z/${i}`);
    expect(searchZones(zones, "Z", 5)).toHaveLength(5);
  });
});

describe("alarm helpers", () => {
  it("parses and serializes repeat days, deduped and sorted", () => {
    expect(parseRepeat("3,1,1,5")).toEqual([1, 3, 5]);
    expect(parseRepeat("")).toEqual([]);
    expect(parseRepeat([6, 0, 0])).toEqual([0, 6]);
    expect(serializeRepeat([5, 1, 1] as WeekDay[])).toBe("1,5");
  });

  it("labels common repeat patterns", () => {
    expect(repeatLabel([])).toBe("Once");
    expect(repeatLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(repeatLabel([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(repeatLabel([0, 6])).toBe("Weekends");
    expect(repeatLabel([1, 3])).toBe("Mon Wed");
  });

  it("does not fire when disabled", () => {
    const alarm: AlarmModel = { id: "a", time: "07:00", label: "", repeat: [], enabled: false };
    const at = new Date("2026-06-01T07:00:00.000");
    expect(shouldAlarmFire(alarm, at)).toBe(false);
  });

  it("fires a one-shot throughout its matching minute", () => {
    const alarm: AlarmModel = { id: "a", time: "07:00", label: "", repeat: [], enabled: true };
    const at = new Date(2026, 5, 1, 7, 0, 0); // local Mon 07:00:00
    const withinMinute = new Date(2026, 5, 1, 7, 0, 30); // 07:00:30
    const wrong = new Date(2026, 5, 1, 7, 1, 0);
    expect(shouldAlarmFire(alarm, at)).toBe(true);
    expect(shouldAlarmFire(alarm, withinMinute)).toBe(true);
    expect(shouldAlarmFire(alarm, wrong)).toBe(false);
  });

  it("does not treat malformed time strings as midnight", () => {
    const alarm: AlarmModel = { id: "a", time: ":", label: "", repeat: [], enabled: true };
    const midnight = new Date(2026, 5, 1, 0, 0, 0);
    expect(shouldAlarmFire(alarm, midnight)).toBe(false);
  });

  it("respects repeat weekdays", () => {
    // 2026-06-01 is a Monday (getDay() === 1).
    const monday = new Date(2026, 5, 1, 8, 0, 0);
    const onMon: AlarmModel = { id: "a", time: "08:00", label: "", repeat: [1], enabled: true };
    const onTue: AlarmModel = { id: "b", time: "08:00", label: "", repeat: [2], enabled: true };
    expect(shouldAlarmFire(onMon, monday)).toBe(true);
    expect(shouldAlarmFire(onTue, monday)).toBe(false);
  });

  it("builds a per-minute guard key", () => {
    const at = new Date(2026, 5, 1, 7, 5, 12);
    expect(alarmMinuteKey(at)).toBe("2026-06-01 07:05");
  });
});

describe("duration + timer formatting", () => {
  it("parses durations in multiple forms", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("  2:00 ")).toBe(120);
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("abc")).toBe(0);
    expect(parseDuration("1:2:3:4")).toBe(0);
  });

  it("formats clock seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3661)).toBe("1:01:01");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("formats stopwatch ms with centiseconds", () => {
    expect(formatStopwatch(0)).toBe("00:00.00");
    expect(formatStopwatch(1234)).toBe("00:01.23");
    expect(formatStopwatch(65_430)).toBe("01:05.43");
  });
});

describe("stopwatch laps", () => {
  it("computes lap splits from cumulative marks", () => {
    const laps = computeLaps([1000, 3000, 3500]);
    expect(laps).toEqual([
      { index: 1, lap: 1000, total: 1000 },
      { index: 2, lap: 2000, total: 3000 },
      { index: 3, lap: 500, total: 3500 },
    ]);
  });

  it("identifies fastest and slowest laps", () => {
    const laps = computeLaps([1000, 3000, 3500]);
    expect(lapExtremes(laps)).toEqual({ fastest: 2, slowest: 1 });
    expect(lapExtremes(computeLaps([1000]))).toEqual({ fastest: -1, slowest: -1 });
  });
});
