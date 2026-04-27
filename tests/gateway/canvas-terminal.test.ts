import { describe, expect, it } from "vitest";
import { CanvasActionSchema } from "../../packages/gateway/src/canvas/contracts.js";

describe("canvas terminal actions", () => {
  it("validates create, attach, observe, write, takeover, and kill payloads", () => {
    expect(CanvasActionSchema.parse({ nodeId: "node_terminal", type: "terminal.create", payload: { cwd: "projects" } }).type).toBe("terminal.create");
    for (const type of ["terminal.attach", "terminal.observe", "terminal.write", "terminal.takeover", "terminal.kill"] as const) {
      const payload = type === "terminal.write"
        ? { sessionId: "550e8400-e29b-41d4-a716-446655440000", input: "ls\n" }
        : { sessionId: "550e8400-e29b-41d4-a716-446655440000" };
      expect(CanvasActionSchema.safeParse({ nodeId: "node_terminal", type, payload }).success).toBe(true);
    }
  });

  it("rejects invalid terminal sessions before action execution", () => {
    expect(CanvasActionSchema.safeParse({
      nodeId: "node_terminal",
      type: "terminal.attach",
      payload: { sessionId: "not-a-session" },
    }).success).toBe(false);
  });
});
