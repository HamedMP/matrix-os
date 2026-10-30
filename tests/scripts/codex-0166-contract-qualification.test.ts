import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const execBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const schemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0166/app-server-schema-0166.json.gz", import.meta.url)));
const previousBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0165/app-server-schema-0165.json.gz", import.meta.url)));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const previous = JSON.parse(previousBytes.toString("utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const changedDigests: Record<string, string> = {
  "item/started": "bedd6a6e59c26dba37deec380efa34ef88a4fa65902440f7b5c9977f33302529",
  "item/completed": "8ec2ff52d10fe877ce3353550dd0cbd9f4ca7358f8f47a572807994ae08a16c7",
  "turn/completed": "e8d4a5e2287d87bfcea1fc04428f44545ce243ef56381cbf6c8102f423f63dde",
};

describe("exact published Codex 0.166.0 qualification", () => {
  it.each(["linux-x64", "darwin-arm64"])("verifies retained official bytes and consumed payloads for %s", runtimeTarget => {
    expect(sha256(execBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(sha256(schemaBytes)).toBe("8aabf260bb66e9ca9ae5d20253f443971834644fe4659c85f8b1cc9e1d22dd5c");
    expect(() => verifyCodexProviderContracts({ version: "0.166.0", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget })).not.toThrow();
    for (const method of [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications]) {
      const definition = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
      expect(codexProtocolMethodDigest(schema, definition, method)).toBe(
        changedDigests[method] ?? codexProtocolMethodDigest(previous, definition, method));
    }
  });

  it("admits only reviewed releases and retains older qualifications", () => {
    for (const contract of [execContract, appServerContract]) {
      for (const version of ["0.162.1", "0.164.0", "0.165.0", "0.166.0"]) {
        expect(codexContractStatus(`codex-cli ${version}`, contract)).toEqual({ status: "verified", version });
      }
      expect(codexContractStatus("codex-cli 0.166.1", contract)).toEqual({ status: "unverified_newer", version: "0.166.1" });
      expect(codexContractStatus("codex-cli 0.165.1", contract)).toEqual({ status: "unverified_older", version: "0.165.1" });
    }
    expect(() => verifyCodexProviderContracts({ version: "0.166.1", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget: "linux-x64" })).toThrow("Codex 0.166.1 is not verified");
  });

  it("rejects changed published bytes after version qualification", () => {
    const args = { version: "0.166.0", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget: "darwin-arm64" };
    expect(() => verifyCodexProviderContracts({ ...args,
      execSchemaBytes: Buffer.concat([execBytes, Buffer.from("\n")]) })).toThrow("Codex exec JSONL schema digest changed");
    expect(() => verifyCodexProviderContracts({ ...args,
      appServerSchemaBytes: Buffer.concat([schemaBytes, Buffer.from("\n")]) })).toThrow("Codex app-server schema digest changed");
  });

  it("retains the independent transitive payload guard even if the raw digest is updated", () => {
    const mutated = structuredClone(schema);
    mutated.definitions.v2.ThreadItem.properties.startedAtMs.type = "string";
    const bytes = Buffer.from(JSON.stringify(mutated));
    const contract = { ...appServerContract, verifiedVersions: { ...appServerContract.verifiedVersions,
      "0.166.0": { schemaSha256ByTarget: { "linux-x64": sha256(bytes) } } } };
    expect(() => verifyCodexProviderContracts({ version: "0.166.0", execContract, appServerContract: contract,
      execSchemaBytes: execBytes, appServerSchemaBytes: bytes, runtimeTarget: "linux-x64" }))
      .toThrow("Codex app-server payload schema changed for item/started");
  });

  it("accounts for the complete published schema delta against 0.165.0", () => {
    const reviewed = structuredClone(schema);
    const addedRequests = ["account/gcp/setup", "accountSession/list", "accountSession/switch"];
    const requests = reviewed.definitions.ClientRequest.oneOf;
    expect(requests.filter((variant: { properties: { method: { enum: string[] } } }) =>
      addedRequests.includes(variant.properties.method.enum[0])).map((variant: { properties: { method: { enum: string[] } } }) =>
      variant.properties.method.enum[0]).sort()).toEqual([...addedRequests].sort());
    reviewed.definitions.ClientRequest.oneOf = requests.filter((variant: { properties: { method: { enum: string[] } } }) =>
      !addedRequests.includes(variant.properties.method.enum[0]));
    const v2 = reviewed.definitions.v2;
    for (const definition of ["AccountSession", "AccountSessionWorkspace", "AccountSessionWorkspaceKind",
      "AccountSessionsListParams", "AccountSessionsResponse", "AccountSessionsSwitchParams", "AccountSessionsSwitchResponse",
      "GcpSetupParams", "GcpSetupResponse", "ModelProviderError", "OtelExporter", "OtelHttpProtocol",
      "OtelRequirements", "OtelTlsConfig", "OtelToolResultLogConfig"]) {
      expect(v2[definition]).toBeDefined();
      delete v2[definition];
    }
    const account = v2.Account.oneOf.find((variant: { properties: { type: { enum: string[] } } }) =>
      variant.properties.type.enum.includes("chatgpt"));
    expect(account.properties.workspaceName.type).toEqual(["string", "null"]);
    expect(account.required).not.toContain("workspaceName");
    delete account.properties.workspaceName;
    for (const [definition, property] of [
      ["AdditionalContextEntry", "name"], ["ConfigRequirements", "otel"], ["HookMetadata", "environmentId"],
      ["HooksListParams", "threadId"], ["ProcessExitedNotification", "outputDrainTimedOut"], ["ThreadUsage", "nativeUsageUsdMicros"],
    ]) {
      expect(v2[definition].properties[property]).toBeDefined();
      expect(v2[definition].required ?? []).not.toContain(property);
      delete v2[definition].properties[property];
    }
    expect(v2.CodexErrorInfo.anyOf[0].enum.filter((value: string) =>
      !previous.definitions.v2.CodexErrorInfo.anyOf[0].enum.includes(value))).toEqual(["policyCapacityUnavailable"]);
    v2.CodexErrorInfo.anyOf[0].enum = v2.CodexErrorInfo.anyOf[0].enum.filter((value: string) => value !== "policyCapacityUnavailable");
    expect(v2.ReviewDelivery.enum).toEqual(["inline"]);
    expect(previous.definitions.v2.ReviewDelivery.enum).toEqual(["inline", "detached"]);
    v2.ReviewDelivery.enum = previous.definitions.v2.ReviewDelivery.enum;
    expect(v2.HookRunSummary.properties.sourcePath.$ref).toBe("#/definitions/v2/LegacyAppPathString");
    v2.HookRunSummary.properties.sourcePath.$ref = previous.definitions.v2.HookRunSummary.properties.sourcePath.$ref;
    for (const [definition, property] of [
      ["HooksListParams", "cwds"], ["NetworkRequirements", "domains"], ["NetworkRequirements", "unixSockets"],
      ["ReviewStartParams", "delivery"], ["ReviewStartResponse", "reviewThreadId"], ["ThreadForkParams", "attachToSource"],
    ]) {
      expect(v2[definition].properties[property].description).not.toBe(previous.definitions.v2[definition].properties[property].description);
      v2[definition].properties[property].description = previous.definitions.v2[definition].properties[property].description;
    }
    expect(v2.ThreadItem.type).toBe("object");
    expect(v2.ThreadItem.description).toBe("A thread item and its recorded lifecycle times. The payload stays flat on the wire.");
    expect(Object.keys(v2.ThreadItem.properties).sort()).toEqual(["completedAtMs", "startedAtMs"]);
    for (const property of Object.values(v2.ThreadItem.properties)) {
      expect(property).toMatchObject({ default: null, format: "int64", type: ["integer", "null"] });
    }
    delete v2.ThreadItem.type;
    delete v2.ThreadItem.description;
    delete v2.ThreadItem.properties;
    const image = v2.ThreadItem.oneOf.find((variant: { properties: { type: { enum: string[] } } }) =>
      variant.properties.type.enum.includes("imageGeneration"));
    expect(image.properties.generationId).toMatchObject({ default: null, type: ["string", "null"] });
    expect(image.required).not.toContain("generationId");
    delete image.properties.generationId;
    expect(reviewed).toEqual(previous);
  });
});
