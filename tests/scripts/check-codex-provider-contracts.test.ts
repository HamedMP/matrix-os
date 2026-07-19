import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import contract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import { verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-codex-exec-contract.mjs", import.meta.url),
);

describe("Codex provider contract checker", () => {
  it("requires exact-version digests and protocol semantics to evolve together", () => {
    const version = "1.2.3";
    const execSchema = Buffer.from("thread.started\nturn.completed\nitem.started", "utf8");
    const appServerSchema = Buffer.from(JSON.stringify({
      methods: ["item/commandExecution/requestApproval", "item/tool/requestUserInput"],
    }), "utf8");
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const execContract = {
      latestVerifiedVersion: version,
      verifiedVersions: { [version]: { schemaSha256: digest(execSchema) } },
      requiredEventTypes: ["thread.started", "turn.completed", "item.started"],
    };
    const appServerContract = {
      latestVerifiedVersion: version,
      verifiedVersions: { [version]: { schemaSha256: digest(appServerSchema) } },
      requiredServerMethods: [
        "item/commandExecution/requestApproval",
        "item/tool/requestUserInput",
      ],
    };

    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract,
      execSchemaBytes: execSchema,
      appServerSchemaBytes: appServerSchema,
    })).not.toThrow();

    expect(() => verifyCodexProviderContracts({
      version,
      execContract: { ...execContract, requiredEventTypes: ["turn.failed"] },
      appServerContract,
      execSchemaBytes: execSchema,
      appServerSchemaBytes: appServerSchema,
    })).toThrow("Codex exec event is unavailable: turn.failed");

    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract: {
        ...appServerContract,
        verifiedVersions: { ...appServerContract.verifiedVersions, "1.2.2": { schemaSha256: "0".repeat(64) } },
      },
      execSchemaBytes: execSchema,
      appServerSchemaBytes: appServerSchema,
    })).toThrow("Codex exec and app-server verified versions must evolve together");
  });

  it("fails closed when either provider schema is omitted", () => {
    const result = spawnSync(process.execPath, [scriptPath, contract.latestVerifiedVersion], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Both Codex schema paths are required");
    expect(result.stdout).not.toContain("matches the verified JSONL and app-server contracts");
  });

  it("monitors the published package and every runtime compatibility boundary", () => {
    const workflow = readFileSync(new URL(
      "../../.github/workflows/codex-exec-contract.yml",
      import.meta.url,
    ), "utf8");

    expect(workflow).toContain('cron: "41 5 * * *"');
    expect(workflow).toContain("pnpm view @openai/codex version --json");
    expect(workflow).toContain('pnpm dlx "@openai/codex@${CODEX_VERSION}" --version');
    expect(workflow).toContain("codex-provider-version-check.mjs");
    expect(workflow).toContain("matrix-install-developer-tools");
    expect(workflow).toContain("terminal-agent-options.ts");
  });
});
