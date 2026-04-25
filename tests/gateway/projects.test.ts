import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects } from "../../packages/gateway/src/projects.js";

describe("listProjects", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-projects-test-"));
    mkdirSync(join(homePath, "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("lists project directories with git branch and dirty count", async () => {
    mkdirSync(join(homePath, "projects", "alpha", ".git"), { recursive: true });
    mkdirSync(join(homePath, "projects", "beta"), { recursive: true });
    writeFileSync(join(homePath, "projects", ".hidden"), "ignored");

    const runGit = vi.fn(async (args: string[], { cwd }: { cwd: string }) => {
      if (args[0] === "rev-parse") {
        return { stdout: cwd.endsWith("alpha") ? "main\n" : "ignored\n" };
      }
      return { stdout: " M src/index.ts\n?? notes.md\n" };
    });

    const result = await listProjects(homePath, "projects", { runGit });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projects).toHaveLength(2);
    expect(result.projects.find((project) => project.name === "alpha")).toMatchObject({
      path: "projects/alpha",
      isGit: true,
      branch: "main",
      dirtyCount: 2,
    });
    expect(result.projects.find((project) => project.name === "beta")).toMatchObject({
      path: "projects/beta",
      isGit: false,
      branch: null,
      dirtyCount: 0,
    });
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid roots", async () => {
    await expect(listProjects(homePath, "../outside")).resolves.toEqual({
      ok: false,
      status: 400,
      error: "Invalid root",
    });
    await expect(listProjects(homePath, "")).resolves.toEqual({
      ok: false,
      status: 400,
      error: "Invalid root",
    });
  });

  it("returns an empty project list for a missing root without leaking raw errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await listProjects(homePath, "missing");

    expect(result).toEqual({ ok: true, root: "missing", projects: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips symlinked project entries so external repos are not inspected", async () => {
    const outside = await mkdtemp(join(tmpdir(), "matrix-projects-outside-"));
    mkdirSync(join(outside, ".git"), { recursive: true });
    symlinkSync(outside, join(homePath, "projects", "external"));
    const runGit = vi.fn(async () => ({ stdout: "main\n" }));

    const result = await listProjects(homePath, "projects", { runGit });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projects).toEqual([]);
    }
    expect(runGit).not.toHaveBeenCalled();
    rmSync(outside, { recursive: true, force: true });
  });

  it("logs unexpected git probe failures and treats the entry as non-git", async () => {
    mkdirSync(join(homePath, "projects", "broken", ".git"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runGit = vi.fn(async () => {
      throw Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" });
    });

    const result = await listProjects(homePath, "projects", { runGit });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projects[0]).toMatchObject({ name: "broken", isGit: false });
    }
    expect(warn).toHaveBeenCalledWith(
      "[projects] Failed to read git branch for projects/broken:",
      "git timed out",
    );
  });
});
