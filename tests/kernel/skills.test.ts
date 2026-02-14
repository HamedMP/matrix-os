import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  loadSkills,
  loadSkillBody,
  buildSkillsToc,
  type SkillDefinition,
} from "../../packages/kernel/src/skills.js";

describe("T100b: Skills system", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "skills-test-")));
    mkdirSync(join(homePath, "agents", "skills"), { recursive: true });
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
        },
        {
          name: "summarize",
          description: "Summarize text",
          triggers: ["summarize", "tldr"],
          fileName: "summarize.md",
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
});
