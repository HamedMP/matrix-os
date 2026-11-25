import { describe, expect, it } from "vitest";
import { inviteRecipients, parseAddressInput } from "../../../../home/apps/calendar/src/ui/composer-helpers";
import { presetForRecurrence, presetForReminders, recurrenceForPreset, remindersForPreset } from "../../../../home/apps/calendar/src/ui/composerOptions";
import { guestAddresses, safeJoinUrl, timeChanges } from "../../../../home/apps/calendar/src/ui/eventActions";
import { draftState } from "../../../../home/apps/calendar/src/model/drafts";
import {
  columnAtOffset,
  createSpan,
  keyCommand,
  minuteAtOffset,
  movedStart,
  resizedEnd,
  segmentBox,
} from "../../../../home/apps/calendar/src/ui/gridMath";
import { safeColor } from "../../../../home/apps/calendar/src/ui/colors";
import { event } from "../model/fixtures";

const DRAFT = {
  calendarId: "work", title: "T", start: "2026-11-25T09:00:00-05:00", end: "2026-11-25T09:30:00-05:00", allDay: false,
  timeZone: "America/New_York", location: "", descriptionText: "", attendees: [], addOnlineMeeting: false,
};

describe("grid geometry", () => {
  it("maps offsets to snapped minutes and columns", () => {
    expect(minuteAtOffset(432)).toBe(540);
    expect(minuteAtOffset(445)).toBe(555);
    expect(minuteAtOffset(-20)).toBe(0);
    expect(minuteAtOffset(5000)).toBe(1440);
    expect(columnAtOffset(350, 700, 7)).toBe(3);
    expect(columnAtOffset(9999, 700, 7)).toBe(6);
    expect(columnAtOffset(10, 0, 7)).toBe(0);
  });

  it("sizes a block by its column share and minutes", () => {
    expect(segmentBox({ startMinute: 540, endMinute: 600, column: 1, columnCount: 3, span: 2 }))
      .toEqual({ top: 432, height: 48, left: 100 / 3, width: 200 / 3 });
  });

  it("creates, moves and resizes within the day", () => {
    expect(createSpan(600, 600, 30)).toEqual({ start: 600, end: 630 });
    expect(createSpan(660, 600, 30)).toEqual({ start: 600, end: 660 });
    expect(resizedEnd(540, 570, -100)).toBe(555);
    expect(resizedEnd(540, 570, 31)).toBe(600);
    expect(movedStart(1380, 120, 60)).toBe(1320);
    expect(movedStart(30, 60, -90)).toBe(0);
  });
});

describe("keyboard map", () => {
  it("maps single keys and ignores typing and modifiers", () => {
    expect(keyCommand({ key: "t" })).toEqual({ type: "today" });
    expect(keyCommand({ key: "N" })).toEqual({ type: "shift", steps: 1 });
    expect(keyCommand({ key: "p" })).toEqual({ type: "shift", steps: -1 });
    expect(keyCommand({ key: "2" })).toEqual({ type: "view", view: "workWeek" });
    expect(keyCommand({ key: "c" })).toEqual({ type: "new" });
    expect(keyCommand({ key: "t", editable: true })).toBeNull();
    expect(keyCommand({ key: "t", metaKey: true })).toBeNull();
    expect(keyCommand({ key: "z" })).toBeNull();
  });
});

describe("event helpers", () => {
  it("lists guests other than the organiser and the owner", () => {
    const meeting = event({
      start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z",
      attendees: [
        { address: "Org@example.com", name: "", response: "accepted", organizer: true },
        { address: "ME@example.com", name: "", response: "accepted", organizer: false },
        { address: "Lee@Example.com", name: "", response: "needsAction", organizer: false },
      ],
    });
    expect(guestAddresses(meeting, "me@example.com")).toEqual(["lee@example.com"]);
  });

  it("writes moved times in the event's own zone", () => {
    const meeting = event({ start: "2026-11-24T15:00:00Z", end: "2026-11-24T16:00:00Z", timeZone: "Europe/Berlin" });
    const changes = timeChanges(meeting, Date.parse("2026-11-24T16:00:00Z"), Date.parse("2026-11-24T17:00:00Z"));
    expect(changes).toEqual({ start: "2026-11-24T17:00:00+01:00", end: "2026-11-24T18:00:00+01:00", allDay: false, timeZone: "Europe/Berlin" });
  });

  it("accepts only https join links and plain hex calendar colours", () => {
    expect(safeJoinUrl("https://meet.example.com/x")).toBe("https://meet.example.com/x");
    expect(safeJoinUrl("http://meet.example.com/x")).toBeNull();
    expect(safeJoinUrl("javascript:alert(1)")).toBeNull();
    expect(safeJoinUrl("not a url")).toBeNull();
    expect(safeColor("#3366cc")).toBe("#3366cc");
    expect(safeColor("red;background:url(x)")).toBe("var(--cal-accent)");
  });

  it("names removed guests as recipients of an update", () => {
    const original = { ...DRAFT, attendees: [{ address: "a@example.com" }, { address: "b@example.com" }] };
    const state = draftState({ ...DRAFT, attendees: [{ address: "b@example.com" }, { address: "c@example.com" }] }, { mode: "edit", eventId: "work/x", original });
    expect(inviteRecipients(state)).toEqual(["b@example.com", "c@example.com", "a@example.com"]);
  });
});

describe("composer presets", () => {
  it("parses pasted address lists", () => {
    expect(parseAddressInput("Ana@Example.com, <ben@example.com>; bad ana@example.com")).toEqual({
      valid: ["ana@example.com", "ben@example.com"],
      invalid: ["bad"],
    });
  });

  it("round-trips recurrence and reminder presets", () => {
    expect(recurrenceForPreset("weekly", DRAFT)).toEqual({ freq: "weekly", interval: 1, byDay: ["WE"] });
    expect(presetForRecurrence(recurrenceForPreset("weekdays", DRAFT) ?? undefined)).toBe("weekdays");
    expect(presetForRecurrence(recurrenceForPreset("biweekly", DRAFT) ?? undefined)).toBe("biweekly");
    expect(presetForRecurrence({ freq: "daily", interval: 1, count: 3 })).toBe("custom");
    expect(presetForRecurrence(undefined)).toBe("none");
    expect(remindersForPreset("default")).toBeNull();
    expect(remindersForPreset("none")).toEqual([]);
    expect(remindersForPreset("30")).toEqual([{ minutesBefore: 30, method: "popup" }]);
    expect(presetForReminders([{ minutesBefore: 30, method: "popup" }])).toBe("30");
    expect(presetForReminders([{ minutesBefore: 7, method: "popup" }])).toBe("custom");
  });
});
