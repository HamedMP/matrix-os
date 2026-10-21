import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scanner = join(process.cwd(), "scripts/review/check-patterns.sh");

function scanFixture(source: string, args: string[] = []) {
  const fixture = mkdtempSync(join(tmpdir(), "matrix-pattern-scanner-"));
  try {
    mkdirSync(join(fixture, "packages"));
    mkdirSync(join(fixture, "shell"));
    writeFileSync(join(fixture, "packages/request.ts"), source);
    return spawnSync("bash", [scanner, ...args], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("mandatory pattern scanner", () => {
  it("recognizes a signal early in a large multiline fetch window", () => {
    // Exceed pipe capacity after the matching line: grep -q exits early,
    // which previously made echo fail with SIGPIPE under pipefail.
    const padding = Array.from({ length: 10 }, () => `// ${"x".repeat(16_384)}`);
    const result = scanFixture([
      'fetch("https://api.example.com", {',
      "  signal: AbortSignal.timeout(10_000),",
      ...padding,
      "});",
    ].join("\n"));

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("fetch() without signal:");
    expect(result.stdout).toContain("no violations or warnings");
  });

  it("still rejects a fetch without a signal", () => {
    const result = scanFixture('fetch("https://api.example.com", { method: "GET" });');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("fetch() without signal:");
    expect(result.stdout).toContain("packages/request.ts:1:");
  });

  it("preserves advisory warnings and strict-mode enforcement", () => {
    const source = "const cache = new Map();";
    const advisory = scanFixture(source);
    const strict = scanFixture(source, ["--strict"]);

    expect(advisory.status).toBe(0);
    expect(advisory.stdout).toContain("1 warning(s), 0 violations");
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("(--strict mode: treating warnings as errors)");
  });
});
