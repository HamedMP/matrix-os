import { projectCodingActivity } from "../../packages/gateway/src/chat/coding-activity-projection.js";
import { describe, expect, it } from "vitest";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

const context = {
  threadId: "thread_display",
  now: () => new Date("2026-09-20T00:00:00.000Z"),
  nextEventId: () => "evt_display",
};

function parse(record: Record<string, unknown>) {
  return parseCodexExecJsonLine(JSON.stringify(record), context).events;
}

const start = { type: "matrix.codex.tool.started", toolCallId: "command_1", displayName: "Run command", kind: "command" };

describe("Codex tool display contract", () => {
  it("retains a tool start with a command longer than a short label", () => {
    const preview = `bun run test ${"tests/regression.test.ts ".repeat(20)}`.trim();
    expect(parse({ ...start, preview, previewKind: "command" })).toEqual([
      expect.objectContaining({ type: "tool.started", displayName: "Run command", preview, previewKind: "command" }),
    ]);
  });

  it("retains tool metadata with a long owner-relative working directory", () => {
    const detail = `Working directory: projects/${"nested/".repeat(30)}app`;
    expect(parse({ ...start, detail })).toEqual([expect.objectContaining({ type: "tool.started", detail })]);
  });

  it("omits invalid optional display text without discarding tool identity", () => {
    expect(parse({ ...start, preview: "x".repeat(1001), previewKind: "command", detail: "Working directory: projects/demo" }))
      .toEqual([expect.objectContaining({ type: "tool.started", displayName: "Run command", detail: "Working directory: projects/demo" })]);
    expect(parse({ ...start, preview: "x".repeat(1001), previewKind: "command" })[0]).not.toHaveProperty("preview");
  });

  it("retains identity when optional metadata is unsafe or incomplete", () => {
    for (const fields of [{ detail: "stack trace from private runtime" }, { preview: "bun run test" }, { preview: "cat /home/private/file", previewKind: "command" }]) {
      expect(parse({ ...start, ...fields })).toEqual([expect.objectContaining({ type: "tool.started", displayName: "Run command" })]);
    }
  });

  it("preserves independently validated completion metadata without a second start", () => {
    expect(parse({ type: "matrix.codex.tool.completed", toolCallId: "command_1", outcome: "success",
      preview: "printf ok", previewKind: "command", detail: "Working directory: projects/demo" }))
      .toEqual([expect.objectContaining({ type: "tool.completed", toolCallId: "command_1", outcome: "success", preview: "printf ok", previewKind: "command" })]);
    expect(parse({ type: "matrix.codex.tool.completed", toolCallId: "command_1", outcome: "failed",
      preview: "x".repeat(1001), previewKind: "command", detail: "Working directory: projects/demo" }))
      .toEqual([expect.objectContaining({ type: "tool.completed", outcome: "failed", detail: "Working directory: projects/demo" })]);
  });

  it("retains a coarse event for legacy unsealed output", () => {
    const text = `${"test passed\n".repeat(30)}30 tests passed`;
    expect(parse({ type: "matrix.codex.tool.output", toolCallId: "command_1", text, truncated: false }))
      .toEqual([expect.objectContaining({ type: "tool.output", text: "Tool output is private to its owner.", truncated: false })]);
  });
});

it.each(["ls /opt/matrix/app", "echo API_KEY=qa-fake"])("keeps unprotected old-runner optional evidence out of generic canonical activities: %s", preview => {
  const events = parse({ ...start, preview, previewKind: "command" });
  expect(events).toHaveLength(1);
  const started = events[0]!;
  if (started.type !== "tool.started") throw new Error("Invalid fixture");
  const projected = projectCodingActivity(started);
  expect(projected.label).toBe("Run command");
  expect(projected).not.toHaveProperty("preview");
});
