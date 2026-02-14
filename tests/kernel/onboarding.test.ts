import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  parseSetupPlan,
  writeSetupPlan,
  getPersonaSuggestions,
  type SetupPlan,
} from "../../packages/kernel/src/onboarding.js";

describe("T400a: Setup plan parsing", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "onboarding-test-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("parseSetupPlan", () => {
    it("reads and parses setup-plan.json", () => {
      const plan: SetupPlan = {
        role: "student",
        apps: [
          { name: "Study Planner", description: "Weekly schedule with deadlines" },
        ],
        skills: [
          { name: "summarize", description: "Summarize papers and notes" },
        ],
        personality: { vibe: "casual", traits: ["encouraging", "clear"] },
        status: "pending",
        built: [],
      };
      writeFileSync(
        join(homePath, "system", "setup-plan.json"),
        JSON.stringify(plan),
      );

      const result = parseSetupPlan(homePath);
      expect(result).not.toBeNull();
      expect(result!.role).toBe("student");
      expect(result!.apps).toHaveLength(1);
      expect(result!.apps[0].name).toBe("Study Planner");
      expect(result!.skills).toHaveLength(1);
      expect(result!.status).toBe("pending");
      expect(result!.built).toEqual([]);
    });

    it("returns null when file missing", () => {
      const result = parseSetupPlan(homePath);
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      writeFileSync(
        join(homePath, "system", "setup-plan.json"),
        "not valid json {{{",
      );
      const result = parseSetupPlan(homePath);
      expect(result).toBeNull();
    });

    it("returns null for JSON missing required fields", () => {
      writeFileSync(
        join(homePath, "system", "setup-plan.json"),
        JSON.stringify({ role: "student" }),
      );
      const result = parseSetupPlan(homePath);
      expect(result).toBeNull();
    });

    it("preserves optional customDescription", () => {
      const plan: SetupPlan = {
        role: "student",
        customDescription: "CS sophomore at MIT",
        apps: [],
        skills: [],
        personality: { vibe: "casual", traits: [] },
        status: "pending",
        built: [],
      };
      writeFileSync(
        join(homePath, "system", "setup-plan.json"),
        JSON.stringify(plan),
      );

      const result = parseSetupPlan(homePath);
      expect(result!.customDescription).toBe("CS sophomore at MIT");
    });

    it("parses all valid status values", () => {
      for (const status of ["pending", "building", "complete"] as const) {
        const plan: SetupPlan = {
          role: "developer",
          apps: [],
          skills: [],
          personality: { vibe: "concise", traits: [] },
          status,
          built: [],
        };
        writeFileSync(
          join(homePath, "system", "setup-plan.json"),
          JSON.stringify(plan),
        );
        const result = parseSetupPlan(homePath);
        expect(result!.status).toBe(status);
      }
    });
  });

  describe("writeSetupPlan", () => {
    it("writes plan to setup-plan.json", () => {
      const plan: SetupPlan = {
        role: "developer",
        apps: [{ name: "Project Board", description: "Kanban board" }],
        skills: [{ name: "code-review", description: "Review code" }],
        personality: { vibe: "concise", traits: ["technical"] },
        status: "pending",
        built: [],
      };

      writeSetupPlan(homePath, plan);
      const result = parseSetupPlan(homePath);
      expect(result).not.toBeNull();
      expect(result!.role).toBe("developer");
      expect(result!.apps[0].name).toBe("Project Board");
    });

    it("overwrites existing plan", () => {
      const plan1: SetupPlan = {
        role: "student",
        apps: [],
        skills: [],
        personality: { vibe: "casual", traits: [] },
        status: "pending",
        built: [],
      };
      const plan2: SetupPlan = {
        role: "developer",
        apps: [{ name: "IDE", description: "Code editor" }],
        skills: [],
        personality: { vibe: "concise", traits: [] },
        status: "building",
        built: [],
      };

      writeSetupPlan(homePath, plan1);
      writeSetupPlan(homePath, plan2);
      const result = parseSetupPlan(homePath);
      expect(result!.role).toBe("developer");
      expect(result!.status).toBe("building");
    });
  });
});

describe("T400b: Persona suggestions", () => {
  describe("getPersonaSuggestions", () => {
    it("returns apps and skills for student", () => {
      const result = getPersonaSuggestions("student");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
      expect(result.skills.length).toBeGreaterThanOrEqual(1);
      expect(result.personality.traits.length).toBeGreaterThan(0);
      expect(result.apps.every((a) => a.name && a.description)).toBe(true);
    });

    it("returns apps and skills for developer", () => {
      const result = getPersonaSuggestions("developer");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
      expect(result.skills.length).toBeGreaterThanOrEqual(1);
    });

    it("returns apps and skills for investor", () => {
      const result = getPersonaSuggestions("investor");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns apps and skills for entrepreneur", () => {
      const result = getPersonaSuggestions("entrepreneur");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns apps and skills for parent", () => {
      const result = getPersonaSuggestions("parent");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns apps and skills for creative", () => {
      const result = getPersonaSuggestions("creative");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns apps and skills for researcher", () => {
      const result = getPersonaSuggestions("researcher");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns sensible defaults for unknown roles", () => {
      const result = getPersonaSuggestions("beekeeper");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
      expect(result.skills.length).toBeGreaterThanOrEqual(1);
      expect(result.personality.vibe).toBeTruthy();
    });

    it("is case-insensitive", () => {
      const lower = getPersonaSuggestions("student");
      const upper = getPersonaSuggestions("Student");
      const mixed = getPersonaSuggestions("STUDENT");
      expect(lower.apps.length).toBe(upper.apps.length);
      expect(lower.apps.length).toBe(mixed.apps.length);
    });

    it("matches partial role names", () => {
      const result = getPersonaSuggestions("software developer");
      expect(result.apps.length).toBeGreaterThanOrEqual(2);
      // Should match the developer persona
      expect(result.apps.some((a) => a.name.toLowerCase().includes("project") || a.name.toLowerCase().includes("code") || a.name.toLowerCase().includes("snippet"))).toBe(true);
    });

    it("all known roles have distinct suggestions", () => {
      const roles = ["student", "developer", "investor", "entrepreneur", "parent", "creative", "researcher"];
      const appSets = roles.map((r) => {
        const s = getPersonaSuggestions(r);
        return s.apps.map((a) => a.name).sort().join(",");
      });
      const unique = new Set(appSets);
      expect(unique.size).toBe(roles.length);
    });
  });
});
