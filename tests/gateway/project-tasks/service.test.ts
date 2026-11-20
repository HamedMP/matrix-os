import { describe, expect, it } from "vitest";
import { defaultTaskKey } from "../../../packages/gateway/src/project-tasks/service.js";
import { mapLegacyTasks } from "../../../packages/gateway/src/project-tasks/legacy-import.js";

describe("defaultTaskKey", () => {
  it("uses initials of multi-word slugs and the first letters of single words", () => {
    expect(defaultTaskKey("board-demo")).toBe("BD");
    expect(defaultTaskKey("matrix-os")).toBe("MO");
    expect(defaultTaskKey("website")).toBe("WEBS");
    expect(defaultTaskKey("my-big-new-shiny-app")).toBe("MBNS");
    expect(defaultTaskKey("x")).toBe("TASK");
    expect(defaultTaskKey("2026-plan")).toBe("TASK");
  });
});

describe("mapLegacyTasks", () => {
  it("bounds titles, drops invalid dates and keeps order within each status", () => {
    const base = { projectSlug: "p", priority: "low" as const, previewIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "nonsense" };
    const [first, second] = mapLegacyTasks([
      { ...base, id: "task_1", title: "  ", status: "todo", order: 5, dueAt: "not a date" },
      { ...base, id: "task_2", title: "Second", status: "todo", order: 1 },
    ]);
    expect(first).toMatchObject({ title: "Untitled task", dueAt: null, updatedAt: "2026-01-01T00:00:00.000Z", priority: "low" });
    expect(second!.rank < first!.rank).toBe(true);
  });
});
