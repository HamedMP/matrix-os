import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// matrix-hostd.service runs the esbuild bundle, not the TypeScript sources.
// Bundling merges every module into one file, so any module-level entry guard
// that compares import.meta.url with argv[1] fires inside the bundle too. The
// guest agent's guard did: hostd logged the agent's usage line and set exit
// code 2. This runs the real bundle with no configuration and checks that only
// hostd's own entry ran.

const run = promisify(execFile);

describe("hostd bundle", () => {
  it("runs only hostd's entry point and fails closed on missing config", async () => {
    await run("bun", ["run", "--cwd", "packages/hostd", "build:hostd"]);
    const result = await run(process.execPath, ["packages/hostd/dist/hostd/main.mjs"], { env: { PATH: process.env.PATH } }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({ code: error.code, stderr: error.stderr ?? "" }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"event":"hostd.start_failed"');
    expect(result.stderr).toContain("HOSTD_API_TOKEN");
    expect(result.stderr).not.toContain("guest_agent");
  }, 60_000);
});
