import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const execBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const schemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0169/app-server-schema-0169.json.gz", import.meta.url)));
const previous = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/codex-0167/app-server-schema-0167.json.gz", import.meta.url))).toString());
const schema = JSON.parse(schemaBytes.toString());
const reviewedDelta: Array<{path:string;operation:string}> = JSON.parse(readFileSync(new URL("../fixtures/codex-0169/reviewed-delta.json", import.meta.url), "utf8"));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const changed = {
  "item/started": "617275c94854b1871af5371cbfdfdd88d03c66d681983ed82e3efeea1adec800",
  "item/completed": "bd38783bca8b6bd3ecf75796883f3784bffca1d7797c33b3248e43a754e92c0d",
  "turn/completed": "ea32be3552e720e9f07bffae9bb0b4270c0f33a7d86a1df9c701fc77197e3906",
};

describe("published Codex 0.169.0 qualification", () => {
  it("accounts for the complete schema delta against retained 0.167 bytes", () => {
    const normalized = structuredClone(schema);
    for (const change of reviewedDelta) {
      const parts = change.path.slice(1).split("/");
      const key = parts.pop()!;
      const parent = parts.reduce((value, part) => value[part], normalized);
      if (change.operation === "remove") {
        expect(parent).toHaveProperty(key);
        delete parent[key];
      } else {
        const prior = parts.reduce((value, part) => value[part], previous);
        parent[key] = structuredClone(prior[key]);
      }
    }
    expect(normalized).toEqual(previous);
    const methods = (value: typeof schema) => value.definitions.ClientRequest.oneOf.map((v: {properties:{method:{enum:string[]}}}) => v.properties.method.enum[0]);
    expect(methods(schema).filter((method: string) => !methods(previous).includes(method)).sort()).toEqual([
      "account/securitySetup/read", "modelProvider/config/write", "modelProvider/list", "thread/prepareApprovedPlan",
    ]);
    expect(schema.definitions.v2.FunctionCallOutputContentItem.oneOf[2].required).toEqual(["type"]);
  });
  it.each(["linux-x64", "darwin-arm64"])("accepts exact published bytes and consumed payloads on %s", runtimeTarget => {
    expect(hash(execBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(hash(schemaBytes)).toBe("d2d0612646b0739dd264067ef944442a5485e44529c793bebf3985e9a9df6cfc");
    expect(() => verifyCodexProviderContracts({ version: "0.169.0", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget })).not.toThrow();
  });

  it("accounts for every changed consumed notification while approval payloads remain unchanged", () => {
    const delta = Object.fromEntries([...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications].flatMap(method => {
      const type = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
      const digest = codexProtocolMethodDigest(schema, type, method);
      return digest === codexProtocolMethodDigest(previous, type, method) ? [] : [[method, digest]];
    }));
    expect(delta).toEqual(changed);
    expect(schema.definitions.v2.ThreadItem.oneOf[2].properties.moderation).toEqual({
      anyOf: [{ $ref: "#/definitions/v2/AgentMessageModeration" }, { type: "null" }], default: null,
    });
    expect(schema.definitions.v2.ItemCompletedNotification.properties.contentTokenCount).toMatchObject({
      default: null, minimum: 0, type: ["integer", "null"],
    });
    expect(schema.definitions.v2.CodexErrorInfo.anyOf).toContainEqual({
      description: "The workspace's inference hook explicitly denied this request.", enum: ["inferenceHookDenied"], type: "string",
    });
  });

  it("rejects unknown versions, altered vendor bytes and changed consumed approval semantics", () => {
    expect(codexContractStatus("codex-cli 0.169.0", execContract)).toEqual({ status: "verified", version: "0.169.0" });
    expect(codexContractStatus("codex-cli 0.168.0", execContract)).toEqual({ status: "unverified_older", version: "0.168.0" });
    expect(codexContractStatus("codex-cli 0.169.1", execContract)).toEqual({ status: "unverified_newer", version: "0.169.1" });
    const input = { version: "0.169.0", execContract, appServerContract, execSchemaBytes: execBytes,
      appServerSchemaBytes: schemaBytes, runtimeTarget: "linux-x64" };
    expect(() => verifyCodexProviderContracts({ ...input, appServerSchemaBytes: Buffer.concat([schemaBytes, Buffer.from("\n")]) }))
      .toThrow("Codex app-server schema digest changed");
    const altered = structuredClone(schema);
    altered.definitions.ServerRequest.oneOf.find((v: { properties: { method: { enum: string[] } } }) =>
      v.properties.method.enum.includes("item/permissions/requestApproval")).description = "unreviewed authority change";
    const alteredBytes = Buffer.from(JSON.stringify(altered));
    expect(() => verifyCodexProviderContracts({ ...input, appServerSchemaBytes: alteredBytes,
      appServerContract: { ...appServerContract, verifiedVersions: { ...appServerContract.verifiedVersions,
        "0.169.0": { schemaSha256: hash(alteredBytes) } } } })).toThrow("Codex app-server payload schema changed");
  });
});
