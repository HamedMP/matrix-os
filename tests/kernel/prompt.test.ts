import { describe, it, expect } from "vitest";
import { buildSystemPrompt, estimateTokens } from "../../packages/kernel/src/prompt.js";

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

  it("includes skills TOC section", () => {
    const prompt = buildSystemPrompt(homePath);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("load_skill");
  });

  it("includes onboarding progress when setup plan is building", () => {
    // Uses the temp dir approach to write a setup-plan.json
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
    const { join, resolve } = require("node:path");
    const { tmpdir } = require("node:os");
    const tempHome = resolve(mkdtempSync(join(tmpdir(), "prompt-onboard-")));
    mkdirSync(join(tempHome, "system"), { recursive: true });
    writeFileSync(
      join(tempHome, "system", "setup-plan.json"),
      JSON.stringify({
        role: "student",
        apps: [
          { name: "Study Planner", description: "Schedule" },
          { name: "Flashcards", description: "Cards" },
          { name: "Budget Tracker", description: "Budget" },
        ],
        skills: [],
        personality: { vibe: "casual", traits: [] },
        status: "building",
        built: ["Study Planner"],
      }),
    );

    const prompt = buildSystemPrompt(tempHome);
    expect(prompt).toContain("Onboarding Progress");
    expect(prompt).toContain("1/3 complete");
    expect(prompt).toContain("Flashcards");
    expect(prompt).toContain("Budget Tracker");

    rmSync(tempHome, { recursive: true, force: true });
  });

  it("does not include onboarding progress when plan is complete", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
    const { join, resolve } = require("node:path");
    const { tmpdir } = require("node:os");
    const tempHome = resolve(mkdtempSync(join(tmpdir(), "prompt-onboard2-")));
    mkdirSync(join(tempHome, "system"), { recursive: true });
    writeFileSync(
      join(tempHome, "system", "setup-plan.json"),
      JSON.stringify({
        role: "student",
        apps: [{ name: "Study Planner", description: "Schedule" }],
        skills: [],
        personality: { vibe: "casual", traits: [] },
        status: "complete",
        built: ["Study Planner"],
      }),
    );

    const prompt = buildSystemPrompt(tempHome);
    expect(prompt).not.toContain("Onboarding Progress");

    rmSync(tempHome, { recursive: true, force: true });
  });
});

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 characters", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75, ceil = 3
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles long text proportionally", () => {
    const text = "a".repeat(4000);
    expect(estimateTokens(text)).toBe(1000); // 4000 / 4 = 1000
  });
});
