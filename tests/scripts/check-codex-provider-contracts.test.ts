import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import contract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import { verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-codex-exec-contract.mjs", import.meta.url),
);

describe("Codex provider contract checker", () => {
  it("trusts the reviewed Codex 0.153.3 provider schemas", () => {
    expect(contract.latestVerifiedVersion).toBe("0.153.3");
    expect(contract.verifiedVersions["0.153.3"]).toEqual({
      schemaSha256: "c404928e0f2a463e19d1b263081c9d5e0380aec9f651a05ee0766f7bb7527f32",
    });
    expect(appServerContract.latestVerifiedVersion).toBe("0.153.3");
    expect(appServerContract.verifiedVersions["0.153.3"]).toEqual({
      schemaSha256: "e8284c5cb8157554a3dd1e035aadbd4325aea501af56887e9c2e12eb1b9b9448",
    });
  });

  it("requires exact-version digests and protocol semantics to evolve together", () => {
    const version = "1.2.3";
    const execSchema = Buffer.from("thread.started\nturn.completed\nitem.started", "utf8");
    const appServerSchema = Buffer.from(JSON.stringify({
      methods: ["item/commandExecution/requestApproval", "item/tool/requestUserInput"],
      notifications: ["item/started", "item/completed", "turn/completed"],
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
      requiredServerNotifications: ["item/started", "item/completed", "turn/completed"],
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
      execContract,
      appServerContract: {
        ...appServerContract,
        verifiedVersions: { [version]: { schemaSha256: "0".repeat(64) } },
      },
      execSchemaBytes: execSchema,
      appServerSchemaBytes: appServerSchema,
    })).toThrow(`received ${digest(appServerSchema)}`);

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
        requiredServerNotifications: ["item/started", "turn/failed"],
      },
      execSchemaBytes: execSchema,
      appServerSchemaBytes: appServerSchema,
    })).toThrow("Codex app-server notification is unavailable: turn/failed");

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

  it("keeps malformed app-server spike output diagnosable without echoing its contents", () => {
    const spike = readFileSync(new URL(
      "../../scripts/spikes/codex-turn-steer.mjs",
      import.meta.url,
    ), "utf8");

    expect(spike).toContain('catch (error)');
    expect(spike).toContain('"[codex-turn-steer] Ignoring malformed output:"');
    expect(spike).toContain('error instanceof Error ? error.name : "UnknownError"');
    expect(spike).not.toContain("console.warn(line");
  });
});
