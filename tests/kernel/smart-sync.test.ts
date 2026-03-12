import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "matrixos-sync-test-"));
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeManifest(dir: string, manifest: Record<string, string>) {
  writeFileSync(join(dir, ".template-manifest.json"), JSON.stringify(manifest, null, 2));
}

// We need to mock the TEMPLATE_DIR to point to our test template directory.
// The syncTemplate function uses TEMPLATE_DIR which is derived from import.meta.dirname.
// We'll test via ensureHome which calls syncTemplate internally.
// To properly isolate, we import the internal syncTemplate via ensureHome behavior.

describe("smart syncTemplate", () => {
  let tmpDir: string;
  let templateDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    templateDir = join(tmpDir, "template");
    homeDir = join(tmpDir, "home");
    mkdirSync(templateDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // We'll import the raw syncTemplate for testing.
  // Since it's not exported by default, we'll need to export it or test via ensureHome.
  // For better isolation, we'll import smartSyncTemplate directly.

  async function importSync() {
    const mod = await import("../../packages/kernel/src/boot.js");
    return mod.smartSyncTemplate;
  }

  it("adds new file from template to home", async () => {
    const smartSync = await importSync();

    // Template has a file
    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "new soul");

    // Template manifest includes this file
    const templateManifest: Record<string, string> = {
      "system/soul.md": sha256("new soul"),
    };
    writeManifest(templateDir, templateManifest);

    // Home has no installed manifest (simulates first sync after upgrade)
    const report = smartSync(homeDir, templateDir);

    expect(report.added).toContain("system/soul.md");
    expect(report.updated).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(readFileSync(join(homeDir, "system", "soul.md"), "utf-8")).toBe("new soul");

    // Installed manifest should be created
    const installed = JSON.parse(readFileSync(join(homeDir, ".template-manifest.json"), "utf-8"));
    expect(installed["system/soul.md"]).toBe(sha256("new soul"));
  });

  it("updates unchanged file from template", async () => {
    const smartSync = await importSync();

    // Template has updated content
    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "updated soul v2");

    const templateManifest: Record<string, string> = {
      "system/soul.md": sha256("updated soul v2"),
    };
    writeManifest(templateDir, templateManifest);

    // Home has old version (matching installed manifest = untouched by user)
    mkdirSync(join(homeDir, "system"), { recursive: true });
    writeFileSync(join(homeDir, "system", "soul.md"), "old soul v1");

    const installedManifest: Record<string, string> = {
      "system/soul.md": sha256("old soul v1"),
    };
    writeManifest(homeDir, installedManifest);

    const report = smartSync(homeDir, templateDir);

    expect(report.updated).toContain("system/soul.md");
    expect(report.added).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(readFileSync(join(homeDir, "system", "soul.md"), "utf-8")).toBe("updated soul v2");
  });

  it("skips user-customized files", async () => {
    const smartSync = await importSync();

    // Template has new version
    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "template v2");

    const templateManifest: Record<string, string> = {
      "system/soul.md": sha256("template v2"),
    };
    writeManifest(templateDir, templateManifest);

    // Home has user-customized version (differs from installed manifest)
    mkdirSync(join(homeDir, "system"), { recursive: true });
    writeFileSync(join(homeDir, "system", "soul.md"), "my custom soul");

    const installedManifest: Record<string, string> = {
      "system/soul.md": sha256("original soul v1"),
    };
    writeManifest(homeDir, installedManifest);

    const report = smartSync(homeDir, templateDir);

    expect(report.skipped).toContain("system/soul.md");
    expect(report.added).toEqual([]);
    expect(report.updated).toEqual([]);
    // User's customized file should be preserved
    expect(readFileSync(join(homeDir, "system", "soul.md"), "utf-8")).toBe("my custom soul");
  });

  it("handles first boot (no installed manifest) - all files added", async () => {
    const smartSync = await importSync();

    mkdirSync(join(templateDir, "system"), { recursive: true });
    mkdirSync(join(templateDir, "agents"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "soul");
    writeFileSync(join(templateDir, "agents", "builder.md"), "builder");

    const templateManifest: Record<string, string> = {
      "system/soul.md": sha256("soul"),
      "agents/builder.md": sha256("builder"),
    };
    writeManifest(templateDir, templateManifest);

    const report = smartSync(homeDir, templateDir);

    expect(report.added).toContain("system/soul.md");
    expect(report.added).toContain("agents/builder.md");
    expect(report.updated).toEqual([]);
    expect(report.skipped).toEqual([]);

    // Installed manifest should be written
    const installed = JSON.parse(readFileSync(join(homeDir, ".template-manifest.json"), "utf-8"));
    expect(installed["system/soul.md"]).toBe(sha256("soul"));
    expect(installed["agents/builder.md"]).toBe(sha256("builder"));
  });

  it("is idempotent - running twice produces same result", async () => {
    const smartSync = await importSync();

    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "soul content");

    const templateManifest: Record<string, string> = {
      "system/soul.md": sha256("soul content"),
    };
    writeManifest(templateDir, templateManifest);

    // First run
    const report1 = smartSync(homeDir, templateDir);
    expect(report1.added).toContain("system/soul.md");

    // Second run - file now matches template, should be a no-op
    const report2 = smartSync(homeDir, templateDir);
    expect(report2.added).toEqual([]);
    expect(report2.updated).toEqual([]);
    expect(report2.skipped).toEqual([]);

    expect(readFileSync(join(homeDir, "system", "soul.md"), "utf-8")).toBe("soul content");
  });

  it("no-op when template manifest is empty", async () => {
    const smartSync = await importSync();

    writeManifest(templateDir, {});

    const report = smartSync(homeDir, templateDir);

    expect(report.added).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("handles missing template manifest gracefully", async () => {
    const smartSync = await importSync();

    // No .template-manifest.json in template dir
    const report = smartSync(homeDir, templateDir);

    expect(report.added).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("file not in installed manifest but exists in home - treated as customized/skip", async () => {
    const smartSync = await importSync();

    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "template soul");

    const templateManifest: Record<string, string> = {
      "system/soul.md": sha256("template soul"),
    };
    writeManifest(templateDir, templateManifest);

    // Home has the file but no installed manifest entry for it
    mkdirSync(join(homeDir, "system"), { recursive: true });
    writeFileSync(join(homeDir, "system", "soul.md"), "user's own soul");

    // Empty installed manifest (file not tracked)
    writeManifest(homeDir, {});

    const report = smartSync(homeDir, templateDir);

    // File exists but was not in installed manifest, so we can't tell if user modified it.
    // Conservative approach: skip if file exists and content differs from template
    // If content matches template, treat as unchanged (update installed manifest)
    expect(report.skipped).toContain("system/soul.md");
    expect(readFileSync(join(homeDir, "system", "soul.md"), "utf-8")).toBe("user's own soul");
  });

  it("creates nested directories when adding new files", async () => {
    const smartSync = await importSync();

    mkdirSync(join(templateDir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(templateDir, "a", "b", "c", "deep.md"), "deep");

    const templateManifest: Record<string, string> = {
      "a/b/c/deep.md": sha256("deep"),
    };
    writeManifest(templateDir, templateManifest);

    const report = smartSync(homeDir, templateDir);

    expect(report.added).toContain("a/b/c/deep.md");
    expect(readFileSync(join(homeDir, "a", "b", "c", "deep.md"), "utf-8")).toBe("deep");
  });
});

describe("sync logging (T2092)", () => {
  let tmpDir: string;
  let templateDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    templateDir = join(tmpDir, "template");
    homeDir = join(tmpDir, "home");
    mkdirSync(templateDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importSync() {
    const mod = await import("../../packages/kernel/src/boot.js");
    return mod.smartSyncTemplate;
  }

  it("writes sync log to system/logs/template-sync.log", async () => {
    const smartSync = await importSync();

    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "soul");

    writeManifest(templateDir, { "system/soul.md": sha256("soul") });

    smartSync(homeDir, templateDir);

    const logPath = join(homeDir, "system", "logs", "template-sync.log");
    expect(existsSync(logPath)).toBe(true);

    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("Template sync started");
    expect(log).toContain("Added: system/soul.md");
    expect(log).toContain("Template sync completed");
    expect(log).toContain("1 added");
  });

  it("logs skipped files with reason", async () => {
    const smartSync = await importSync();

    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "template v2");

    writeManifest(templateDir, { "system/soul.md": sha256("template v2") });

    mkdirSync(join(homeDir, "system"), { recursive: true });
    writeFileSync(join(homeDir, "system", "soul.md"), "customized");
    writeManifest(homeDir, { "system/soul.md": sha256("original v1") });

    smartSync(homeDir, templateDir);

    const logPath = join(homeDir, "system", "logs", "template-sync.log");
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("Skipped: system/soul.md (customized by user)");
    expect(log).toContain("1 skipped");
  });

  it("logs updated files", async () => {
    const smartSync = await importSync();

    mkdirSync(join(templateDir, "system"), { recursive: true });
    writeFileSync(join(templateDir, "system", "soul.md"), "updated");

    writeManifest(templateDir, { "system/soul.md": sha256("updated") });

    mkdirSync(join(homeDir, "system"), { recursive: true });
    writeFileSync(join(homeDir, "system", "soul.md"), "old");
    writeManifest(homeDir, { "system/soul.md": sha256("old") });

    smartSync(homeDir, templateDir);

    const logPath = join(homeDir, "system", "logs", "template-sync.log");
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("Updated: system/soul.md");
    expect(log).toContain("1 updated");
  });

  it("creates logs directory if missing", async () => {
    const smartSync = await importSync();

    writeManifest(templateDir, {});

    smartSync(homeDir, templateDir);

    // Even with no changes, the log dir should be created and log written
    const logPath = join(homeDir, "system", "logs", "template-sync.log");
    expect(existsSync(logPath)).toBe(true);
  });

  it("appends to existing log file", async () => {
    const smartSync = await importSync();

    writeManifest(templateDir, {});

    // Write an existing log entry
    mkdirSync(join(homeDir, "system", "logs"), { recursive: true });
    writeFileSync(join(homeDir, "system", "logs", "template-sync.log"), "previous log entry\n");

    smartSync(homeDir, templateDir);

    const logPath = join(homeDir, "system", "logs", "template-sync.log");
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("previous log entry");
    expect(log).toContain("Template sync started");
  });
});
