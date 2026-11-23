import { describe, expect, it } from "vitest";
import { daySlices } from "../../../../home/apps/calendar/src/model/dates";
import { busyOverlays, findSlots, type FindSlotsOptions } from "../../../../home/apps/calendar/src/model/slots";
import { MAX_PROPOSALS, parseProposals } from "../../../../home/apps/calendar/src/model/proposals";

const NY = "America/New_York";
const WORK = { days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 };

function options(overrides: Partial<FindSlotsOptions> = {}): FindSlotsOptions {
  return {
    busy: [],
    rangeStart: "2026-11-23T00:00:00-05:00",
    rangeEnd: "2026-11-28T00:00:00-05:00",
    durationMinutes: 60,
    timeZone: NY,
    workingHours: WORK,
    ...overrides,
  };
}

describe("findSlots", () => {
  it("finds the first free hours between busy blocks of several people", () => {
    const slots = findSlots(options({
      maxResults: 3,
      busy: [
        { address: "a@example.com", start: "2026-11-23T14:00:00Z", end: "2026-11-23T15:00:00Z" },
        { address: "b@example.com", start: "2026-11-23T11:00:00-05:00", end: "2026-11-23T12:30:00-05:00" },
      ],
    }));
    expect(slots).toEqual([
      { start: "2026-11-23T10:00:00-05:00", end: "2026-11-23T11:00:00-05:00" },
      { start: "2026-11-23T12:30:00-05:00", end: "2026-11-23T13:30:00-05:00" },
      { start: "2026-11-23T13:00:00-05:00", end: "2026-11-23T14:00:00-05:00" },
    ]);
  });

  it("offers slots that do not overlap each other when asked for distinct choices", () => {
    const slots = findSlots(options({
      maxResults: 3,
      distinct: true,
      busy: [{ address: "b@example.com", start: "2026-11-23T11:30:00-05:00", end: "2026-11-23T12:30:00-05:00" }],
    }));
    expect(slots).toEqual([
      { start: "2026-11-23T09:00:00-05:00", end: "2026-11-23T10:00:00-05:00" },
      { start: "2026-11-23T10:00:00-05:00", end: "2026-11-23T11:00:00-05:00" },
      // 11:00 would overlap the busy block; the next free start on the 30-minute grid is 12:30.
      { start: "2026-11-23T12:30:00-05:00", end: "2026-11-23T13:30:00-05:00" },
    ]);
  });

  it("never treats unknown availability as free time", () => {
    const slots = findSlots(options({
      busy: [{ address: "x@example.com", start: "2026-11-23T00:00:00-05:00", end: "2026-11-28T00:00:00-05:00", status: "unknown" }],
    }));
    expect(slots).toEqual([]);
  });

  it("can schedule over tentative time when asked", () => {
    const tentative = [{ address: "a@example.com", start: "2026-11-23T09:00:00-05:00", end: "2026-11-23T17:00:00-05:00", status: "tentative" as const }];
    expect(findSlots(options({ busy: tentative, maxResults: 1 }))[0].start).toBe("2026-11-24T09:00:00-05:00");
    expect(findSlots(options({ busy: tentative, maxResults: 1, tentativeIsBusy: false }))[0].start).toBe("2026-11-23T09:00:00-05:00");
  });

  it("skips non-working days, past time and slots that would run past working hours", () => {
    const slots = findSlots(options({
      rangeStart: "2026-11-21T00:00:00-05:00",
      notBefore: Date.parse("2026-11-23T16:10:00-05:00"),
      durationMinutes: 45,
      stepMinutes: 15,
      maxResults: 2,
    }));
    expect(slots).toEqual([
      { start: "2026-11-23T16:15:00-05:00", end: "2026-11-23T17:00:00-05:00" },
      { start: "2026-11-24T09:00:00-05:00", end: "2026-11-24T09:45:00-05:00" },
    ]);
  });

  it("keeps a buffer around busy blocks", () => {
    const slots = findSlots(options({
      maxResults: 1,
      bufferMinutes: 15,
      busy: [{ address: "a@example.com", start: "2026-11-23T09:00:00-05:00", end: "2026-11-23T10:00:00-05:00" }],
    }));
    expect(slots[0].start).toBe("2026-11-23T10:30:00-05:00");
  });

  it("uses each day's own offset across a daylight-saving change", () => {
    const slots = findSlots(options({
      rangeStart: "2026-03-06T00:00:00-05:00",
      rangeEnd: "2026-03-10T00:00:00-04:00",
      maxResults: 20,
      durationMinutes: 480,
    }));
    expect(slots).toEqual([
      { start: "2026-03-06T09:00:00-05:00", end: "2026-03-06T17:00:00-05:00" },
      { start: "2026-03-09T09:00:00-04:00", end: "2026-03-09T17:00:00-04:00" },
    ]);
  });

  it("finds slots in the zone it is given", () => {
    const slots = findSlots(options({ timeZone: "Europe/Berlin", rangeStart: "2026-11-23T00:00:00+01:00", maxResults: 1 }));
    expect(slots[0]).toEqual({ start: "2026-11-23T09:00:00+01:00", end: "2026-11-23T10:00:00+01:00" });
  });

  it("rejects durations it cannot honour", () => {
    expect(() => findSlots(options({ durationMinutes: 0 }))).toThrow(RangeError);
    expect(() => findSlots(options({ workingHours: { days: [1], startMinute: 600, endMinute: 540 } }))).toThrow(RangeError);
    expect(findSlots(options({ durationMinutes: 9 * 60 }))).toEqual([]);
  });
});

describe("busy overlays", () => {
  it("merges each person's blocks per day and cuts them at the zoned midnight", () => {
    const overlays = busyOverlays(
      [
        { address: "a@example.com", start: "2026-11-23T09:00:00-05:00", end: "2026-11-23T10:00:00-05:00" },
        { address: "a@example.com", start: "2026-11-23T09:30:00-05:00", end: "2026-11-23T11:00:00-05:00" },
        { address: "b@example.com", start: "2026-11-23T23:00:00-05:00", end: "2026-11-24T01:00:00-05:00", status: "outOfOffice" },
      ],
      daySlices(["2026-11-23", "2026-11-24"], NY),
      NY,
    );
    expect(overlays["2026-11-23"]).toEqual([
      { address: "a@example.com", dayKey: "2026-11-23", startMinute: 540, endMinute: 660, status: "busy" },
      { address: "b@example.com", dayKey: "2026-11-23", startMinute: 1380, endMinute: 1440, status: "outOfOffice" },
    ]);
    expect(overlays["2026-11-24"]).toEqual([
      { address: "b@example.com", dayKey: "2026-11-24", startMinute: 0, endMinute: 60, status: "outOfOffice" },
    ]);
  });
});

describe("proposals", () => {
  it("accepts well-formed candidate slots and drops the rest", () => {
    const proposals = parseProposals(
      [
        { start: "2026-11-24T10:00:00-05:00", end: "2026-11-24T10:30:00-05:00", title: "Sync\u0007 with Ana", attendees: [{ address: "ana@example.com" }, { address: "not an address" }] },
        { start: "2026-11-24T10:00:00", end: "2026-11-24T10:30:00-05:00" },
        { start: "2026-11-24T11:00:00Z", end: "2026-11-24T10:00:00Z" },
        "junk",
      ],
      "agent",
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ source: "agent", title: "Sync with Ana", attendees: [{ address: "ana@example.com" }] });
    expect(proposals[0].id).toMatch(/^agent:/);
  });

  it("caps the number of proposals and accepts a wrapped list", () => {
    const many = Array.from({ length: MAX_PROPOSALS + 10 }, (_, i) => ({
      start: `2026-11-24T10:${String(i % 60).padStart(2, "0")}:00Z`,
      end: "2026-11-24T12:00:00Z",
    }));
    expect(parseProposals({ proposals: many }, "assistant")).toHaveLength(MAX_PROPOSALS);
    expect(parseProposals(null, "agent")).toEqual([]);
  });
});
