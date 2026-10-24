import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const execSchemaBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const appServerSchemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0163/app-server-schema-0163.json.gz", import.meta.url)));
const previousBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0162/app-server-schema-0162.json.gz", import.meta.url)));
const schema = JSON.parse(appServerSchemaBytes.toString("utf8"));
const previous = JSON.parse(previousBytes.toString("utf8"));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("exact published Codex 0.163.0 qualification", () => {
  it.each(["darwin-arm64", "linux-x64"])("qualifies the exact published bytes on %s without changing consumed payloads", runtimeTarget => {
    expect(digest(execSchemaBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(digest(appServerSchemaBytes)).toBe("43e8c1495557ca91e33a63bbfae36c311c206253afae2974c979dbdf5d940c71");
    const historicalDigests = Object.fromEntries(
      [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications].map(method => [
        method, codexProtocolMethodDigest(schema,
          appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification", method),
      ]),
    );
    expect(() => verifyCodexProviderContracts({ version: "0.163.0",
      execContract: { ...execContract, latestVerifiedVersion: "0.163.0" },
      appServerContract: { ...appServerContract, latestVerifiedVersion: "0.163.0",
        requiredServerProtocolSchemaDigests: historicalDigests },
      execSchemaBytes, appServerSchemaBytes, runtimeTarget })).not.toThrow();
    for (const method of [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications]) {
      const definition = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
      expect(codexProtocolMethodDigest(schema, definition, method)).toBe(codexProtocolMethodDigest(previous, definition, method));
    }
  });

  it("rejects an unreviewed next version even with the exact qualified schema bytes", () => {
    expect(codexContractStatus("codex-cli 0.163.0", execContract)).toEqual({ status: "verified", version: "0.163.0" });
    expect(codexContractStatus("codex-cli 0.163.1", execContract)).toEqual({ status: "unverified_older", version: "0.163.1" });
    expect(() => verifyCodexProviderContracts({ version: "0.163.1", execContract, appServerContract,
      execSchemaBytes, appServerSchemaBytes, runtimeTarget: "darwin-arm64" })).toThrow("Codex 0.163.1 is not verified");
  });

  it("rejects changed schema bytes after version qualification", () => {
    expect(() => verifyCodexProviderContracts({ version: "0.163.0",
      execContract: { ...execContract, latestVerifiedVersion: "0.163.0" },
      appServerContract: { ...appServerContract, latestVerifiedVersion: "0.163.0" }, execSchemaBytes,
      appServerSchemaBytes: Buffer.concat([appServerSchemaBytes, Buffer.from("\n")]), runtimeTarget: "darwin-arm64" }))
      .toThrow("Codex app-server schema digest changed");
  });

  it("accounts for the complete experimental schema delta, including unconsumed definitions", () => {
    const reviewed = structuredClone(schema);
    for (const [definition, additions] of [
      ["ClientRequest", ["thread/items/read", "thread/readState/update"]],
      ["ServerNotification", ["thread/readState/changed"]],
    ] as const) {
      const variants = reviewed.definitions[definition].oneOf;
      expect(variants.filter((variant: { properties: { method: { enum: string[] } } }) =>
        (additions as readonly string[]).includes(variant.properties.method.enum[0])).map((variant: { properties: { method: { enum: string[] } } }) =>
        variant.properties.method.enum[0]).sort()).toEqual([...additions].sort());
      reviewed.definitions[definition].oneOf = variants.filter((variant: { properties: { method: { enum: string[] } } }) =>
        !(additions as readonly string[]).includes(variant.properties.method.enum[0]));
    }
    for (const definition of ["ThreadItemsReadParams", "ThreadItemsReadResponse", "ThreadReadState", "ThreadReadStateChangedNotification",
      "ThreadReadStateOperation", "ThreadReadStateUpdateParams", "ThreadReadStateUpdateResponse", "ThreadUnreadPosition"]) {
      expect(reviewed.definitions.v2[definition]).toBeDefined();
      delete reviewed.definitions.v2[definition];
    }
    // These exact optional properties are not consumed by Matrix. No required list changed.
    for (const pointer of [
      "ContentItem/oneOf/3/properties/annotations", "ContentItem/oneOf/3/properties/logprobs",
      "EnvironmentAddParams/properties/websocketRequestId", "RealtimeVoicesList/properties/v3",
      "ResponseItem/oneOf/1/properties/encrypted_content", "ResponseItem/oneOf/1/properties/status",
      "ResponseItem/oneOf/4/properties/encrypted_content", "ResponseItem/oneOf/5/properties/encrypted_content",
      "ResponseItem/oneOf/5/properties/status", "ResponseItem/oneOf/6/properties/encrypted_content",
      "ResponseItem/oneOf/8/properties/encrypted_content", "ResponseItem/oneOf/11/properties/encrypted_content",
      "ResponseItem/oneOf/12/properties/encrypted_content", "ThreadForkParams/properties/experimentalPredictionMode",
      "ThreadListParams/properties/excludedThreadIds", "ThreadListResponse/properties/readStates",
      "ThreadReadResponse/properties/readState", "TurnToolOutput/properties/retain",
    ]) {
      const segments = pointer.split("/");
      const property = segments.pop()!;
      const parent = segments.reduce((value, key) => value[key], reviewed.definitions.v2);
      expect(parent[property]).toBeDefined();
      delete parent[property];
    }
    const voices = ["aube", "bubbie", "haetsal", "hanul", "himari", "leher", "miko", "neer", "porto", "rindo", "rio", "rivage", "selva", "sonna", "tinta", "viola"];
    expect(reviewed.definitions.v2.RealtimeVoice.enum.filter((voice: string) => !previous.definitions.v2.RealtimeVoice.enum.includes(voice))).toEqual(voices);
    reviewed.definitions.v2.RealtimeVoice.enum = reviewed.definitions.v2.RealtimeVoice.enum.filter((voice: string) => !voices.includes(voice));
    expect(reviewed).toEqual(previous);
  });
});
