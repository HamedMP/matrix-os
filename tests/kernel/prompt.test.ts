import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../packages/kernel/src/prompt.js";

describe("buildSystemPrompt", () => {
  const homePath = "./home";

  it("returns a string", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("stays under 7K tokens (~28K characters as rough estimate)", () => {
    const prompt = buildSystemPrompt(homePath);
    // ~4 chars per token is a rough estimate; 7K tokens = 28K chars max
    expect(prompt.length).toBeLessThan(28_000);
  });

  it("includes the system prompt base from agents/system-prompt.md", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("Matrix OS");
  });

  it("includes state summary section", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("State");
  });

  it("includes modules section", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("Modules");
  });

  it("includes knowledge table of contents", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("Knowledge");
  });

  it("includes MATRIX_HOME with the provided path", () => {
    const prompt = buildSystemPrompt("/custom/matrixos");
    expect(prompt).toContain("MATRIX_HOME: /custom/matrixos");
    expect(prompt).toContain("Always use the absolute path");
  });

  it("includes File System section", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("## File System");
    expect(prompt).toContain("MATRIX_HOME");
  });

  it("handles missing files gracefully", () => {
    // Non-existent path should not throw
    expect(() => buildSystemPrompt("/nonexistent/path")).not.toThrow();
    const prompt = buildSystemPrompt("/nonexistent/path");
    expect(typeof prompt).toBe("string");
  });

  it("includes user profile if available", () => {
    const prompt = buildSystemPrompt(homePath);
    // user-profile.md exists in home/ with stub content
    expect(prompt).toContain("User");
  });
});
