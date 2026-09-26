import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import contract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import {
  codexProtocolMethodDigest,
  verifyCodexProviderContracts,
} from "../../scripts/lib/codex-provider-contract-check.mjs";

const scriptPath = fileURLToPath(
  new URL("../../scripts/check-codex-exec-contract.mjs", import.meta.url),
);
const comparisonScriptPath = fileURLToPath(new URL(
  "../../specs/532-codex-0157-contract-qualification/evidence/compare-schemas.py",
  import.meta.url,
));

type ProtocolVariant = {
  properties: { method: { enum: string[] } };
  description?: string;
};
type MutableProtocolSchema = {
  definitions: {
    ClientRequest: { oneOf: ProtocolVariant[] };
    ServerNotification: { oneOf: ProtocolVariant[] };
    v2: { McpServerStatus: { properties: Record<string, unknown> } };
  };
};

const comparatorMutations: Array<{
  label: string;
  mutate: (schema: MutableProtocolSchema) => void;
  error: string;
}> = [
  {
    label: "a removed existing client request",
    mutate: (schema) => {
      schema.definitions.ClientRequest.oneOf = schema.definitions.ClientRequest.oneOf.filter(
        (variant) => variant.properties.method.enum[0] !== "initialize",
      );
    },
    error: "removed ClientRequest variants",
  },
  {
    label: "a modified existing server notification",
    mutate: (schema) => {
      const variant = schema.definitions.ServerNotification.oneOf.find(
        (candidate) => candidate.properties.method.enum[0] === "item/started",
      );
      if (!variant) throw new Error("Fixture has no item/started notification");
      variant.description = "mutated fixture";
    },
    error: "modified ServerNotification variants",
  },
  {
    label: "an unexpected optional field in a referenced v2 type",
    mutate: (schema) => {
      schema.definitions.v2.McpServerStatus.properties.unreviewed = { type: "boolean" };
    },
    error: "unexpected McpServerStatus additions",
  },
];

describe("Codex provider contract checker", () => {
  it.each(comparatorMutations)("rejects schema comparison mutations: $label", ({ mutate, error }) => {
    const schema = JSON.parse(gunzipSync(readFileSync(new URL(
      "../fixtures/codex-0157/app-server-schema-0157.json.gz",
      import.meta.url,
    ))).toString("utf8")) as MutableProtocolSchema;
    mutate(schema);
    const scratch = mkdtempSync(join(tmpdir(), "codex-0157-schema-mutation-"));
    try {
      const mutatedPath = join(scratch, "mutated.json.gz");
      writeFileSync(mutatedPath, gzipSync(JSON.stringify(schema)));
      const result = spawnSync("python3", [comparisonScriptPath, "--new-schema", mutatedPath], {
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("qualifies exact published Codex 0.157.1 bytes on both supported targets", () => {
    const version = "0.157.1";
    const execSchemaBytes = readFileSync(new URL(
      "../fixtures/codex-0157/exec-events.rs",
      import.meta.url,
    ));
    const appServerSchemaBytes = gunzipSync(readFileSync(new URL(
      "../fixtures/codex-0157/app-server-schema-0157.json.gz",
      import.meta.url,
    )));
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

    // The checked-in fixture is the tagged source plus published CLI-generated
    // schema, not a hand-built approximation of the methods we consume.
    // Exact 0.157.1 source and generated schema bytes are identical to 0.157.0.
    expect(digest(execSchemaBytes)).toBe(
      "dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5",
    );
    expect(digest(appServerSchemaBytes)).toBe(
      "d6d70a4b2af4c6bb03dee46af2cda9c8b7b4d656cd5a55c54f748146985cdb43",
    );

    for (const runtimeTarget of ["darwin-arm64", "linux-x64"]) {
      expect(() => verifyCodexProviderContracts({
        version,
        execContract: contract,
        appServerContract,
        execSchemaBytes,
        appServerSchemaBytes,
        runtimeTarget,
      })).not.toThrow();
    }

  });

  it("retains earlier qualification records and rejects an unknown Codex version", () => {
    const execSchemaBytes = readFileSync(new URL(
      "../fixtures/codex-0157/exec-events.rs",
      import.meta.url,
    ));
    const appServerSchemaBytes = gunzipSync(readFileSync(new URL(
      "../fixtures/codex-0157/app-server-schema-0157.json.gz",
      import.meta.url,
    )));
    expect(contract.verifiedVersions["0.156.1"]).toBeDefined();
    expect(appServerContract.verifiedVersions["0.156.1"]).toBeDefined();
    expect(() => verifyCodexProviderContracts({
      version: "0.157.2",
      execContract: contract,
      appServerContract,
      execSchemaBytes,
      appServerSchemaBytes,
    })).toThrow("Codex 0.157.2 is not verified");
  });

  it("retains reviewed Codex schemas through 0.157.1", () => {
    expect(contract.latestVerifiedVersion).toBe("0.157.1");
    expect(contract.verifiedVersions["0.156.0"]).toEqual({
      schemaSha256: "dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5",
    });
    expect(contract.verifiedVersions["0.156.1"]).toEqual({
      schemaSha256: "dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5",
    });
    expect(contract.verifiedVersions["0.157.0"]).toEqual(contract.verifiedVersions["0.156.1"]);
    expect(contract.verifiedVersions["0.157.1"]).toEqual(contract.verifiedVersions["0.157.0"]);
    expect(appServerContract.latestVerifiedVersion).toBe("0.157.1");
    expect(appServerContract.verifiedVersions["0.156.0"]).toEqual({
      schemaSha256ByTarget: {
        "darwin-arm64": "655adafa0ccea3d84f30bcbdc74e201fa14511c51e08d0cd024a0280daa8bc60",
        "linux-x64": "655adafa0ccea3d84f30bcbdc74e201fa14511c51e08d0cd024a0280daa8bc60",
      },
    });
    expect(appServerContract.verifiedVersions["0.156.1"]).toEqual(
      appServerContract.verifiedVersions["0.156.0"],
    );
    expect(appServerContract.verifiedVersions["0.157.0"]).toEqual({
      schemaSha256ByTarget: {
        "darwin-arm64": "d6d70a4b2af4c6bb03dee46af2cda9c8b7b4d656cd5a55c54f748146985cdb43",
        "linux-x64": "d6d70a4b2af4c6bb03dee46af2cda9c8b7b4d656cd5a55c54f748146985cdb43",
      },
    });
    expect(appServerContract.verifiedVersions["0.157.1"]).toEqual(
      appServerContract.verifiedVersions["0.157.0"],
    );
    expect(appServerContract.requiredServerProtocolSchemaDigests[
      "item/commandExecution/requestApproval"
    ]).toEqual({
      schemaSha256ByTarget: {
        "darwin-arm64": "ef803ac64161397389bc35428803c3ec8dcc94757c93d758a9fdf0ae6b5a944f",
        "linux-x64": "ef803ac64161397389bc35428803c3ec8dcc94757c93d758a9fdf0ae6b5a944f",
      },
    });
    expect(appServerContract.requiredServerProtocolSchemaDigests).toMatchObject({
      "mcpServer/elicitation/request": "d164b1519690cfb0b5f353c8e6eb37087f720e7dcd81df4c145bc964f9416d05",
      "item/started": "7e1fcd8e3953999660d5c80e2ba4479697645e179ce3a95555712d4f60097d6b",
      "item/completed": "33f9ba75a8594be59e8ad8c841c9a405df51917739cf2dd87da1a87b0f5e2b83",
      "turn/completed": "7a68f912f14af36e22a922dca2466225aa8da9509cfd7ee61db6ef096139360f",
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

    const targetSpecificAppServerContract = {
      ...appServerContract,
      verifiedVersions: {
        [version]: {
          schemaSha256ByTarget: {
            "darwin-arm64": digest(appServerSchema),
            "linux-x64": "0".repeat(64),
          },
        },
      },
    };
    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract: targetSpecificAppServerContract,
      execSchemaBytes: execSchema,
      appServerSchemaBytes: appServerSchema,
      runtimeTarget: "darwin-arm64",
    })).not.toThrow();
    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract: targetSpecificAppServerContract,
      execSchemaBytes: execSchema,
      appServerSchemaBytes: appServerSchema,
      runtimeTarget: "linux-x64",
    })).toThrow(`received ${digest(appServerSchema)}`);

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

  it("pins the transitive payload schema consumed for every required RPC method", () => {
    const version = "1.2.3";
    const method = "item/commandExecution/requestApproval";
    const schema = {
      definitions: {
        ServerRequest: {
          oneOf: [{
            properties: {
              id: { type: "string" },
              method: { enum: [method], type: "string" },
              params: { $ref: "#/definitions/ApprovalParams" },
            },
            required: ["id", "method", "params"],
            type: "object",
          }],
        },
        ApprovalParams: {
          properties: { threadId: { type: "string" } },
          required: ["threadId"],
          type: "object",
        },
      },
    };
    const execSchema = Buffer.from("thread.started", "utf8");
    const schemaBytes = Buffer.from(JSON.stringify(schema), "utf8");
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const semanticDigest = codexProtocolMethodDigest(schema, "ServerRequest", method);
    const execContract = {
      latestVerifiedVersion: version,
      verifiedVersions: { [version]: { schemaSha256: digest(execSchema) } },
      requiredEventTypes: ["thread.started"],
    };
    const appServerContract = {
      latestVerifiedVersion: version,
      verifiedVersions: { [version]: { schemaSha256: digest(schemaBytes) } },
      requiredServerMethods: [method],
      requiredServerNotifications: [],
      requiredServerProtocolSchemaDigests: { [method]: semanticDigest },
    };

    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract,
      execSchemaBytes: execSchema,
      appServerSchemaBytes: schemaBytes,
    })).not.toThrow();

    const targetSpecificSemanticContract = {
      ...appServerContract,
      requiredServerProtocolSchemaDigests: {
        [method]: {
          schemaSha256ByTarget: {
            "darwin-arm64": semanticDigest,
            "linux-x64": "0".repeat(64),
          },
        },
      },
    };
    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract: targetSpecificSemanticContract,
      execSchemaBytes: execSchema,
      appServerSchemaBytes: schemaBytes,
      runtimeTarget: "darwin-arm64",
    })).not.toThrow();
    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract: targetSpecificSemanticContract,
      execSchemaBytes: execSchema,
      appServerSchemaBytes: schemaBytes,
      runtimeTarget: "linux-x64",
    })).toThrow(`Codex app-server payload schema changed for ${method}`);

    const changedSchemaBytes = Buffer.from(JSON.stringify({
      ...schema,
      definitions: {
        ...schema.definitions,
        ApprovalParams: {
          ...schema.definitions.ApprovalParams,
          properties: { threadId: { type: "number" } },
        },
      },
    }), "utf8");
    expect(() => verifyCodexProviderContracts({
      version,
      execContract,
      appServerContract: {
        ...appServerContract,
        verifiedVersions: { [version]: { schemaSha256: digest(changedSchemaBytes) } },
      },
      execSchemaBytes: execSchema,
      appServerSchemaBytes: changedSchemaBytes,
    })).toThrow(`Codex app-server payload schema changed for ${method}`);
  });

  it("monitors the published package and every runtime compatibility boundary", () => {
    const workflow = readFileSync(new URL(
      "../../.github/workflows/codex-exec-contract.yml",
      import.meta.url,
    ), "utf8");

    expect(workflow).toContain('cron: "41 5 * * *"');
    expect(workflow).toContain("macos-15");
    expect(workflow).toContain("Report generated protocol digests");
    expect(workflow).toContain('installed_version="${installed_output##* }"');
    expect(workflow).not.toContain("sed -n");
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
