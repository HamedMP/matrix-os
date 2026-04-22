import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSkillRegistry,
  type SkillRegistryEntry,
} from "@matrix-os/kernel/skill-registry";

const TEST_HOME = join(tmpdir(), `matrix-skill-store-${Date.now()}`);
const SKILLS_DIR = join(TEST_HOME, "agents", "skills");
const REGISTRY_PATH = join(TEST_HOME, "system", "skill-registry.json");

function writeSkillFile(name: string, content: string) {
  writeFileSync(join(SKILLS_DIR, `${name}.md`), content, "utf-8");
}

const SAMPLE_SKILL = `---
name: test-skill
description: A test skill
triggers:
  - test
  - testing
category: utility
tools_needed:
  - Read
channel_hints:
  - web
examples:
  - run tests
composable_with: []
---

# Test Skill

This is the body of the test skill.
`;

const ANOTHER_SKILL = `---
name: another-skill
description: Another skill for testing
triggers:
  - another
category: builder
tools_needed:
  - Write
channel_hints:
  - any
examples:
  - build another thing
composable_with:
  - test-skill
---

# Another Skill

Body of the other skill.
`;

beforeEach(() => {
  mkdirSync(SKILLS_DIR, { recursive: true });
  mkdirSync(join(TEST_HOME, "system"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("T1450-T1454: Skill registry", () => {
  it("creates a registry from a home path", async () => {
    const registry = await createSkillRegistry(TEST_HOME);
    expect(registry).toBeDefined();
    expect(typeof registry.publish).toBe("function");
    expect(typeof registry.install).toBe("function");
    expect(typeof registry.list).toBe("function");
    expect(typeof registry.get).toBe("function");
  });

  it("list returns empty array when no skills published", async () => {
    const registry = await createSkillRegistry(TEST_HOME);
    expect(registry.list()).toEqual([]);
  });

  describe("publish_skill", () => {
    it("publishes a local skill file to registry", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      const entry = await registry.publish("test-skill");
      expect(entry.name).toBe("test-skill");
      expect(entry.description).toBe("A test skill");
      expect(entry.version).toBe("1.0.0");
      expect(entry.author).toBeDefined();
      expect(entry.category).toBe("utility");
    });

    it("persists registry to disk as JSON", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      await registry.publish("test-skill");
      expect(existsSync(REGISTRY_PATH)).toBe(true);
      const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
      expect(data.skills).toHaveLength(1);
      expect(data.skills[0].name).toBe("test-skill");
    });

    it("updates existing entry when republished", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      await registry.publish("test-skill");
      await registry.publish("test-skill");
      expect(registry.list()).toHaveLength(1);
    });

    it("increments version on republish", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      const first = await registry.publish("test-skill");
      expect(first.version).toBe("1.0.0");
      const second = await registry.publish("test-skill");
      expect(second.version).toBe("1.0.1");
    });

    it("throws if skill file not found", async () => {
      const registry = await createSkillRegistry(TEST_HOME);
      await expect(registry.publish("nonexistent")).rejects.toThrow(/not found/i);
    });

    it("stores content hash", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      const entry = await registry.publish("test-skill");
      expect(entry.contentHash).toBeDefined();
      expect(entry.contentHash.length).toBeGreaterThan(0);
    });

    it("publishes multiple skills", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      writeSkillFile("another-skill", ANOTHER_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      await registry.publish("test-skill");
      await registry.publish("another-skill");
      expect(registry.list()).toHaveLength(2);
    });
  });

  describe("install_skill", () => {
    it("installs skill from registry to skills dir", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const sourceRegistry = await createSkillRegistry(TEST_HOME);
      await sourceRegistry.publish("test-skill");

      // Simulate install target (different home with no skill file)
      const targetHome = join(tmpdir(), `matrix-target-${Date.now()}`);
      const targetSkills = join(targetHome, "agents", "skills");
      const targetSystem = join(targetHome, "system");
      mkdirSync(targetSkills, { recursive: true });
      mkdirSync(targetSystem, { recursive: true });

      // Copy registry to target to simulate remote registry
      writeFileSync(
        join(targetSystem, "skill-registry.json"),
        readFileSync(REGISTRY_PATH, "utf-8"),
      );

      const targetRegistry = await createSkillRegistry(targetHome);
      const result = await targetRegistry.install("test-skill");
      expect(result.installed).toBe(true);
      expect(existsSync(join(targetSkills, "test-skill.md"))).toBe(true);

      rmSync(targetHome, { recursive: true, force: true });
    });

    it("returns installed=false for unknown skill", async () => {
      const registry = await createSkillRegistry(TEST_HOME);
      const result = await registry.install("nonexistent");
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/not found/i);
    });

    it("detects duplicate install", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      await registry.publish("test-skill");
      const result = await registry.install("test-skill");
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/already installed/i);
    });
  });

  describe("get", () => {
    it("returns entry by name", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      await registry.publish("test-skill");
      const entry = registry.get("test-skill");
      expect(entry).toBeDefined();
      expect(entry!.name).toBe("test-skill");
    });

    it("returns null for unknown skill", async () => {
      const registry = await createSkillRegistry(TEST_HOME);
      expect(registry.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all published skills", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      writeSkillFile("another-skill", ANOTHER_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      await registry.publish("test-skill");
      await registry.publish("another-skill");
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map((s: SkillRegistryEntry) => s.name).sort()).toEqual([
        "another-skill",
        "test-skill",
      ]);
    });

    it("filters by category", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      writeSkillFile("another-skill", ANOTHER_SKILL);
      const registry = await createSkillRegistry(TEST_HOME);
      await registry.publish("test-skill");
      await registry.publish("another-skill");
      const builders = registry.list("builder");
      expect(builders).toHaveLength(1);
      expect(builders[0].name).toBe("another-skill");
    });
  });

  describe("persistence", () => {
    it("loads registry from disk on init", async () => {
      writeSkillFile("test-skill", SAMPLE_SKILL);
      const r1 = await createSkillRegistry(TEST_HOME);
      await r1.publish("test-skill");

      const r2 = await createSkillRegistry(TEST_HOME);
      expect(r2.list()).toHaveLength(1);
      expect(r2.get("test-skill")!.name).toBe("test-skill");
    });

    it("handles missing registry file gracefully", async () => {
      const registry = await createSkillRegistry(TEST_HOME);
      expect(registry.list()).toEqual([]);
    });

    it("handles corrupt registry file gracefully", async () => {
      writeFileSync(REGISTRY_PATH, "not json");
      const registry = await createSkillRegistry(TEST_HOME);
      expect(registry.list()).toEqual([]);
    });
  });
});
