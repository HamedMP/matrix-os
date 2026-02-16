import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt, estimateTokens } from "../../packages/kernel/src/prompt.js";
import { createDB, type MatrixDB } from "../../packages/kernel/src/db.js";
import { createTask, claimTask } from "../../packages/kernel/src/ipc.js";

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

describe("T216: Handle setup nudge", () => {
  let tempHome: string;

  afterEach(() => {
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it("does not nudge handle setup when handle is empty (handle set before entering OS)", () => {
    tempHome = resolve(mkdtempSync(join(tmpdir(), "prompt-handle-")));
    mkdirSync(join(tempHome, "system"), { recursive: true });
    writeFileSync(
      join(tempHome, "system", "handle.json"),
      JSON.stringify({ handle: "", aiHandle: "", displayName: "", createdAt: "" }),
    );

    const prompt = buildSystemPrompt(tempHome);
    expect(prompt).not.toContain("set_handle");
    expect(prompt).not.toContain("@:matrix-os.com");
  });

  it("includes handle identity when handle is set", () => {
    tempHome = resolve(mkdtempSync(join(tmpdir(), "prompt-handle2-")));
    mkdirSync(join(tempHome, "system"), { recursive: true });
    writeFileSync(
      join(tempHome, "system", "handle.json"),
      JSON.stringify({ handle: "hamed", aiHandle: "hamed_ai", displayName: "Hamed", createdAt: "2026-01-01" }),
    );

    const prompt = buildSystemPrompt(tempHome);
    expect(prompt).toContain("@hamed_ai:matrix-os.com");
    expect(prompt).not.toContain("set_handle");
  });
});

describe("T056: Active processes in prompt", () => {
  let tempHome: string;
  let db: MatrixDB;

  beforeEach(() => {
    tempHome = resolve(mkdtempSync(join(tmpdir(), "prompt-proc-")));
    mkdirSync(join(tempHome, "system"), { recursive: true });
    db = createDB(join(tempHome, "system", "matrix.db"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("includes active processes section when db has running kernels", () => {
    const id = createTask(db, { type: "kernel", input: { message: "Build a CRM" } });
    claimTask(db, id, "dispatcher");

    const prompt = buildSystemPrompt(tempHome, db);
    expect(prompt).toContain("## Active Processes");
    expect(prompt).toContain("Build a CRM");
  });

  it("adds concurrency warning when 3+ processes active", () => {
    for (const msg of ["task-1", "task-2", "task-3"]) {
      const id = createTask(db, { type: "kernel", input: { message: msg } });
      claimTask(db, id, "dispatcher");
    }

    const prompt = buildSystemPrompt(tempHome, db);
    expect(prompt).toContain("3+ kernels running");
  });

  it("omits process section when no db provided", () => {
    const prompt = buildSystemPrompt(tempHome);
    expect(prompt).not.toContain("Active Processes");
  });

  it("omits process section when no active processes", () => {
    const prompt = buildSystemPrompt(tempHome, db);
    expect(prompt).not.toContain("Active Processes");
  });

  it("excludes non-kernel tasks from process list", () => {
    const id = createTask(db, { type: "build", input: { message: "make widget" } });
    claimTask(db, id, "builder");

    const prompt = buildSystemPrompt(tempHome, db);
    expect(prompt).not.toContain("Active Processes");
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
