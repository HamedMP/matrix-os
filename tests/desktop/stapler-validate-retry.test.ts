import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Guards the macOS release gate: Apple's ticket service drops connections now and
// then, which used to fail an already notarized Canary build. A transient failure
// must be retried, while an app that is never stapled must still fail the build.
const root = join(import.meta.dirname, "../..");
const script = join(root, "scripts/release/stapler-validate-with-retry.sh");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runWithFakeXcrun(failuresBeforeSuccess: number) {
  const dir = mkdtempSync(join(tmpdir(), "stapler-retry-"));
  dirs.push(dir);
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  const xcrun = join(dir, "xcrun");
  writeFileSync(
    xcrun,
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
count=$(wc -l < "${calls}")
if [ "$count" -le ${failuresBeforeSuccess} ]; then
  echo "The network connection was lost." >&2
  exit 68
fi
echo "The validate action worked!"
`,
  );
  chmodSync(xcrun, 0o755);
  const result = spawnSync("bash", [script, "/tmp/Matrix OS.app"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STAPLER_VALIDATE_RETRY_DELAY_SECONDS: "0" },
  });
  const invocations = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  return { result, invocations };
}

describe("stapler validate retry", () => {
  it("passes when Apple's ticket service recovers within the retry budget", () => {
    const { result, invocations } = runWithFakeXcrun(2);
    expect(result.status).toBe(0);
    expect(invocations).toHaveLength(3);
    expect(invocations[0]).toBe("stapler validate /tmp/Matrix OS.app");
  });

  it("fails the build when validation never succeeds", () => {
    const { result, invocations } = runWithFakeXcrun(100);
    expect(result.status).not.toBe(0);
    expect(invocations).toHaveLength(4);
    expect(result.stderr).toContain("stapler validate failed after 4 attempts");
  });

  it("is the validation the macOS release build runs", () => {
    const build = readFileSync(join(root, ".github/workflows/desktop-build.yml"), "utf8");
    expect(build).toContain('bash scripts/release/stapler-validate-with-retry.sh "$app_path"');
    expect(build).not.toMatch(/^\s*xcrun stapler validate "\$app_path"$/m);
  });
});
