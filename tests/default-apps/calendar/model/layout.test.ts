import { describe, expect, it } from "vitest";
import { daySlices } from "../../../../home/apps/calendar/src/model/dates";
import {
  eventDaySpan,
  isMultiDayBar,
  layoutBars,
  layoutColumns,
  layoutTimedGrid,
  sliceTimedEvents,
  type TimedSegment,
} from "../../../../home/apps/calendar/src/model/layout";
import { groupAgenda } from "../../../../home/apps/calendar/src/model/agenda";
import { buildMonthGrid } from "../../../../home/apps/calendar/src/model/month";
import { viewRange } from "../../../../home/apps/calendar/src/model/ranges";
import { allDay, event } from "./fixtures";

const NY = "America/New_York";

function segment(id: string, startMinute: number, endMinute: number): TimedSegment {
  return {
    event: event({ id, start: "2026-11-23T00:00:00Z", end: "2026-11-23T01:00:00Z" }),
    dayKey: "2026-11-23",
    startMinute,
    endMinute,
    continuesBefore: false,
    continuesAfter: false,
  };
}

describe("timed event slicing", () => {
  it("places events by wall clock on a daylight-saving change day", () => {
    const days = daySlices(["2026-03-08"], NY);
    const nine = event({ id: "c/nine", start: "2026-03-08T09:00:00-04:00", end: "2026-03-08T10:00:00-04:00" });
    const early = event({ id: "c/early", start: "2026-03-08T01:00:00-05:00", end: "2026-03-08T03:30:00-04:00" });
    const sliced = sliceTimedEvents([nine, early], days, NY)["2026-03-08"];
    const byId = Object.fromEntries(sliced.map((s) => [s.event.id, s]));
    expect(byId["c/nine"]).toMatchObject({ startMinute: 540, endMinute: 600 });
    // One elapsed hour and a half, drawn from the 01:00 line to the 03:30 line.
    expect(byId["c/early"]).toMatchObject({ startMinute: 60, endMinute: 210 });
  });

  it("splits an overnight event at the zoned midnight, not 24 hours later", () => {
    const days = daySlices(["2026-03-07", "2026-03-08", "2026-03-09"], NY);
    const overnight = event({ id: "c/night", start: "2026-03-08T22:00:00-04:00", end: "2026-03-09T02:00:00-04:00" });
    const sliced = sliceTimedEvents([overnight], days, NY);
    expect(sliced["2026-03-07"]).toEqual([]);
    expect(sliced["2026-03-08"][0]).toMatchObject({ startMinute: 22 * 60, endMinute: 1440, continuesAfter: true });
    expect(sliced["2026-03-09"][0]).toMatchObject({ startMinute: 0, endMinute: 120, continuesBefore: true });
  });

  it("shows the same event on a different day in another zone", () => {
    const late = event({ id: "c/late", start: "2026-11-23T23:30:00-05:00", end: "2026-11-24T00:30:00-05:00" });
    const berlin = sliceTimedEvents([late], daySlices(["2026-11-24"], "Europe/Berlin"), "Europe/Berlin");
    expect(berlin["2026-11-24"][0]).toMatchObject({ startMinute: 5 * 60 + 30, endMinute: 6 * 60 + 30 });
  });

  it("leaves all-day and day-long events to the bar row", () => {
    const bar = allDay("c/a", "2026-11-23", "2026-11-24");
    const long = event({ id: "c/l", start: "2026-11-23T08:00:00Z", end: "2026-11-24T09:00:00Z" });
    expect(isMultiDayBar(bar)).toBe(true);
    expect(isMultiDayBar(long)).toBe(true);
    expect(sliceTimedEvents([bar, long], daySlices(["2026-11-23"], "UTC"), "UTC")["2026-11-23"]).toEqual([]);
  });

  it("gives zero-length events a visible minimum height", () => {
    const point = event({ id: "c/p", start: "2026-11-23T10:00:00Z", end: "2026-11-23T10:00:00Z" });
    const sliced = sliceTimedEvents([point], daySlices(["2026-11-23"], "UTC"), "UTC")["2026-11-23"];
    expect(sliced[0]).toMatchObject({ startMinute: 600, endMinute: 615 });
  });
});

describe("overlap layout", () => {
  it("puts non-overlapping events in one full-width column", () => {
    const placed = layoutColumns([segment("a", 540, 600), segment("b", 600, 660)]);
    expect(placed.map((p) => [p.column, p.columnCount, p.span])).toEqual([[0, 1, 1], [0, 1, 1]]);
  });

  it("splits a cluster of overlapping events into side-by-side columns", () => {
    const placed = layoutColumns([segment("a", 540, 660), segment("b", 570, 630), segment("c", 600, 690)]);
    const byId = Object.fromEntries(placed.map((p) => [p.event.id, p]));
    expect(byId.a).toMatchObject({ column: 0, columnCount: 3 });
    expect(byId.b).toMatchObject({ column: 1, columnCount: 3 });
    expect(byId.c).toMatchObject({ column: 2, columnCount: 3 });
  });

  it("reuses a freed column and widens events into empty neighbours", () => {
    // a 9-12, b 9-10, c 10-11: c reuses b's column. d 13-14 is its own cluster.
    const placed = layoutColumns([segment("a", 540, 720), segment("b", 540, 600), segment("c", 600, 660), segment("d", 780, 840)]);
    const byId = Object.fromEntries(placed.map((p) => [p.event.id, p]));
    expect(byId.a).toMatchObject({ column: 0, columnCount: 2, span: 1 });
    expect(byId.b).toMatchObject({ column: 1, columnCount: 2 });
    expect(byId.c).toMatchObject({ column: 1, columnCount: 2 });
    expect(byId.d).toMatchObject({ column: 0, columnCount: 1, span: 1 });

    const wide = layoutColumns([segment("x", 540, 600), segment("y", 540, 720), segment("z", 540, 600), segment("w", 630, 690)]);
    const w = wide.find((p) => p.event.id === "w");
    // y is longest and takes column 0; x and z take 1 and 2; w starts after x and z end and spans both.
    expect(w).toMatchObject({ column: 1, columnCount: 3, span: 2 });
  });

  it("lays out a whole grid per day", () => {
    const grid = layoutTimedGrid(
      [event({ id: "c/1", start: "2026-11-23T09:00:00Z", end: "2026-11-23T10:00:00Z" })],
      daySlices(["2026-11-23", "2026-11-24"], "UTC"),
      "UTC",
    );
    expect(grid["2026-11-23"]).toHaveLength(1);
    expect(grid["2026-11-24"]).toEqual([]);
  });
});

describe("bar rows for all-day and multi-day events", () => {
  it("reads all-day dates without shifting them into the viewer's zone", () => {
    const holiday = allDay("c/h", "2026-11-26", "2026-11-27");
    expect(eventDaySpan(holiday, "Pacific/Honolulu")).toEqual({ startKey: "2026-11-26", endKey: "2026-11-27" });
    expect(eventDaySpan(holiday, "Pacific/Kiritimati")).toEqual({ startKey: "2026-11-26", endKey: "2026-11-27" });
  });

  it("packs overlapping bars into rows and marks continuation at the edges", () => {
    const days = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"];
    const trip = allDay("c/trip", "2026-11-20", "2026-11-25");
    const conf = allDay("c/conf", "2026-11-24", "2026-11-26");
    const later = allDay("c/later", "2026-11-26", "2026-12-02");
    const { bars, rowCount } = layoutBars([later, conf, trip], days, "UTC");
    const byId = Object.fromEntries(bars.map((b) => [b.event.id, b]));
    expect(byId["c/trip"]).toMatchObject({ startIndex: 0, endIndex: 2, row: 0, continuesBefore: true, continuesAfter: false });
    expect(byId["c/conf"]).toMatchObject({ startIndex: 1, endIndex: 3, row: 1 });
    expect(byId["c/later"]).toMatchObject({ startIndex: 3, endIndex: 5, row: 0, continuesAfter: true });
    expect(rowCount).toBe(2);
  });

  it("maps bars onto a work week that skips the weekend", () => {
    const days = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"];
    const weekend = allDay("c/w", "2026-11-21", "2026-11-23");
    const spanning = allDay("c/s", "2026-11-27", "2026-12-01");
    const { bars } = layoutBars([weekend, spanning], days, "UTC");
    expect(bars.map((b) => b.event.id)).toEqual(["c/s"]);
    expect(bars[0]).toMatchObject({ startIndex: 4, endIndex: 5, continuesAfter: true });
  });
});

describe("month grid", () => {
  it("counts the events that do not fit in a day cell", () => {
    const range = viewRange("month", "2026-11-10", { timeZone: "UTC", weekStart: 1, workDays: [1, 2, 3, 4, 5], agendaDays: 14 });
    const busyDay = [1, 2, 3, 4, 5].map((n) =>
      event({ id: `c/m${n}`, start: `2026-11-11T0${n}:00:00Z`, end: `2026-11-11T0${n}:30:00Z` }),
    );
    const multi = allDay("c/multi", "2026-11-10", "2026-11-13");
    const grid = buildMonthGrid(range, [...busyDay, multi], { timeZone: "UTC", maxRows: 3, today: "2026-11-11" });

    expect(grid.monthKey).toBe("2026-11");
    expect(grid.weeks).toHaveLength(range.days.length / 7);
    const week = grid.weeks.find((w) => w.days.some((d) => d.key === "2026-11-11"))!;
    const wednesday = week.days.find((d) => d.key === "2026-11-11")!;
    expect(wednesday).toMatchObject({ inMonth: true, isToday: true, eventCount: 6, overflow: 3 });
    expect(wednesday.hiddenEventIds).toEqual(["c/m3", "c/m4", "c/m5"]);
    // The multi-day bar comes first and the earliest timed events follow it.
    expect(week.bars.map((b) => b.event.id)).toEqual(["c/multi", "c/m1", "c/m2"]);
    expect(week.bars.every((b) => b.row < 3)).toBe(true);
    const tuesday = week.days.find((d) => d.key === "2026-11-10")!;
    expect(tuesday).toMatchObject({ overflow: 0, eventCount: 1 });
    expect(grid.weeks[0].days[0]).toMatchObject({ key: "2026-10-26", inMonth: false });
  });
});

describe("agenda grouping", () => {
  it("lists each day's events with all-day items first and repeats multi-day events", () => {
    const days = ["2026-11-23", "2026-11-24", "2026-11-25"];
    const meeting = event({ id: "c/meet", start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z" });
    const early = event({ id: "c/early", start: "2026-11-24T08:00:00Z", end: "2026-11-24T09:00:00Z" });
    const trip = allDay("c/trip", "2026-11-24", "2026-11-26");
    const agenda = groupAgenda([meeting, trip, early], days, "UTC");
    expect(agenda.map((d) => d.key)).toEqual(["2026-11-24", "2026-11-25"]);
    expect(agenda[0].items.map((i) => i.event.id)).toEqual(["c/trip", "c/early", "c/meet"]);
    expect(agenda[1].items[0]).toMatchObject({ continuesBefore: true, continuesAfter: false });

    const withEmpty = groupAgenda([meeting], days, "UTC", { includeEmptyDays: true });
    expect(withEmpty.map((d) => d.items.length)).toEqual([0, 1, 0]);
  });
});
