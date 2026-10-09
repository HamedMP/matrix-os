import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const disposableRootLinux = process.platform === "linux" && process.getuid?.() === 0
  && existsSync("/.dockerenv") && process.env.MATRIX_DISPOSABLE_ROOT_TEST === "true";

function execute(fixture: string, testClass?: string) {
  const args = ["-I", `tests/deploy/customer-vps/${fixture}`, ...(testClass ? [testClass] : [])];
  const result = spawnSync("python3", args, { encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/Ran [1-9][0-9]* tests?/);
  expect(result.stderr).toContain("OK");
  expect(result.stderr).not.toContain("skipped");
}

describe("portable protected funded host contracts", () => {
  it("executes archive and transport cases", () => execute("funded-host-component.test.py", "ComponentTests"));
  it("rejects missing or skipped root evidence", () => execute("funded-host-root-runner.test.py"));
});

describe.skipIf(!disposableRootLinux)("protected funded host root contracts (explicit disposable Linux only)", () => {
  it("executes root lifecycle cases", () => execute("funded-host-component.test.py", "RootLifecycleTests"));
  it.each([
    "funded-host-restoration.test.py",
    "funded-host-artifact-repair.test.py",
    "funded-host-install-serialization.test.py",
  ])("executes %s without skipped cases", fixture => execute(fixture));
});
