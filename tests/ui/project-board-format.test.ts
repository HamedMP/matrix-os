import { describe, expect, it } from "vitest";
import { formatDue } from "../../packages/ui/src/project-board/board-format";

// Local wall-clock times, so the expectations hold in any time zone.
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0, 0);
const due = (day: number) => at(day, 17).toISOString();

describe("formatDue", () => {
  it("calls tomorrow's deadline tomorrow even when it is more than 24 hours away", () => {
    expect(formatDue(due(21), at(20, 9).getTime())).toEqual({ label: "Due tomorrow", overdue: false });
  });

  it("calls a deadline later today today", () => {
    expect(formatDue(due(20), at(20, 9).getTime())).toEqual({ label: "Due today", overdue: false });
  });

  it("marks today's deadline overdue once it has passed", () => {
    expect(formatDue(due(20), at(20, 18).getTime())).toMatchObject({ overdue: true });
    expect(formatDue(due(20), at(20, 18).getTime()).label).toMatch(/^Overdue · /);
  });

  it("shows the date for deadlines two or more calendar days out", () => {
    const result = formatDue(due(22), at(20, 23).getTime());
    expect(result.overdue).toBe(false);
    expect(result.label).not.toBe("Due tomorrow");
    expect(result.label).toMatch(/^Due /);
  });

  it("marks past days overdue", () => {
    expect(formatDue(due(18), at(20, 9).getTime())).toMatchObject({ overdue: true });
  });
});
