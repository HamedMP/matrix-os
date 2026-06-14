import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Extract a `name() { ... }` shell function body (signature line through the
// first line that is exactly `}`) from a script so we can exercise the real
// code without sourcing the whole daemon (which would run its poll loop). The
// host-bin functions follow the repo convention of a column-0 closing `}` and
// have no nested column-0 `}` line, so an exact-line match is deterministic
// here; brace counting would misfire on `${...}` parameter expansions.
function extractShellFunction(script: string, name: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => l === `${name}() {`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end === -1) throw new Error(`function ${name} has no closing brace`);
  return lines.slice(start, end + 1).join("\n");
}

describe("matrix-sync-agent symphony.env merge", () => {
  const script = readFileSync(
    "distro/customer-vps/host-bin/matrix-sync-agent",
    "utf8",
  );

  function runWriteSymphonyEnv(existingEnv: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "symphony-env-"));
    try {
      const envFile = join(dir, "symphony.env");
      if (existingEnv !== null) writeFileSync(envFile, existingEnv);

      // PATH shims so write_symphony_env runs without privileges: sudo execs
      // its args; install ignores -o/-g/-m and copies SRC -> DEST.
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n');
      writeFileSync(
        join(bin, "install"),
        '#!/usr/bin/env bash\nargs=(); while [ $# -gt 0 ]; do case "$1" in -o|-g|-m) shift 2;; *) args+=("$1"); shift;; esac; done\ncp "${args[0]}" "${args[1]}"\n',
      );
      chmodSync(join(bin, "sudo"), 0o755);
      chmodSync(join(bin, "install"), 0o755);

      const harness = [
        "set -euo pipefail",
        `export PATH="${bin}:$PATH"`,
        'SYMPHONY_MANAGED_KEYS="MATRIX_HANDLE PLATFORM_INTERNAL_URL UPGRADE_TOKEN"',
        `SYMPHONY_ENV_FILE="${envFile}"`,
        "export MATRIX_HANDLE=newhandle",
        "export PLATFORM_INTERNAL_URL=https://new.example",
        "export UPGRADE_TOKEN=newtoken",
        extractShellFunction(script, "preserve_unmanaged_symphony_env"),
        extractShellFunction(script, "write_symphony_env"),
        "write_symphony_env",
        `cat "${envFile}"`,
      ].join("\n");

      return execFileSync("bash", ["-c", harness], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rewrites managed keys with fresh values and preserves operator-set keys", () => {
    const result = runWriteSymphonyEnv(
      [
        "MATRIX_HANDLE=oldhandle",
        "PLATFORM_INTERNAL_URL=https://old.example",
        "UPGRADE_TOKEN=oldtoken",
        "# operator added these",
        "SYMPHONY_LINEAR_PROJECT_SLUG=my-project",
        "SYMPHONY_CODEX_COMMAND=codex app-server",
        "",
      ].join("\n"),
    );

    // Managed keys carry the fresh platform values, exactly once each.
    expect(result.match(/^MATRIX_HANDLE=newhandle$/gm)).toHaveLength(1);
    expect(result.match(/^PLATFORM_INTERNAL_URL=https:\/\/new\.example$/gm)).toHaveLength(1);
    expect(result.match(/^UPGRADE_TOKEN=newtoken$/gm)).toHaveLength(1);
    expect(result).not.toContain("oldhandle");
    expect(result).not.toContain("oldtoken");

    // Operator-set keys and their comment survive the rewrite.
    expect(result).toContain("# operator added these");
    expect(result).toContain("SYMPHONY_LINEAR_PROJECT_SLUG=my-project");
    expect(result).toContain("SYMPHONY_CODEX_COMMAND=codex app-server");
  });

  it("writes only managed keys when no prior file exists", () => {
    const result = runWriteSymphonyEnv(null);
    expect(result).toContain("MATRIX_HANDLE=newhandle");
    expect(result).toContain("PLATFORM_INTERNAL_URL=https://new.example");
    expect(result).toContain("UPGRADE_TOKEN=newtoken");
    expect(result).not.toContain("SYMPHONY_LINEAR_PROJECT_SLUG");
  });
});
