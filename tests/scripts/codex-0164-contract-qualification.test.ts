import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

// Exact official @openai/codex@0.164.0 --experimental generator, also independently
// identical on Linux x64 / Darwin arm64 in provider-contract run 39964396848.
// https://github.com/openai/codex/releases/tag/rust-v0.164.0
// https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/items/src/image_generation.rs
// This qualifies parsing, not Settings login, recipients or image-file retrieval.
const execSchemaBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const appServerSchemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0164/app-server-schema-0164.json.gz", import.meta.url)));
const schema = JSON.parse(appServerSchemaBytes.toString("utf8"));
const previous = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/codex-0163/app-server-schema-0163.json.gz", import.meta.url))).toString("utf8"));
const changedDigests = {
  "item/started": "554ed510ef9adc011a14b1d0045b2741c536a0f6a4728b07723537c31f088cb5",
  "item/completed": "7f57001a4be1380e4d2d183ae76dafc2beb274a9e4401edc4bd676cc59e7d2a3",
  "turn/completed": "2417c2c44801a090d921300b88a225c379a80fb559cdc96a72f6861514e1351a",
};

describe("exact published Codex 0.164.0 parsing qualification", () => {
  it.each(["darwin-arm64", "linux-x64"])("accepts exact bytes and bounds all eleven consumed payloads on %s", runtimeTarget => {
    expect(createHash("sha256").update(execSchemaBytes).digest("hex")).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(createHash("sha256").update(appServerSchemaBytes).digest("hex")).toBe("92fe055424a3709999a05baae615be9e1e1e0b127e033cace6849b2ea785ea07");
    expect(() => verifyCodexProviderContracts({ version: "0.164.0", execContract, appServerContract,
      execSchemaBytes, appServerSchemaBytes, runtimeTarget })).not.toThrow();
    for (const method of [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications]) {
      const definition = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
      expect(codexProtocolMethodDigest(schema, definition, method)).toBe(changedDigests[method as keyof typeof changedDigests]
        ?? codexProtocolMethodDigest(previous, definition, method));
    }
  });

  it.each(["0.164.1", "0.165.0", "invalid", "0.164.0-extra"])("rejects unqualified or malformed %s with valid published bytes", version => {
    expect(() => verifyCodexProviderContracts({ version, execContract, appServerContract,
      execSchemaBytes, appServerSchemaBytes })).toThrow();
    expect(codexContractStatus(`codex-cli ${version}`, execContract).status).toBe(
      /^\d+\.\d+\.\d+$/.test(version) ? "unverified_newer" : "invalid",
    );
  });

  it("rejects changed bytes after qualification", () => {
    expect(() => verifyCodexProviderContracts({ version: "0.164.0", execContract, appServerContract, execSchemaBytes,
      appServerSchemaBytes: Buffer.concat([appServerSchemaBytes, Buffer.from("\n")]) })).toThrow("Codex app-server schema digest changed");
  });

  it("pins the file-id alternative without treating it as a local path or requiring old inline data", () => {
    const image = schema.definitions.v2.ThreadItem.oneOf.find((value: { properties: { type: { enum: string[] } } }) => value.properties.type.enum[0] === "imageGeneration");
    expect(image.required).toEqual(["id", "status", "type"]);
    expect(image.anyOf).toEqual([
      { properties: { fileId: { type: "string" } }, required: ["fileId"], title: "FileIdThreadItem", type: "object" },
      { properties: { result: { type: "string" } }, required: ["result"], title: "ResultThreadItem", type: "object" },
    ]);
    expect(image.properties.inputImages.items.$ref).toBe("#/definitions/v2/ImageGenerationInputImage");
    expect(schema.definitions.v2.ImageGenerationInputImage.required).toEqual(["path", "sha256"]);
  });

  it("accounts for the complete raw delta, including unconsumed requests, account plans and configuration", () => {
    const reviewed = structuredClone(schema);
    const additions = ["feedback/save", "thread/sample", "thread/sample/cancel"];
    const variants = reviewed.definitions.ClientRequest.oneOf;
    expect(variants.filter((value: { properties: { method: { enum: string[] } } }) => additions.includes(value.properties.method.enum[0]))
      .map((value: { properties: { method: { enum: string[] } } }) => value.properties.method.enum[0]).sort()).toEqual(additions);
    reviewed.definitions.ClientRequest.oneOf = variants.filter((value: { properties: { method: { enum: string[] } } }) => !additions.includes(value.properties.method.enum[0]));
    for (const name of ["ApplicationStorageRequirements", "FeedbackSaveParams", "FeedbackSaveResponse", "ImageGenerationInputImage",
      "ThreadSampleCancelParams", "ThreadSampleCancelResponse", "ThreadSampleParams", "ThreadSampleResponse"]) {
      expect(reviewed.definitions.v2[name]).toBeDefined();
      delete reviewed.definitions.v2[name];
    }
    for (const [name, properties] of Object.entries({ ApplicationRequirements: ["storage"],
      ManagedHooksRequirements: ["PostModelRequest", "PreModelRequest"], McpServerStatus: ["toolListMeta"],
      ThreadForkParams: ["experimentalDisablePredictionMcp"], ThreadRealtimeStartParams: ["voiceSessionId"],
      TurnStartParams: ["responsesapiClientMetadataPatch"], TurnSteerParams: ["responsesapiClientMetadataPatch"] })) {
      for (const property of properties) { expect(reviewed.definitions.v2[name].properties[property]).toBeDefined(); delete reviewed.definitions.v2[name].properties[property]; }
    }
    for (const [name, values] of Object.entries({ HookEventName: ["preModelRequest", "postModelRequest"], PlanType: ["sci", "sci_plus"] })) {
      expect(reviewed.definitions.v2[name].enum.filter((value: string) => !previous.definitions.v2[name].enum.includes(value))).toEqual(values);
      reviewed.definitions.v2[name].enum = reviewed.definitions.v2[name].enum.filter((value: string) => !values.includes(value));
    }
    for (const [name, property] of [["ThreadForkParams", "experimentalPredictionMode"], ["TurnStartParams", "responsesapiClientMetadata"], ["TurnSteerParams", "responsesapiClientMetadata"]]) {
      expect(reviewed.definitions.v2[name].properties[property].description).not.toBe(previous.definitions.v2[name].properties[property].description);
      reviewed.definitions.v2[name].properties[property].description = previous.definitions.v2[name].properties[property].description;
    }
    const index = reviewed.definitions.v2.ThreadItem.oneOf.findIndex((value: { properties: { type: { enum: string[] } } }) => value.properties.type.enum[0] === "imageGeneration");
    const image = reviewed.definitions.v2.ThreadItem.oneOf[index];
    expect(image.description).toBe("Either inline generated-image data or its durable attachment-store identity.\n\n`File` must remain first so rollouts written during the migration, which contain both an empty `result` and a `fileId`, retain the file reference when deserialized.");
    delete image.description;
    expect(image.properties.inputImages).toEqual({ description: "Observed local inputs for a completed generation, absent on older items.",
      items: { $ref: "#/definitions/v2/ImageGenerationInputImage" }, type: "array" });
    delete image.properties.inputImages;
    image.properties.result = image.anyOf[1].properties.result;
    delete image.anyOf;
    image.required = ["id", "result", "status", "type"];
    expect(reviewed).toEqual(previous);
  });
});
