import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  loadSkills,
  loadSkillBody,
  clearSkillCache,
  getKnowledge,
  cacheKnowledgeFiles,
  clearKnowledgeCache,
  type SkillDefinition,
} from "../../packages/kernel/src/skills.js";

describe("T1300: Skill frontmatter Zod schema validation", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "skills-val-")));
    mkdirSync(join(homePath, "agents", "skills"), { recursive: true });
    clearSkillCache();
    clearKnowledgeCache();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("validates and loads skill with all required fields", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "valid.md"),
      `---
name: valid-skill
description: A valid skill
triggers:
  - test
---

# Valid Skill`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("valid-skill");
  });

  it("rejects skill missing name field with warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      join(homePath, "agents", "skills", "no-name.md"),
      `---
description: Missing name
triggers:
  - test
---

# No Name`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no-name.md"),
    );
    warn.mockRestore();
  });

  it("rejects skill missing description field with warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      join(homePath, "agents", "skills", "no-desc.md"),
      `---
name: no-desc
triggers:
  - test
---

# No Desc`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no-desc.md"),
    );
    warn.mockRestore();
  });

  it("handles malformed YAML gracefully (skip file, log warning)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(
      join(homePath, "agents", "skills", "broken.md"),
      `This file has no frontmatter at all.`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(0);
    warn.mockRestore();
  });

  it("validates optional fields have correct types", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "typed.md"),
      `---
name: typed-skill
description: Typed skill
triggers:
  - type
category: productivity
tools_needed:
  - WebSearch
channel_hints:
  - web
  - telegram
---

# Typed`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(1);
    expect(skills[0].category).toBe("productivity");
    expect(skills[0].tools_needed).toEqual(["WebSearch"]);
    expect(skills[0].channel_hints).toEqual(["web", "telegram"]);
  });

  it("parses new examples field (string[])", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "with-examples.md"),
      `---
name: with-examples
description: Skill with examples
triggers:
  - build
examples:
  - build me a todo app
  - create a calculator
---

# Examples`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(1);
    expect(skills[0].examples).toEqual([
      "build me a todo app",
      "create a calculator",
    ]);
  });

  it("parses new composable_with field (string[])", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "composable.md"),
      `---
name: composable
description: Composable skill
triggers:
  - compose
composable_with:
  - app-builder
  - theme-integration
---

# Composable`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(1);
    expect(skills[0].composable_with).toEqual([
      "app-builder",
      "theme-integration",
    ]);
  });

  it("defaults examples and composable_with to empty arrays", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "defaults.md"),
      `---
name: defaults
description: Default values
triggers:
  - default
---

# Defaults`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(1);
    expect(skills[0].examples).toEqual([]);
    expect(skills[0].composable_with).toEqual([]);
  });

  it("backward compatible: existing skills without new fields still load", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "legacy.md"),
      `---
name: legacy
description: Old style skill
triggers:
  - old
category: utility
tools_needed:
  - Read
channel_hints:
  - any
---

# Legacy`,
    );

    const skills = loadSkills(homePath);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("legacy");
    expect(skills[0].examples).toEqual([]);
    expect(skills[0].composable_with).toEqual([]);
  });
});

describe("T1301: Skill memory cache", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "skills-cache-")));
    mkdirSync(join(homePath, "agents", "skills"), { recursive: true });
    clearSkillCache();
    clearKnowledgeCache();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("caches skill body after first load", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "cached.md"),
      `---
name: cached
description: Cached skill
triggers:
  - cache
---

# Cached Skill Body`,
    );

    const body1 = loadSkillBody(homePath, "cached");
    expect(body1).toContain("Cached Skill Body");

    writeFileSync(
      join(homePath, "agents", "skills", "cached.md"),
      `---
name: cached
description: Cached skill
triggers:
  - cache
---

# Modified Body`,
    );

    const body2 = loadSkillBody(homePath, "cached");
    expect(body2).toContain("Cached Skill Body");
  });

  it("returns fresh content after cache clear", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "refresh.md"),
      `---
name: refresh
description: Refresh skill
triggers:
  - refresh
---

# Original Body`,
    );

    loadSkillBody(homePath, "refresh");
    clearSkillCache();

    writeFileSync(
      join(homePath, "agents", "skills", "refresh.md"),
      `---
name: refresh
description: Refresh skill
triggers:
  - refresh
---

# Updated Body`,
    );

    const body = loadSkillBody(homePath, "refresh");
    expect(body).toContain("Updated Body");
  });

  it("loadSkills pre-caches skill bodies", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "precache.md"),
      `---
name: precache
description: Pre-cached
triggers:
  - pre
---

# Pre-cached Body`,
    );

    loadSkills(homePath);

    writeFileSync(
      join(homePath, "agents", "skills", "precache.md"),
      `---
name: precache
description: Pre-cached
triggers:
  - pre
---

# Changed after load`,
    );

    const body = loadSkillBody(homePath, "precache");
    expect(body).toContain("Pre-cached Body");
  });
});

describe("T1302: Knowledge file caching", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "knowledge-cache-")));
    mkdirSync(join(homePath, "agents", "knowledge"), { recursive: true });
    clearSkillCache();
    clearKnowledgeCache();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("caches knowledge files at boot", () => {
    writeFileSync(
      join(homePath, "agents", "knowledge", "app-generation.md"),
      "# App Generation\nTemplates go here.",
    );

    cacheKnowledgeFiles(homePath);
    const content = getKnowledge("app-generation");
    expect(content).toContain("App Generation");
    expect(content).toContain("Templates go here.");
  });

  it("returns null for unknown knowledge file", () => {
    cacheKnowledgeFiles(homePath);
    const content = getKnowledge("nonexistent");
    expect(content).toBeNull();
  });

  it("serves from cache on subsequent calls", () => {
    writeFileSync(
      join(homePath, "agents", "knowledge", "test.md"),
      "# Original",
    );

    cacheKnowledgeFiles(homePath);

    writeFileSync(
      join(homePath, "agents", "knowledge", "test.md"),
      "# Modified",
    );

    const content = getKnowledge("test");
    expect(content).toContain("Original");
  });

  it("clearKnowledgeCache forces re-read", () => {
    writeFileSync(
      join(homePath, "agents", "knowledge", "mutable.md"),
      "# Version 1",
    );

    cacheKnowledgeFiles(homePath);
    clearKnowledgeCache();

    writeFileSync(
      join(homePath, "agents", "knowledge", "mutable.md"),
      "# Version 2",
    );

    cacheKnowledgeFiles(homePath);
    const content = getKnowledge("mutable");
    expect(content).toContain("Version 2");
  });

  it("handles missing knowledge directory gracefully", () => {
    rmSync(join(homePath, "agents", "knowledge"), {
      recursive: true,
      force: true,
    });
    cacheKnowledgeFiles(homePath);
    const content = getKnowledge("anything");
    expect(content).toBeNull();
  });
});

describe("T1303: Composable skill loading", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "composable-")));
    mkdirSync(join(homePath, "agents", "skills"), { recursive: true });
    clearSkillCache();
    clearKnowledgeCache();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("loads companion skills from composable_with field", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "build-react-app.md"),
      `---
name: build-react-app
description: React app builder
triggers:
  - react
composable_with:
  - app-builder
---

# React App`,
    );
    writeFileSync(
      join(homePath, "agents", "skills", "app-builder.md"),
      `---
name: app-builder
description: General app builder
triggers:
  - build
---

# App Builder Body`,
    );

    const skills = loadSkills(homePath);
    const { bodies } = loadComposableSkills(homePath, "build-react-app", skills);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("React App");
    expect(bodies[1]).toContain("App Builder Body");
  });

  it("prevents circular loading", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "skill-a.md"),
      `---
name: skill-a
description: Skill A
triggers:
  - a
composable_with:
  - skill-b
---

# A`,
    );
    writeFileSync(
      join(homePath, "agents", "skills", "skill-b.md"),
      `---
name: skill-b
description: Skill B
triggers:
  - b
composable_with:
  - skill-a
---

# B`,
    );

    const skills = loadSkills(homePath);
    const { bodies } = loadComposableSkills(homePath, "skill-a", skills);
    expect(bodies).toHaveLength(2);
  });

  it("returns only primary skill when no composable_with", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "standalone.md"),
      `---
name: standalone
description: Standalone skill
triggers:
  - alone
---

# Standalone`,
    );

    const skills = loadSkills(homePath);
    const { bodies } = loadComposableSkills(homePath, "standalone", skills);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Standalone");
  });

  it("skips missing companion skills gracefully", () => {
    writeFileSync(
      join(homePath, "agents", "skills", "partial.md"),
      `---
name: partial
description: Partial composable
triggers:
  - partial
composable_with:
  - nonexistent-skill
---

# Partial`,
    );

    const skills = loadSkills(homePath);
    const { bodies } = loadComposableSkills(homePath, "partial", skills);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Partial");
  });
});

import { loadComposableSkills } from "../../packages/kernel/src/skills.js";
