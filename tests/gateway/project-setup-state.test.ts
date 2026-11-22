import { describe, expect, it } from "vitest";
import { initialProjectSetup, transitionProjectSetup, applyProjectSetupGeneration } from "../../packages/gateway/src/chat/project-setup-state.js";

const initial = () => initialProjectSetup("chat_setup", "project_a", "A portfolio", "msg_question");
describe("project setup transitions", () => {
  it("asks guidance before skill and MCP", () => {
    const guidance = transitionProjectSetup(initial(), { type: "answer", text: "Run checks before publishing" });
    expect(guidance.draft.step).toBe("skill");
    const mcp = transitionProjectSetup(guidance.draft, { type: "choose_skill", choice: "skip" });
    expect(mcp.draft.step).toBe("mcp");
    const review = transitionProjectSetup(mcp.draft, { type: "choose_mcp", choice: "skip" });
    expect(review.draft.step).toBe("review");
    expect(review.draft.proposals.map(p => p.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(review.draft.proposals[0]?.content).toContain("Run checks before publishing");
  });
  it("stages manifest content without creating files", () => {
    const guidance = transitionProjectSetup(initial(), { type: "answer", text: "Review every diff" });
    const content = '---\nname: release-check\ndescription: Release checklist\n---\n\nRun the tests.\n';
    const staged = transitionProjectSetup(guidance.draft, { type: "stage_skill", content });
    expect(staged.draft.skill?.content).toBe(content);
    expect(staged.draft.skill?.path).toBe(".agents/skills/release-check/SKILL.md");
    expect(staged.draft.step).toBe("mcp");
  });
  it("rejects malformed imported metadata", () => {
    expect(() => transitionProjectSetup(initial(), { type: "stage_skill", content: "just text" })).toThrow();
  });
  it("invalidates a generated review when accepted answers change", () => {
    const changed = transitionProjectSetup(initial(), { type: "revise", field: "purpose", text: "A restaurant website" });
    expect(changed.draft.answers.purpose).toBe("A restaurant website");
    expect(changed.draft.generation).toBeUndefined();
    expect(changed.draft.proposals.every(p => p.status === "pending")).toBe(true);
  });
  it("accepts bounded model Markdown without granting tools", () => {
    const draft = applyProjectSetupGeneration(initial(), JSON.stringify({ guidance: "# Working preferences\n\nKeep edits small." }));
    expect(draft.proposals[0]?.content).toContain("Keep edits small");
    expect(draft.mcp.state).toBe("not_requested");
    expect(() => applyProjectSetupGeneration(initial(), JSON.stringify({ guidance: "x".repeat(8193) }))).toThrow();
  });
});
