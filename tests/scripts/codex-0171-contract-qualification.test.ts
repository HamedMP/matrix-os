import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexProtocolDefinitionDigest, codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

type Schema = { definitions: Record<string, any> };
type Delta = Array<{ path: string; operation: "remove" | "restore" }>;
type Variant = { properties: { method: { enum: string[] } } };

const fixture = (name: string) => gunzipSync(readFileSync(new URL(`../fixtures/codex-${name}/app-server-schema-${name}.json.gz`, import.meta.url)));
const delta = (name: string): Delta => JSON.parse(readFileSync(new URL(`../fixtures/codex-${name}/reviewed-delta.json`, import.meta.url), "utf8"));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const execBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const bytes = { "0169": fixture("0169"), "0170": fixture("0170"), "0171": fixture("0171"), "0172": fixture("0172") };
const schemas = Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, JSON.parse(value.toString())])) as Record<keyof typeof bytes, Schema>;

// Consumed digests that changed after 0.169.0. 0.169.x and 0.170.0 are retained
// exact records, so their checks reconstruct the historical consumed pins.
const consumed0169 = {
  "mcpServer/elicitation/request": "d164b1519690cfb0b5f353c8e6eb37087f720e7dcd81df4c145bc964f9416d05",
  "item/started": "617275c94854b1871af5371cbfdfdd88d03c66d681983ed82e3efeea1adec800",
  "item/completed": "bd38783bca8b6bd3ecf75796883f3784bffca1d7797c33b3248e43a754e92c0d",
  "turn/completed": "ea32be3552e720e9f07bffae9bb0b4270c0f33a7d86a1df9c701fc77197e3906",
};
const changed0170 = {
  "item/started": "eaf107de5620c148a28100d23dd6945144d80d4ec3acbff39afc5dc6d6938a10",
  "item/completed": "8a036a0125593390eb2fb90f146439dee351c63e3551eb1b195524d56c51e4b5",
  "turn/completed": "78c2fd6a7d434b930cbf4fd7a04422f1c8c83935a92f01f8d7bce642e025caa4",
};
const changed0171 = {
  "mcpServer/elicitation/request": "62f54dddd212962a5658c2ffe6009edcbead3a9c6890fd8f2b313a6b155ef2d8",
  "item/started": "1cf755b3b0248c131b3cce5356815d36693f883465cc466732e37545c7176f6d",
  "item/completed": "eb0ef6d56c7b04e2bc7965790427397d7968475fb05dcc5cbd623028f6ab845e",
  "turn/completed": "b6bd55f1da742df68c275dd2e016f76152bd705b223ef4fc5652446b3be6b3df",
};
const historical = (version: string, digests: Record<string, string>) => ({
  execContract: { ...execContract, latestVerifiedVersion: version },
  appServerContract: { ...appServerContract, latestVerifiedVersion: version,
    requiredServerProtocolSchemaDigests: { ...appServerContract.requiredServerProtocolSchemaDigests, ...digests } },
});

function normalize(schema: Schema, previous: Schema, reviewed: Delta) {
  const normalized = structuredClone(schema);
  for (const change of reviewed) {
    const parts = change.path.slice(1).split("/");
    const key = parts.pop()!;
    const parent = parts.reduce((value: any, part) => value[part], normalized);
    if (change.operation === "remove") {
      expect(parent).toHaveProperty(key);
      delete parent[key];
    } else {
      parent[key] = structuredClone(parts.reduce((value: any, part) => value[part], previous)[key]);
    }
  }
  return normalized;
}
const methods = (schema: Schema, definition: string) =>
  schema.definitions[definition].oneOf.map((variant: Variant) => variant.properties.method.enum[0]) as string[];
const changedConsumed = (schema: Schema, previous: Schema) => Object.fromEntries(
  [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications].flatMap(method => {
    const type = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
    const digest = codexProtocolMethodDigest(schema, type, method);
    return digest === codexProtocolMethodDigest(previous, type, method) ? [] : [[method, digest]];
  }));

describe("published Codex 0.169.1 through 0.172.0 qualification", () => {
  it("records exact paired versions with the unchanged exec JSONL source", () => {
    expect(execContract.latestVerifiedVersion).toBe("0.172.0");
    expect(appServerContract.latestVerifiedVersion).toBe("0.172.0");
    for (const version of ["0.169.1", "0.170.0", "0.171.0", "0.172.0"] as const) {
      expect(execContract.verifiedVersions[version]).toEqual(execContract.verifiedVersions["0.169.0"]);
    }
    expect(hash(execBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(appServerContract.verifiedVersions["0.169.1"]).toEqual(appServerContract.verifiedVersions["0.169.0"]);
    expect(appServerContract.verifiedVersions["0.170.0"]).toEqual({ schemaSha256: hash(bytes["0170"]) });
    expect(appServerContract.verifiedVersions["0.171.0"]).toEqual({ schemaSha256: hash(bytes["0171"]) });
    expect(appServerContract.verifiedVersions["0.172.0"]).toEqual({ schemaSha256: hash(bytes["0172"]) });
    expect(hash(bytes["0172"])).toBe("b0ba23a68f1985e614f2036c630f1b86307951f6348607bea3ce48f94b724ee6");
    expect(hash(bytes["0170"])).toBe("e3f3b0a75918871280e808a186b33f583ec4a9eb1a1038c2bd13d2ae1c5dc8db");
    expect(hash(bytes["0171"])).toBe("fe3f0cc67ec5f581743c802ee6e1369c32328d24f91faf4c6f5c697935db642c");
  });

  it.each(["linux-x64", "darwin-arm64"])("accepts every exact published record on %s", runtimeTarget => {
    const input = { execSchemaBytes: execBytes, runtimeTarget };
    expect(() => verifyCodexProviderContracts({ ...input, ...historical("0.169.1", consumed0169),
      version: "0.169.1", appServerSchemaBytes: bytes["0169"] })).not.toThrow();
    expect(() => verifyCodexProviderContracts({ ...input, ...historical("0.170.0", { ...consumed0169, ...changed0170 }),
      version: "0.170.0", appServerSchemaBytes: bytes["0170"] })).not.toThrow();
    expect(() => verifyCodexProviderContracts({ ...input, ...historical("0.171.0", changed0171),
      version: "0.171.0", appServerSchemaBytes: bytes["0171"] })).not.toThrow();
    expect(() => verifyCodexProviderContracts({ ...input, execContract, appServerContract,
      version: "0.172.0", appServerSchemaBytes: bytes["0172"] })).not.toThrow();
  });

  it("accounts for the complete 0.170.0 delta: display metadata, biometric context and a description", () => {
    expect(normalize(schemas["0170"], schemas["0169"], delta("0170"))).toEqual(schemas["0169"]);
    expect(changedConsumed(schemas["0170"], schemas["0169"])).toEqual(changed0170);
    const display = schemas["0170"].definitions.v2.AgentMessageDisplay;
    expect(display.oneOf.map((variant: { properties: { mode: { enum: string[] } } }) => variant.properties.mode.enum[0]))
      .toEqual(["show", "hide", "block"]);
    // The restructured display union is reachable only through optional moderation metadata.
    expect(schemas["0170"].definitions.v2.AgentMessageModeration.properties.display.anyOf[0])
      .toEqual({ $ref: "#/definitions/v2/AgentMessageDisplay" });
    expect(schemas["0170"].definitions.v2.UserVerificationVerifyResponse.required).toEqual(["proof"]);
    for (const definition of ["ClientRequest", "ServerRequest", "ServerNotification"]) {
      expect(methods(schemas["0170"], definition)).toEqual(methods(schemas["0169"], definition));
    }
  });

  it("accounts for the complete 0.171.0 delta while approval payloads keep their authority", () => {
    const [current, previous] = [schemas["0171"], schemas["0170"]];
    expect(normalize(current, previous, delta("0171"))).toEqual(previous);
    expect(changedConsumed(current, previous)).toEqual(changed0171);
    const added = (definition: string) => methods(current, definition).filter(method => !methods(previous, definition).includes(method)).sort();
    const removed = (definition: string) => methods(previous, definition).filter(method => !methods(current, definition).includes(method)).sort();
    expect(added("ClientRequest")).toEqual(["modelProvider/default/set", "thread/realtime/list", "thread/search/cancel",
      "thread/search/stream", "thread/search/stream/cancel"]);
    expect(removed("ClientRequest")).toEqual([]);
    expect([added("ServerRequest"), removed("ServerRequest")]).toEqual([[], ["currentTime/read"]]);
    expect([added("ServerNotification"), removed("ServerNotification")]).toEqual([["thread/search/partial"], []]);
    expect(appServerContract.requiredServerMethods).not.toContain("currentTime/read");

    // The elicitation change is one optional, nullable registration scope; required fields are unchanged.
    const elicitation = structuredClone(current.definitions.McpServerElicitationRequestParams);
    expect(elicitation.properties.environmentId.type).toEqual(["string", "null"]);
    expect(elicitation.required).toEqual(previous.definitions.McpServerElicitationRequestParams.required);
    delete elicitation.properties.environmentId;
    expect(elicitation).toEqual(previous.definitions.McpServerElicitationRequestParams);

    // Thread items change only through the same optional scope on MCP tool calls.
    const items = structuredClone(current.definitions.v2.ThreadItem);
    expect(items.oneOf[8].properties.type.enum).toEqual(["mcpToolCall"]);
    expect(items.oneOf[8].required).not.toContain("environmentId");
    delete items.oneOf[8].properties.environmentId;
    expect(items).toEqual(previous.definitions.v2.ThreadItem);

    // Turn errors add one policy code; Matrix keeps it a failed turn without a typed reason.
    const errors = current.definitions.v2.CodexErrorInfo.anyOf[0].enum as string[];
    expect(errors.filter(code => !previous.definitions.v2.CodexErrorInfo.anyOf[0].enum.includes(code))).toEqual(["bioPolicy"]);
  });

  it("accounts for the complete 0.172.0 delta and keeps approval requests unchanged", () => {
    const [current, previous] = [schemas["0172"], schemas["0171"]];
    expect(normalize(current, previous, delta("0172"))).toEqual(previous);
    for (const definition of ["ClientRequest", "ServerRequest", "ServerNotification"]) {
      expect(methods(current, definition)).toEqual(methods(previous, definition));
    }
    expect(changedConsumed(current, previous)).toEqual({
      "turn/completed": "89bf8943994c4d1313dc0e6d17d4f4c47056257d136d1c3e6ca8bbbc97268276",
    });

    const errors = structuredClone(current.definitions.v2.CodexErrorInfo);
    const previousErrors = previous.definitions.v2.CodexErrorInfo;
    const added = ["apiKeySpendLimitExceeded", "projectSpendLimitExceeded", "organizationSpendLimitExceeded"];
    const previousCodes = previousErrors.anyOf[0].enum as string[];
    expect(errors.anyOf[0].enum.filter((code: string) => !previousCodes.includes(code))).toEqual(added);
    errors.anyOf[0].enum = errors.anyOf[0].enum.filter((code: string) => !added.includes(code));
    expect(errors).toEqual(previousErrors);

    const start = structuredClone(current.definitions.v2.ThreadStartParams);
    expect(start.properties.daybreakProgramPropagationEnrolled.type).toEqual(["boolean", "null"]);
    delete start.properties.daybreakProgramPropagationEnrolled;
    expect(start).toEqual(previous.definitions.v2.ThreadStartParams);
  });

  it("retains the reviewed routine bridge protocol for each new exact release", () => {
    const routines = appServerContract.routineProtocolsByVersion;
    for (const [version, name] of [["0.169.1", "0169"], ["0.170.0", "0170"], ["0.171.0", "0171"]] as const) {
      expect(routines[version]).toEqual(routines["0.169.0"]);
      for (const [method, digest] of Object.entries(routines[version].client)) {
        expect(codexProtocolMethodDigest(schemas[name], "ClientRequest", method)).toBe(digest);
      }
      for (const [definition, digest] of Object.entries(routines[version].definitions)) {
        expect(codexProtocolDefinitionDigest(schemas[name], definition)).toBe(digest);
      }
    }
  });

  it("rejects unknown versions, altered vendor bytes and changed consumed approval semantics", () => {
    expect(codexContractStatus("codex-cli 0.171.0", execContract)).toEqual({ status: "verified", version: "0.171.0" });
    expect(codexContractStatus("codex-cli 0.170.1", execContract)).toEqual({ status: "unverified_older", version: "0.170.1" });
    expect(codexContractStatus("codex-cli 0.171.1", execContract)).toEqual({ status: "unverified_older", version: "0.171.1" });
    expect(codexContractStatus("codex-cli 0.173.0", execContract)).toEqual({ status: "unverified_newer", version: "0.173.0" });
    const input = { version: "0.172.0", execContract, appServerContract, execSchemaBytes: execBytes,
      appServerSchemaBytes: bytes["0172"], runtimeTarget: "linux-x64" };
    for (const version of ["0.170.1", "0.171.1", "0.173.0"]) {
      expect(() => verifyCodexProviderContracts({ ...input, version })).toThrow(`Codex ${version} is not verified`);
    }
    expect(() => verifyCodexProviderContracts({ ...input, appServerSchemaBytes: Buffer.concat([bytes["0172"], Buffer.from("\n")]) }))
      .toThrow("Codex app-server schema digest changed");
    for (const method of ["item/permissions/requestApproval", "mcpServer/elicitation/request"]) {
      const altered = structuredClone(schemas["0172"]);
      altered.definitions.ServerRequest.oneOf.find((variant: Variant) => variant.properties.method.enum.includes(method))
        .description = "unreviewed authority change";
      const alteredBytes = Buffer.from(JSON.stringify(altered));
      expect(() => verifyCodexProviderContracts({ ...input, appServerSchemaBytes: alteredBytes,
        appServerContract: { ...appServerContract, verifiedVersions: { ...appServerContract.verifiedVersions,
          "0.172.0": { schemaSha256: hash(alteredBytes) } } } })).toThrow("Codex app-server payload schema changed");
    }
  });
});
