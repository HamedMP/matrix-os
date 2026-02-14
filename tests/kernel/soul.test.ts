import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  loadSoul,
  loadIdentity,
  loadUser,
  loadBootstrap,
} from "../../packages/kernel/src/soul.js";

describe("T100a: SOUL + Identity system", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "soul-test-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("loadSoul", () => {
    it("returns soul content from file", () => {
      writeFileSync(
        join(homePath, "system", "soul.md"),
        "# Soul\n\nI am direct and helpful.",
      );
      const result = loadSoul(homePath);
      expect(result).toContain("I am direct and helpful");
    });

    it("returns empty string if file missing", () => {
      const result = loadSoul(homePath);
      expect(result).toBe("");
    });

    it("stays under 2000 chars", () => {
      const longContent = "x".repeat(5000);
      writeFileSync(join(homePath, "system", "soul.md"), longContent);
      const result = loadSoul(homePath);
      expect(result.length).toBeLessThanOrEqual(2000);
    });
  });

  describe("loadIdentity", () => {
    it("returns identity content from file", () => {
      writeFileSync(
        join(homePath, "system", "identity.md"),
        "# Identity\n\n- **Name:** Jarvis",
      );
      const result = loadIdentity(homePath);
      expect(result).toContain("Jarvis");
    });

    it("returns empty string if file missing", () => {
      const result = loadIdentity(homePath);
      expect(result).toBe("");
    });
  });

  describe("loadUser", () => {
    it("returns user profile content from file", () => {
      writeFileSync(
        join(homePath, "system", "user.md"),
        "# User\n\n- **Name:** Hamed\n- **Timezone:** Europe/Stockholm",
      );
      const result = loadUser(homePath);
      expect(result).toContain("Hamed");
      expect(result).toContain("Europe/Stockholm");
    });

    it("returns empty string if file missing", () => {
      const result = loadUser(homePath);
      expect(result).toBe("");
    });
  });

  describe("loadBootstrap", () => {
    it("returns bootstrap content when file exists", () => {
      writeFileSync(
        join(homePath, "system", "bootstrap.md"),
        "# Bootstrap\n\nWelcome! Let's set things up.",
      );
      const result = loadBootstrap(homePath);
      expect(result).toContain("Let's set things up");
    });

    it("returns empty string when bootstrap already deleted", () => {
      const result = loadBootstrap(homePath);
      expect(result).toBe("");
    });

    it("returns isFirstBoot=true when bootstrap exists", () => {
      writeFileSync(
        join(homePath, "system", "bootstrap.md"),
        "# Bootstrap\n\nHello world",
      );
      const result = loadBootstrap(homePath);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
