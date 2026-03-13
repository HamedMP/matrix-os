import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

function qmdAvailable(): boolean {
  try {
    execFileSync("qmd", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasQmd = qmdAvailable();

function setupQmdHome(): { home: string; env: Record<string, string> } {
  const home = resolve(mkdtempSync(join(tmpdir(), "qmd-tool-")));
  mkdirSync(join(home, "agents", "knowledge"), { recursive: true });
  mkdirSync(join(home, "agents", "skills"), { recursive: true });
  mkdirSync(join(home, "system", "summaries"), { recursive: true });
  mkdirSync(join(home, "system", "qmd"), { recursive: true });
  mkdirSync(join(home, "apps"), { recursive: true });

  const env = {
    ...process.env,
    XDG_CACHE_HOME: join(home, "system", "qmd"),
    XDG_CONFIG_HOME: join(home, "system", "qmd"),
  } as Record<string, string>;

  return { home, env };
}

function qmdExec(args: string[], env: Record<string, string>): string {
  return execFileSync("qmd", args, { env, encoding: "utf-8", timeout: 10000 }).trim();
}

function seedAndIndex(home: string, env: Record<string, string>) {
  writeFileSync(
    join(home, "agents", "knowledge", "channels.md"),
    "# Channel Routing\nTelegram messages are dispatched to the kernel via ChannelManager.",
  );
  writeFileSync(
    join(home, "agents", "skills", "budget.md"),
    "# Budget Helper\nTrack expenses, set spending limits, and generate monthly reports.",
  );
  writeFileSync(
    join(home, "system", "summaries", "s1.md"),
    "# Session Summary\nUser installed the weather app and asked about rain forecast.",
  );

  qmdExec(["collection", "add", join(home, "agents", "knowledge"), "--name", "knowledge", "--mask", "**/*.md"], env);
  qmdExec(["collection", "add", join(home, "agents", "skills"), "--name", "skills", "--mask", "**/*.md"], env);
  qmdExec(["collection", "add", join(home, "system", "summaries"), "--name", "summaries", "--mask", "**/*.md"], env);
  qmdExec(["update"], env);
}

// Simulates what the IPC tool does
function qmdSearch(
  homePath: string,
  query: string,
  collection?: string,
  limit?: number,
): { results: unknown[]; error?: string } {
  try {
    const args = ["search", query, "--json"];
    if (collection) args.push("-c", collection);
    args.push("-n", String(limit ?? 5));

    const env = {
      ...process.env,
      XDG_CACHE_HOME: join(homePath, "system", "qmd"),
      XDG_CONFIG_HOME: join(homePath, "system", "qmd"),
    };

    const result = execFileSync("qmd", args, {
      encoding: "utf-8",
      timeout: 5000,
      env,
    }).trim();

    return { results: JSON.parse(result || "[]") };
  } catch (e) {
    return { results: [], error: String(e) };
  }
}

describe.skipIf(!hasQmd)("qmd_search IPC tool", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(() => {
    const setup = setupQmdHome();
    home = setup.home;
    env = setup.env;
    seedAndIndex(home, env);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("should find knowledge by query", () => {
    const { results } = qmdSearch(home, "telegram channel dispatch");
    expect(results.length).toBeGreaterThan(0);
    expect((results[0] as { file: string }).file).toContain("knowledge/channels.md");
  });

  it("should find skills by query", () => {
    const { results } = qmdSearch(home, "budget expenses spending");
    expect(results.length).toBeGreaterThan(0);
    expect((results[0] as { file: string }).file).toContain("skills/budget.md");
  });

  it("should find summaries by query", () => {
    const { results } = qmdSearch(home, "weather rain forecast");
    expect(results.length).toBeGreaterThan(0);
    expect((results[0] as { file: string }).file).toContain("summaries/s1.md");
  });

  it("should filter by collection", () => {
    const { results } = qmdSearch(home, "channel", "knowledge");
    for (const r of results as { file: string }[]) {
      expect(r.file).toContain("knowledge/");
    }
  });

  it("should respect limit parameter", () => {
    const { results } = qmdSearch(home, "the", undefined, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("should return empty for no-match queries", () => {
    const { results } = qmdSearch(home, "quantum entanglement dark matter");
    expect(results).toEqual([]);
  });

  it("should return results with expected shape", () => {
    const { results } = qmdSearch(home, "telegram");
    if (results.length > 0) {
      const r = results[0] as Record<string, unknown>;
      expect(r).toHaveProperty("file");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("snippet");
    }
  });

  it("should gracefully handle missing QMD index", () => {
    const emptyHome = resolve(mkdtempSync(join(tmpdir(), "qmd-empty-")));
    mkdirSync(join(emptyHome, "system", "qmd"), { recursive: true });
    const { results, error } = qmdSearch(emptyHome, "anything");
    // Either empty results or an error — never crashes
    expect(Array.isArray(results)).toBe(true);
    rmSync(emptyHome, { recursive: true, force: true });
  });
});
