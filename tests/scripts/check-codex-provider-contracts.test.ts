import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import contract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-codex-exec-contract.mjs", import.meta.url),
);

describe("Codex provider contract checker", () => {
  it("fails closed when either provider schema is omitted", () => {
    const result = spawnSync(process.execPath, [scriptPath, contract.latestVerifiedVersion], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Both Codex schema paths are required");
    expect(result.stdout).not.toContain("matches the verified JSONL and app-server contracts");
  });
});
