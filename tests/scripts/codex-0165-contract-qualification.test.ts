import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexTerminalFailureReason } from "../../packages/gateway/src/coding-agents/codex-terminal-failure.mjs";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const execBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const schemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0165/app-server-schema-0165.json.gz", import.meta.url)));
const previousBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0164/app-server-schema-0164.json.gz", import.meta.url)));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const previous = JSON.parse(previousBytes.toString("utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("exact published Codex 0.165.0 qualification", () => {
  it.each(["linux-x64", "darwin-arm64"])("verifies official bytes and consumed payloads on %s", runtimeTarget => {
    expect(sha256(execBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(sha256(schemaBytes)).toBe("8c2a3adebb3e0da97f9b1efaf686f8d14f9969436879ade25a4b1b208ec65cd7");
    expect(() => verifyCodexProviderContracts({ version: "0.165.0", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget })).not.toThrow();
    for (const method of [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications]) {
      const definition = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
      expect(codexProtocolMethodDigest(schema, definition, method)).toBe(method === "turn/completed"
        ? "d775b4d4e65c194a34726c88625fd88f71e5ffc00cd5ba5a6bc64ac913a90055"
        : codexProtocolMethodDigest(previous, definition, method));
    }
  });

  it("keeps unknown releases and older gaps fail closed", () => {
    expect(codexContractStatus("codex-cli 0.165.0", execContract)).toEqual({ status: "verified", version: "0.165.0" });
    expect(codexContractStatus("codex-cli 0.165.1", execContract)).toEqual({ status: "unverified_newer", version: "0.165.1" });
    expect(codexContractStatus("codex-cli 0.164.1", execContract)).toEqual({ status: "unverified_older", version: "0.164.1" });
    expect(() => verifyCodexProviderContracts({ version: "0.165.1", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget: "linux-x64" })).toThrow("Codex 0.165.1 is not verified");
  });

  it("rejects a changed published schema after version qualification", () => {
    expect(() => verifyCodexProviderContracts({ version: "0.165.0", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: Buffer.concat([schemaBytes, Buffer.from("\n")]),
      runtimeTarget: "darwin-arm64" })).toThrow("Codex app-server schema digest changed");
  });

  it("accounts for the entire schema delta and retains safe handling of the added error kind", () => {
    const reviewed = structuredClone(schema);
    const requests = reviewed.definitions.ClientRequest.oneOf;
    expect(requests.filter((variant: { properties: { method: { enum: string[] } } }) =>
      variant.properties.method.enum[0] === "thread/memory/read")).toHaveLength(1);
    reviewed.definitions.ClientRequest.oneOf = requests.filter((variant: { properties: { method: { enum: string[] } } }) =>
      variant.properties.method.enum[0] !== "thread/memory/read");

    const v2 = reviewed.definitions.v2;
    for (const definition of ["ThreadMemoryReadParams", "ThreadMemoryReadResponse"]) {
      expect(v2[definition]).toBeDefined();
      delete v2[definition];
    }
    expect(v2.Account.oneOf.at(-1)).toEqual({
      description: "Google Cloud Vertex AI with externally managed credentials.",
      properties: { type: { enum: ["gcp"], title: "GcpAccountType", type: "string" } },
      required: ["type"], title: "GcpAccount", type: "object",
    });
    v2.Account.oneOf.pop();
    expect(v2.CodexErrorInfo.anyOf[0].enum.filter((value: string) => !previous.definitions.v2.CodexErrorInfo.anyOf[0].enum.includes(value)))
      .toEqual(["modelNotFound"]);
    v2.CodexErrorInfo.anyOf[0].enum = v2.CodexErrorInfo.anyOf[0].enum.filter((value: string) => value !== "modelNotFound");
    // The new typed model error must not fall through to message-based auth classification.
    expect(codexTerminalFailureReason({ codexErrorInfo: "modelNotFound", message: "Not logged in" })).toBeUndefined();
    for (const [definition, property] of [
      ["NetworkRequirements", "reviewDomains"], ["ThreadForkParams", "attachToSource"],
      ["ThreadListParams", "attachedToThreadId"], ["ThreadSampleParams", "threadSource"],
    ] as const) {
      expect(v2[definition].properties[property]).toBeDefined();
      expect(v2[definition].required ?? []).not.toContain(property);
      delete v2[definition].properties[property];
    }
    expect(reviewed).toEqual(previous);
  });
});
