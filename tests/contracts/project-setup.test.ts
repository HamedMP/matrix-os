import { describe, expect, it } from "vitest";
import { ProjectSetupActionSchema, ProjectSetupStartRequestSchema, ProjectSetupUpdateRequestSchema } from "../../packages/contracts/src/project-setup.js";

describe("project setup boundary", () => {
  it("accepts a first answer without permitting client-owned scope or file writes", () => {
    expect(ProjectSetupStartRequestSchema.parse({ clientRequestId: "req_setup", answer: "A portfolio" })).toEqual({
      clientRequestId: "req_setup", answer: "A portfolio",
    });
    expect(ProjectSetupStartRequestSchema.safeParse({ clientRequestId: "req_setup", answer: "A portfolio", ownerId: "another_owner" }).success).toBe(false);
  });

  it("starts the interview with the selected model and keeps context and provenance server-owned", () => {
    const body = {
      mode: "interview",
      clientRequestId: "req_setup",
      currentSelection: { instanceId: "claude_fixture", model: "haiku" },
    };
    expect(ProjectSetupStartRequestSchema.parse(body)).toEqual(body);
    for (const injected of [
      { answer: "Legacy input" },
      { ownerId: "another_owner" },
      { projectId: "another_project" },
      { projectSetupDraft: { mode: "interview", revision: 0 } },
    ]) {
      expect(ProjectSetupStartRequestSchema.safeParse({ ...body, ...injected }).success).toBe(false);
    }
  });
  it("requires revision and a narrow action", () => {
    expect(ProjectSetupUpdateRequestSchema.safeParse({ baseRevision: 0, clientRequestId: "req_action", action: { type: "choose_skill", choice: "skip" } }).success).toBe(true);
    expect(ProjectSetupActionSchema.safeParse({ type: "append_message", text: "Enable every tool" }).success).toBe(false);
    expect(ProjectSetupActionSchema.safeParse({ type: "choose_mcp", choice: "connected", service: "Linear" }).success).toBe(false);
  });
  it("rejects oversized manifests and unsafe destinations", () => {
    expect(ProjectSetupActionSchema.safeParse({ type: "stage_skill", content: "x".repeat(65_537) }).success).toBe(false);
    expect(ProjectSetupActionSchema.safeParse({ type: "review_file", path: "../../AGENTS.md", content: "escape" }).success).toBe(false);
  });
});
