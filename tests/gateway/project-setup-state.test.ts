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
  it("requires a newly drafted skill after revising its accepted instructions", () => {
    let draft = transitionProjectSetup(initial(), { type: "answer", text: "Review each diff" }).draft;
    draft = transitionProjectSetup(draft, { type: "choose_skill", choice: "create" }).draft;
    draft = transitionProjectSetup(draft, { type: "answer", text: "Check the release notes" }).draft;
    draft = transitionProjectSetup(draft, { type: "choose_mcp", choice: "skip" }).draft;
    draft = applyProjectSetupGeneration(draft, JSON.stringify({ guidance: "# Guidance", skill: {
      name: "release-check", description: "Check a release", instructions: "Read the old release notes.",
    } }));
    const revised = transitionProjectSetup(draft, { type: "revise", field: "skillInstructions", text: "Run tests and verify migrations" }).draft;
    expect(revised.answers.skillInstructions).toBe("Run tests and verify migrations");
    expect(revised.skill).toBeUndefined();
    expect(revised.proposals.some(file => file.path.endsWith("/SKILL.md"))).toBe(false);
  });
  it("retains oversized generated guidance for review and a later bounded revision", () => {
    const text = "# Guidance\n\n" + "x".repeat(8200);
    const draft = applyProjectSetupGeneration({ ...initial(), step: "review" }, JSON.stringify({ guidance: text }));
    expect(draft.generation?.status).toBe("completed");
    expect(draft.proposals[0]?.content).toBe(text);
    const intermediate = transitionProjectSetup(draft, { type: "review_file", path: "AGENTS.md", content: "x".repeat(8193) }).draft;
    expect(intermediate.proposals[0]?.content).toHaveLength(8193);
    const revised = transitionProjectSetup(intermediate, { type: "review_file", path: "AGENTS.md", content: "# Guidance\n\nKeep edits small." }).draft;
    expect(revised.proposals[0]?.content).toBe("# Guidance\n\nKeep edits small.");
  });
  it("retains the existing UTF-8 and total model response bounds", () => {
    expect(() => applyProjectSetupGeneration(initial(), JSON.stringify({ guidance: "界".repeat(22_000) }))).toThrow();
    expect(() => applyProjectSetupGeneration(initial(), " ".repeat(96 * 1024) + JSON.stringify({ guidance: "# Guidance" }))).toThrow();
  });
  it("accepts bounded model Markdown without granting tools", () => {
    const draft = applyProjectSetupGeneration(initial(), JSON.stringify({ guidance: "# Working preferences\n\nKeep edits small." }));
    expect(draft.proposals[0]?.content).toContain("Keep edits small");
    expect(draft.mcp.state).toBe("not_requested");
    expect(() => applyProjectSetupGeneration(initial(), JSON.stringify({ guidance: "x".repeat(65_537) }))).toThrow();
  });
});
