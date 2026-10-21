import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("authenticated main admission and infrastructure outcomes", () => {
  it("preserves priority fairness, owned cancellation and fail-closed fallback", () => {
    const result = execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests/scripts/runner-policy", "-p", "test_*.py", "-v"], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(result).not.toContain("FAILED");
  }, 35_000);
});
