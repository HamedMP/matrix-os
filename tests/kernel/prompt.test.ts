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

  it("includes user section", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("## User");
  });

  it("includes SOUL content from soul.md", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("## Soul");
    expect(prompt).toContain("genuinely helpful");
  });

  it("includes identity content from identity.md", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("## Identity");
  });

  it("includes bootstrap on first run", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("## First Run");
    expect(prompt).toContain("fresh install");
  });

  it("injects SOUL before state (L0 cache position)", () => {
    const prompt = buildSystemPrompt(homePath);
    const soulIdx = prompt.indexOf("## Soul");
    const stateIdx = prompt.indexOf("## Current State");
    expect(soulIdx).toBeLessThan(stateIdx);
  });
});
