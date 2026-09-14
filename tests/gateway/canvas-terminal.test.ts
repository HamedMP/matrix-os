import { describe, expect, it } from "vitest";
import { CanvasActionSchema } from "../../packages/gateway/src/canvas/contracts.js";

describe("canvas terminal actions", () => {
  it("validates create, attach, observe, write, takeover, and kill payloads", () => {
    expect(CanvasActionSchema.parse({ nodeId: "node_terminal", type: "terminal.create", payload: { cwd: "projects" } }).type).toBe("terminal.create");
    const terminalRef = {
      workspaceId: "tws_00000000000000000000000000000001",
      tabId: "tt_00000000000000000000000000000001",
    };
    for (const type of ["terminal.attach", "terminal.observe", "terminal.write", "terminal.takeover", "terminal.kill"] as const) {
      const payload = type === "terminal.write"
        ? { terminalRef, input: "ls\n" }
        : { terminalRef };
      expect(CanvasActionSchema.safeParse({ nodeId: "node_terminal", type, payload }).success).toBe(true);
    }
  });

  it("rejects legacy session IDs before action execution", () => {
    expect(CanvasActionSchema.safeParse({
      nodeId: "node_terminal",
      type: "terminal.attach",
      payload: { sessionId: "not-a-session" },
    }).success).toBe(false);
  });
});
