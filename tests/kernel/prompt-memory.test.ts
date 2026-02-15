import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt, estimateTokens } from "../../packages/kernel/src/prompt.js";
import { createDB, type MatrixDB } from "../../packages/kernel/src/db.js";
import { createMemoryStore } from "../../packages/kernel/src/memory.js";

describe("System prompt memory integration", () => {
  let tempHome: string;
  let db: MatrixDB;

  beforeEach(() => {
    tempHome = resolve(mkdtempSync(join(tmpdir(), "prompt-memory-")));
    mkdirSync(join(tempHome, "system"), { recursive: true });
    db = createDB(join(tempHome, "system", "matrix.db"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("includes relevant memories section when memories exist", () => {
    const store = createMemoryStore(db);
    store.remember("User prefers dark themes", { category: "preference" });
    store.remember("User lives in Stockholm", { category: "fact" });

    const prompt = buildSystemPrompt(tempHome, db);
    expect(prompt).toContain("## Relevant Memories");
    expect(prompt).toContain("dark themes");
  });

  it("omits memory section when no memories exist", () => {
    createMemoryStore(db);

    const prompt = buildSystemPrompt(tempHome, db);
    expect(prompt).not.toContain("## Relevant Memories");
  });

  it("memory section stays within token budget", () => {
    const store = createMemoryStore(db);
    for (let i = 0; i < 50; i++) {
      store.remember(`Memory fact number ${i}: ${"x".repeat(100)}`, {
        category: "fact",
      });
    }

    const prompt = buildSystemPrompt(tempHome, db);
    const memorySection = prompt.split("## Relevant Memories")[1]?.split("\n##")[0] ?? "";
    const memoryTokens = estimateTokens(memorySection);
    expect(memoryTokens).toBeLessThanOrEqual(300);
  });

  it("overall prompt stays under 7K tokens", () => {
    const store = createMemoryStore(db);
    for (let i = 0; i < 20; i++) {
      store.remember(`User preference ${i}: always do X`, { category: "preference" });
    }

    const prompt = buildSystemPrompt(tempHome, db);
    expect(estimateTokens(prompt)).toBeLessThan(7000);
  });

  it("formats memories with category labels", () => {
    const store = createMemoryStore(db);
    store.remember("User prefers dark themes", { category: "preference" });
    store.remember("User timezone is CET", { category: "fact" });

    const prompt = buildSystemPrompt(tempHome, db);
    expect(prompt).toContain("[preference]");
    expect(prompt).toContain("[fact]");
  });
});
