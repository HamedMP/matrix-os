import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  loadSkills,
  loadSkillBody,
  buildSkillsToc,
  clearSkillCache,
  ensureSdkSkillsMirror,
  type SkillDefinition,
} from "../../packages/kernel/src/skills.js";

describe("T100b: Skills system", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "skills-test-")));
    mkdirSync(join(homePath, "agents", "skills"), { recursive: true });
    clearSkillCache();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("loadSkills", () => {
    it("parses frontmatter from skill files", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "weather.md"),
        `---
name: weather
description: Look up current weather for any location
triggers:
  - weather
  - forecast
  - temperature
---

# Weather Lookup

When the user asks about weather, use WebSearch.`,
      );

      const skills = loadSkills(homePath);
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("weather");
      expect(skills[0].description).toBe(
        "Look up current weather for any location",
      );
      expect(skills[0].triggers).toEqual([
        "weather",
        "forecast",
        "temperature",
      ]);
    });

    it("returns empty array for empty directory", () => {
      const skills = loadSkills(homePath);
      expect(skills).toEqual([]);
    });

    it("returns empty array when skills directory missing", () => {
      rmSync(join(homePath, "agents", "skills"), {
        recursive: true,
        force: true,
      });
      const skills = loadSkills(homePath);
      expect(skills).toEqual([]);
    });

    it("handles malformed frontmatter gracefully", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "broken.md"),
        `This file has no frontmatter at all.`,
      );
      const skills = loadSkills(homePath);
      expect(skills).toEqual([]);
    });

    it("loads multiple skills", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "weather.md"),
        `---
name: weather
description: Weather lookup
triggers:
  - weather
---
# Weather`,
      );
      writeFileSync(
        join(homePath, "agents", "skills", "summarize.md"),
        `---
name: summarize
description: Summarize text
triggers:
  - summarize
  - tldr
---
# Summarize`,
      );

      const skills = loadSkills(homePath);
      expect(skills).toHaveLength(2);
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(["summarize", "weather"]);
    });

    it("skips non-md files", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "notes.txt"),
        "not a skill",
      );
      const skills = loadSkills(homePath);
      expect(skills).toEqual([]);
    });

    it("parses category, tools_needed, and channel_hints from frontmatter", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "web-search.md"),
        `---
name: web-search
description: Search the web
triggers:
  - search
  - google
category: productivity
tools_needed:
  - WebSearch
  - WebFetch
channel_hints:
  - any
---

# Web Search`,
      );

      const skills = loadSkills(homePath);
      expect(skills).toHaveLength(1);
      expect(skills[0].category).toBe("productivity");
      expect(skills[0].tools_needed).toEqual(["WebSearch", "WebFetch"]);
      expect(skills[0].channel_hints).toEqual(["any"]);
    });

    it("defaults category to utility when not specified", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "simple.md"),
        `---
name: simple
description: A simple skill
triggers:
  - simple
---

# Simple`,
      );

      const skills = loadSkills(homePath);
      expect(skills).toHaveLength(1);
      expect(skills[0].category).toBe("utility");
      expect(skills[0].tools_needed).toEqual([]);
      expect(skills[0].channel_hints).toEqual(["any"]);
    });
  });

  describe("loadSkillBody", () => {
    it("returns full file content for a named skill", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "weather.md"),
        `---
name: weather
description: Weather lookup
triggers:
  - weather
---

# Weather Lookup

Step 1: Search for weather.
Step 2: Format response.`,
      );

      const body = loadSkillBody(homePath, "weather");
      expect(body).toContain("Step 1: Search for weather");
      expect(body).toContain("Step 2: Format response");
    });

    it("returns null for unknown skill", () => {
      const body = loadSkillBody(homePath, "nonexistent");
      expect(body).toBeNull();
    });
  });

  describe("buildSkillsToc", () => {
    it("builds compact table of contents from skills", () => {
      const skills: SkillDefinition[] = [
        {
          name: "weather",
          description: "Weather lookup",
          triggers: ["weather", "forecast"],
          fileName: "weather.md",
          sourcePath: "/tmp/weather.md",
          format: "flat",
          category: "productivity",
          tools_needed: ["WebSearch"],
          channel_hints: ["any"],
          examples: [],
          composable_with: [],
        },
        {
          name: "summarize",
          description: "Summarize text",
          triggers: ["summarize", "tldr"],
          fileName: "summarize.md",
          sourcePath: "/tmp/summarize.md",
          format: "flat",
          category: "productivity",
          tools_needed: [],
          channel_hints: ["any"],
          examples: [],
          composable_with: [],
        },
      ];

      const toc = buildSkillsToc(skills);
      expect(toc).toContain("weather");
      expect(toc).toContain("summarize");
      expect(toc).toContain("Weather lookup");
      expect(toc).toContain("Summarize text");
    });

    it("returns empty string for no skills", () => {
      const toc = buildSkillsToc([]);
      expect(toc).toBe("");
    });
  });

  describe("directory format (.agents/skills/<name>/SKILL.md)", () => {
    it("loads a skill from .agents/skills/<name>/SKILL.md", () => {
      const dir = join(homePath, ".agents", "skills", "roll-dice");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---
name: roll-dice
description: Roll dice using a random number generator
---

Echo a random number between 1 and the number of sides.`,
      );

      const skills = loadSkills(homePath);
      const rollDice = skills.find((s) => s.name === "roll-dice");
      expect(rollDice).toBeDefined();
      expect(rollDice?.description).toBe(
        "Roll dice using a random number generator",
      );
      expect(rollDice?.format).toBe("directory");
      expect(rollDice?.sourcePath).toBe(join(dir, "SKILL.md"));
    });

    it("accepts minimal standard frontmatter (name + description only)", () => {
      const dir = join(homePath, ".agents", "skills", "standard-only");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---
name: standard-only
description: A skill with only the open standard required fields
---

Body.`,
      );

      const skills = loadSkills(homePath);
      const skill = skills.find((s) => s.name === "standard-only");
      expect(skill).toBeDefined();
      expect(skill?.triggers).toEqual([]);
      expect(skill?.category).toBe("utility");
      expect(skill?.channel_hints).toEqual(["any"]);
      expect(skill?.composable_with).toEqual([]);
    });

    it("preserves Matrix extensions alongside standard fields", () => {
      const dir = join(homePath, ".agents", "skills", "full-frontmatter");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---
name: full-frontmatter
description: A skill exercising every Matrix extension
triggers:
  - trigger-one
  - trigger-two
category: builder
tools_needed:
  - Read
channel_hints:
  - web
  - telegram
examples:
  - example one
composable_with:
  - other-skill
---

Body here.`,
      );

      const skills = loadSkills(homePath);
      const skill = skills.find((s) => s.name === "full-frontmatter");
      expect(skill?.triggers).toEqual(["trigger-one", "trigger-two"]);
      expect(skill?.category).toBe("builder");
      expect(skill?.channel_hints).toEqual(["web", "telegram"]);
      expect(skill?.composable_with).toEqual(["other-skill"]);
    });

    it("scans .claude/skills/<name>/SKILL.md for third-party skills", () => {
      const dir = join(homePath, ".claude", "skills", "third-party");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---
name: third-party
description: A skill installed directly into .claude/skills
---

Body.`,
      );

      const skills = loadSkills(homePath);
      const skill = skills.find((s) => s.name === "third-party");
      expect(skill).toBeDefined();
      expect(skill?.format).toBe("directory");
    });

    it("loadSkillBody returns body from directory format", () => {
      const dir = join(homePath, ".agents", "skills", "body-test");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        `---
name: body-test
description: Test body retrieval
---

The body contains a secret marker: XYZZY123.`,
      );

      const body = loadSkillBody(homePath, "body-test");
      expect(body).toContain("XYZZY123");
    });
  });

  describe("precedence across locations", () => {
    it(".agents/skills wins over legacy flat for the same name", () => {
      writeFileSync(
        join(homePath, "agents", "skills", "weather.md"),
        `---
name: weather
description: Legacy weather skill
triggers: [old]
---
Legacy body.`,
      );
      const newDir = join(homePath, ".agents", "skills", "weather");
      mkdirSync(newDir, { recursive: true });
      writeFileSync(
        join(newDir, "SKILL.md"),
        `---
name: weather
description: New weather skill
triggers: [new]
---
New body with marker: ALPHA999.`,
      );

      const skills = loadSkills(homePath);
      const weather = skills.filter((s) => s.name === "weather");
      expect(weather).toHaveLength(1);
      expect(weather[0].description).toBe("New weather skill");
      expect(weather[0].format).toBe("directory");

      const body = loadSkillBody(homePath, "weather");
      expect(body).toContain("ALPHA999");
      expect(body).not.toContain("Legacy body");
    });

    it(".agents/skills wins over .claude/skills for the same name", () => {
      const canonDir = join(homePath, ".agents", "skills", "conflict");
      mkdirSync(canonDir, { recursive: true });
      writeFileSync(
        join(canonDir, "SKILL.md"),
        `---
name: conflict
description: Canonical
---
Canonical body.`,
      );
      const claudeDir = join(homePath, ".claude", "skills", "conflict");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "SKILL.md"),
        `---
name: conflict
description: Claude-side third-party
---
Third-party body.`,
      );

      const skills = loadSkills(homePath);
      const conflict = skills.filter((s) => s.name === "conflict");
      expect(conflict).toHaveLength(1);
      expect(conflict[0].description).toBe("Canonical");
    });

    it("dedupes symlinked mirror entries against canonical", () => {
      const canonDir = join(homePath, ".agents", "skills", "mirrored");
      mkdirSync(canonDir, { recursive: true });
      writeFileSync(
        join(canonDir, "SKILL.md"),
        `---
name: mirrored
description: Canonical with mirror symlink
---
Body.`,
      );
      mkdirSync(join(homePath, ".claude", "skills"), { recursive: true });
      symlinkSync(
        "../../.agents/skills/mirrored",
        join(homePath, ".claude", "skills", "mirrored"),
        "dir",
      );

      const skills = loadSkills(homePath);
      const mirrored = skills.filter((s) => s.name === "mirrored");
      expect(mirrored).toHaveLength(1);
    });
  });

  describe("ensureSdkSkillsMirror", () => {
    it("creates .claude/skills symlinks to .agents/skills entries", () => {
      const canonDir = join(homePath, ".agents", "skills", "alpha");
      mkdirSync(canonDir, { recursive: true });
      writeFileSync(
        join(canonDir, "SKILL.md"),
        `---
name: alpha
description: Alpha skill
---
Body.`,
      );

      ensureSdkSkillsMirror(homePath);

      const mirrored = join(homePath, ".claude", "skills", "alpha");
      expect(existsSync(mirrored)).toBe(true);
      expect(lstatSync(mirrored).isSymbolicLink()).toBe(true);
      expect(realpathSync(mirrored)).toBe(realpathSync(canonDir));
    });

    it("is idempotent -- second call is a no-op", () => {
      const canonDir = join(homePath, ".agents", "skills", "beta");
      mkdirSync(canonDir, { recursive: true });
      writeFileSync(
        join(canonDir, "SKILL.md"),
        `---
name: beta
description: Beta
---
Body.`,
      );

      ensureSdkSkillsMirror(homePath);
      const firstTarget = readlinkSync(
        join(homePath, ".claude", "skills", "beta"),
      );
      ensureSdkSkillsMirror(homePath);
      const secondTarget = readlinkSync(
        join(homePath, ".claude", "skills", "beta"),
      );
      expect(secondTarget).toBe(firstTarget);
    });

    it("does not overwrite an existing non-symlink directory in .claude/skills", () => {
      const canonDir = join(homePath, ".agents", "skills", "gamma");
      mkdirSync(canonDir, { recursive: true });
      writeFileSync(
        join(canonDir, "SKILL.md"),
        `---
name: gamma
description: Gamma canonical
---
Canonical body.`,
      );
      const claudeDir = join(homePath, ".claude", "skills", "gamma");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "SKILL.md"),
        `---
name: gamma
description: Third-party gamma
---
Third-party body.`,
      );

      ensureSdkSkillsMirror(homePath);

      expect(lstatSync(claudeDir).isSymbolicLink()).toBe(false);
      expect(lstatSync(claudeDir).isDirectory()).toBe(true);
    });

    it("refuses to run if .agents/skills does not exist", () => {
      expect(() => ensureSdkSkillsMirror(homePath)).not.toThrow();
      expect(existsSync(join(homePath, ".claude", "skills"))).toBe(false);
    });
  });
});
