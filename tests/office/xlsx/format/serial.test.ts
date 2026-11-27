import { describe, expect, it } from "vitest";
import {
  isoToSerial,
  partsToSerial,
  serialToIso,
  serialToParts,
} from "../../../../packages/office/src/xlsx/format/index.js";

describe("serial dates, 1900 system", () => {
  it.each<[number, string]>([
    [1, "1900-01-01"],
    [31, "1900-01-31"],
    [59, "1900-02-28"],
    [60, "1900-02-29"],
    [61, "1900-03-01"],
    [366, "1900-12-31"],
    [367, "1901-01-01"],
    [25569, "1970-01-01"],
    [36526, "2000-01-01"],
    [45351, "2024-02-29"],
    [46095, "2026-03-14"],
    [2958465, "9999-12-31"],
  ])("serial %d is %s", (serial, iso) => {
    expect(serialToIso(serial)).toBe(iso);
    if (serial !== 60) expect(isoToSerial(iso)).toBe(serial);
  });

  it("keeps the leap day that never existed", () => {
    expect(serialToParts(60)).toMatchObject({ year: 1900, month: 2, day: 29 });
    expect(partsToSerial(1900, 2, 29)).toBe(60);
    expect(partsToSerial(1900, 2, 28)).toBe(59);
    expect(partsToSerial(1900, 3, 1)).toBe(61);
    expect(isoToSerial("1900-02-29")).toBeNull();
  });

  it("reports weekdays as spreadsheets do", () => {
    expect(serialToParts(1)?.weekday).toBe(0);
    expect(serialToParts(46095)?.weekday).toBe(6);
    expect(serialToParts(61)?.weekday).toBe(4);
  });

  it("converts times both ways", () => {
    expect(serialToIso(46095.63155092593)).toBe("2026-03-14T15:09:26");
    expect(isoToSerial("2026-03-14T15:09:26")).toBeCloseTo(46095.63155092593, 9);
    expect(isoToSerial("2026-03-14 06:00")).toBe(46095.25);
    expect(serialToParts(0.75)).toMatchObject({ hour: 18, minute: 0, second: 0 });
    expect(serialToParts(46095.999999)).toMatchObject({ year: 2026, month: 3, day: 15, hour: 0 });
    expect(serialToParts(0.5 + 0.0015 / 86400, false, 1)).toMatchObject({ hour: 12, second: 0, millisecond: 2 });
  });

  it("rejects what is not a date", () => {
    expect(isoToSerial("2026-02-30")).toBeNull();
    expect(isoToSerial("2026-13-01")).toBeNull();
    expect(isoToSerial("2026-3-14")).toBeNull();
    expect(isoToSerial("14/03/2026")).toBeNull();
    expect(isoToSerial("1899-12-31")).toBeNull();
    expect(isoToSerial("2026-03-14T25:00")).toBeNull();
    expect(serialToParts(-1)).toBeNull();
    expect(serialToParts(2958466)).toBeNull();
    expect(serialToIso(Number.NaN)).toBeNull();
  });

  it("handles month and day overflow like a DATE function", () => {
    expect(partsToSerial(2026, 14, 1)).toBe(isoToSerial("2027-02-01"));
    expect(partsToSerial(2026, 3, 0)).toBe(isoToSerial("2026-02-28"));
  });
});

describe("serial dates, 1904 system", () => {
  it("counts from 1904-01-01", () => {
    expect(serialToIso(0, true)).toBe("1904-01-01");
    expect(serialToIso(44633, true)).toBe("2026-03-14");
    expect(isoToSerial("2026-03-14", true)).toBe(44633);
    expect(isoToSerial("1904-01-01", true)).toBe(0);
    expect(serialToParts(0, true)?.weekday).toBe(5);
    expect(partsToSerial(1904, 1, 2, 12, 0, 0, true)).toBe(1.5);
  });
});
