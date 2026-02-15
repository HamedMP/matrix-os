import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  loadAppMeta,
  type AppMeta,
} from "../../packages/kernel/src/app-meta.js";

describe("T710: App metadata (matrix.md)", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "app-meta-test-")));
    mkdirSync(join(homePath, "apps"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  describe("loadAppMeta", () => {
    it("parses matrix.md frontmatter for single-file app", () => {
      writeFileSync(
        join(homePath, "apps", "expense-tracker.html"),
        "<html></html>",
      );
      writeFileSync(
        join(homePath, "apps", "expense-tracker.matrix.md"),
        `---
name: Expense Tracker
description: Track daily expenses and budgets
icon: $
category: productivity
theme_accent: #4CAF50
data_dir: ~/data/expense-tracker/
author: system
version: 1.0
---

Additional notes about the app.`,
      );

      const meta = loadAppMeta(
        join(homePath, "apps"),
        "expense-tracker.html",
      );
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("Expense Tracker");
      expect(meta!.description).toBe("Track daily expenses and budgets");
      expect(meta!.icon).toBe("$");
      expect(meta!.category).toBe("productivity");
      expect(meta!.theme_accent).toBe("#4CAF50");
      expect(meta!.data_dir).toBe("~/data/expense-tracker/");
      expect(meta!.author).toBe("system");
      expect(meta!.version).toBe("1");
    });

    it("parses matrix.md from directory-based app", () => {
      mkdirSync(join(homePath, "apps", "my-app"), { recursive: true });
      writeFileSync(
        join(homePath, "apps", "my-app", "matrix.md"),
        `---
name: My App
description: A test app
category: utility
---`,
      );

      const meta = loadAppMeta(join(homePath, "apps"), "my-app");
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("My App");
      expect(meta!.description).toBe("A test app");
      expect(meta!.category).toBe("utility");
    });

    it("returns defaults when no matrix.md exists", () => {
      writeFileSync(
        join(homePath, "apps", "simple.html"),
        "<html></html>",
      );

      const meta = loadAppMeta(join(homePath, "apps"), "simple.html");
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("simple");
      expect(meta!.description).toBeUndefined();
      expect(meta!.icon).toBeUndefined();
      expect(meta!.category).toBe("utility");
    });

    it("returns defaults for directory app without matrix.md", () => {
      mkdirSync(join(homePath, "apps", "bare-app"), { recursive: true });
      writeFileSync(
        join(homePath, "apps", "bare-app", "index.html"),
        "<html></html>",
      );

      const meta = loadAppMeta(join(homePath, "apps"), "bare-app");
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("bare-app");
      expect(meta!.category).toBe("utility");
    });

    it("handles malformed frontmatter gracefully", () => {
      writeFileSync(
        join(homePath, "apps", "broken.matrix.md"),
        "This has no frontmatter at all.",
      );
      writeFileSync(
        join(homePath, "apps", "broken.html"),
        "<html></html>",
      );

      const meta = loadAppMeta(join(homePath, "apps"), "broken.html");
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("broken");
      expect(meta!.category).toBe("utility");
    });

    it("defaults missing optional fields", () => {
      writeFileSync(
        join(homePath, "apps", "minimal.matrix.md"),
        `---
name: Minimal
---`,
      );
      writeFileSync(
        join(homePath, "apps", "minimal.html"),
        "<html></html>",
      );

      const meta = loadAppMeta(join(homePath, "apps"), "minimal.html");
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe("Minimal");
      expect(meta!.description).toBeUndefined();
      expect(meta!.icon).toBeUndefined();
      expect(meta!.category).toBe("utility");
      expect(meta!.theme_accent).toBeUndefined();
      expect(meta!.data_dir).toBeUndefined();
      expect(meta!.author).toBeUndefined();
      expect(meta!.version).toBeUndefined();
    });
  });
});
