import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const execBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const schemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0164/app-server-schema-0164.json.gz", import.meta.url)));
const previousBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0163/app-server-schema-0163.json.gz", import.meta.url)));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const previous = JSON.parse(previousBytes.toString("utf8"));
const historicalExecContract = { ...execContract, latestVerifiedVersion: "0.164.0" };
const historicalAppServerContract = { ...appServerContract, latestVerifiedVersion: "0.164.0",
  requiredServerProtocolSchemaDigests: { ...appServerContract.requiredServerProtocolSchemaDigests,
    "turn/completed": "2417c2c44801a090d921300b88a225c379a80fb559cdc96a72f6861514e1351a" } };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("exact published Codex 0.164.0 qualification", () => {
  it.each(["linux-x64", "darwin-arm64"])("verifies official schema bytes and reviewed notification payloads on %s", runtimeTarget => {
    expect(sha256(execBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(sha256(schemaBytes)).toBe("92fe055424a3709999a05baae615be9e1e1e0b127e033cace6849b2ea785ea07");
    expect(() => verifyCodexProviderContracts({ version: "0.164.0", execContract: historicalExecContract, appServerContract: historicalAppServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget })).not.toThrow();
    for (const method of [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications]) {
      const definition = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
      const expected = method === "item/started" ? "554ed510ef9adc011a14b1d0045b2741c536a0f6a4728b07723537c31f088cb5"
        : method === "item/completed" ? "7f57001a4be1380e4d2d183ae76dafc2beb274a9e4401edc4bd676cc59e7d2a3"
        : method === "turn/completed" ? "2417c2c44801a090d921300b88a225c379a80fb559cdc96a72f6861514e1351a"
        : codexProtocolMethodDigest(previous, definition, method);
      expect(codexProtocolMethodDigest(schema, definition, method)).toBe(expected);
    }
  });

  it("keeps unknown releases and older gaps fail closed", () => {
    expect(codexContractStatus("codex-cli 0.164.0", execContract)).toEqual({ status: "verified", version: "0.164.0" });
    expect(codexContractStatus("codex-cli 0.164.1", execContract)).toEqual({ status: "unverified_older", version: "0.164.1" });
    expect(codexContractStatus("codex-cli 0.163.1", execContract)).toEqual({ status: "unverified_older", version: "0.163.1" });
    expect(() => verifyCodexProviderContracts({ version: "0.164.1", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget: "linux-x64" })).toThrow("Codex 0.164.1 is not verified");
  });

  it("rejects a changed published schema after version qualification", () => {
    expect(() => verifyCodexProviderContracts({ version: "0.164.0", execContract: historicalExecContract, appServerContract: historicalAppServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: Buffer.concat([schemaBytes, Buffer.from("\n")]),
      runtimeTarget: "darwin-arm64" })).toThrow("Codex app-server schema digest changed");
  });

  it("accounts for the complete experimental schema delta", () => {
    const reviewed = structuredClone(schema);
    const addedRequests = ["thread/sample", "thread/sample/cancel", "feedback/save"];
    const requests = reviewed.definitions.ClientRequest.oneOf;
    expect(requests.filter((variant: { properties: { method: { enum: string[] } } }) =>
      addedRequests.includes(variant.properties.method.enum[0])).map((variant: { properties: { method: { enum: string[] } } }) =>
      variant.properties.method.enum[0]).sort()).toEqual([...addedRequests].sort());
    reviewed.definitions.ClientRequest.oneOf = requests.filter((variant: { properties: { method: { enum: string[] } } }) =>
      !addedRequests.includes(variant.properties.method.enum[0]));

    const v2 = reviewed.definitions.v2;
    for (const definition of ["ApplicationStorageRequirements", "FeedbackSaveParams", "FeedbackSaveResponse",
      "ImageGenerationInputImage", "ThreadSampleCancelParams", "ThreadSampleCancelResponse", "ThreadSampleParams", "ThreadSampleResponse"]) {
      expect(v2[definition]).toBeDefined();
      delete v2[definition];
    }
    for (const [definition, additions] of [["HookEventName", ["preModelRequest", "postModelRequest"]],
      ["PlanType", ["sci", "sci_plus"]]] as const) {
      const values: readonly string[] = additions;
      expect(v2[definition].enum.filter((value: string) => values.includes(value))).toEqual([...values]);
      v2[definition].enum = v2[definition].enum.filter((value: string) => !values.includes(value));
    }
    for (const [definition, property] of [
      ["ApplicationRequirements", "storage"], ["ManagedHooksRequirements", "PreModelRequest"],
      ["ManagedHooksRequirements", "PostModelRequest"], ["McpServerStatus", "toolListMeta"],
      ["ThreadForkParams", "experimentalDisablePredictionMcp"], ["ThreadRealtimeStartParams", "voiceSessionId"],
      ["TurnStartParams", "responsesapiClientMetadataPatch"], ["TurnSteerParams", "responsesapiClientMetadataPatch"],
    ] as const) {
      expect(v2[definition].properties[property]).toBeDefined();
      delete v2[definition].properties[property];
    }
    for (const definition of ["ThreadForkParams", "TurnStartParams", "TurnSteerParams"] as const) {
      const property = definition === "ThreadForkParams" ? "experimentalPredictionMode" : "responsesapiClientMetadata";
      expect(v2[definition].properties[property].description).not.toBe(previous.definitions.v2[definition].properties[property].description);
      v2[definition].properties[property].description = previous.definitions.v2[definition].properties[property].description;
    }

    const imageItem = v2.ThreadItem.oneOf[15];
    expect(imageItem.properties.type.enum).toEqual(["imageGeneration"]);
    expect(imageItem.required).toEqual(["id", "status", "type"]);
    expect(imageItem.anyOf.map((variant: { required: string[] }) => variant.required)).toEqual([["fileId"], ["result"]]);
    expect(imageItem.anyOf.map((variant: { properties: Record<string, { type: string }> }) =>
      Object.values(variant.properties)[0]?.type)).toEqual(["string", "string"]);
    expect(imageItem.properties.result).toBeUndefined();
    expect(imageItem.properties.inputImages.items.$ref).toBe("#/definitions/v2/ImageGenerationInputImage");
    delete imageItem.anyOf;
    delete imageItem.description;
    delete imageItem.properties.inputImages;
    imageItem.properties.result = previous.definitions.v2.ThreadItem.oneOf[15].properties.result;
    imageItem.required = previous.definitions.v2.ThreadItem.oneOf[15].required;
    expect(reviewed).toEqual(previous);
  });
});
