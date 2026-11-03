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
const schemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0166/app-server-schema-0166.json.gz", import.meta.url)));
const previousBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0165/app-server-schema-0165.json.gz", import.meta.url)));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const previous = JSON.parse(previousBytes.toString("utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("exact published Codex 0.166.0 qualification", () => {
  it.each(["linux-x64", "darwin-arm64"])("verifies official bytes and consumed payloads on %s", runtimeTarget => {
    expect(sha256(execBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(sha256(schemaBytes)).toBe("8aabf260bb66e9ca9ae5d20253f443971834644fe4659c85f8b1cc9e1d22dd5c");
    expect(() => verifyCodexProviderContracts({ version: "0.166.0", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget })).not.toThrow();
    expect(Object.fromEntries([
      ...appServerContract.requiredServerMethods.map(method => [method,
        codexProtocolMethodDigest(schema, "ServerRequest", method)]),
      ...appServerContract.requiredServerNotifications.map(method => [method,
        codexProtocolMethodDigest(schema, "ServerNotification", method)]),
    ])).toEqual({
      "item/commandExecution/requestApproval": "ef803ac64161397389bc35428803c3ec8dcc94757c93d758a9fdf0ae6b5a944f",
      "item/fileChange/requestApproval": "ac5be166d6a7668792b810a97be8bdfb02b2107320d93d0c4d783a11d32d8cf9",
      "item/tool/requestUserInput": "f998a4ecef0e0d5dfc1bf5a093ee77663ec0b9f4dc71c41e02b8c13136f439c2",
      "item/permissions/requestApproval": "a264aef4e3b05a7725eedc504148c96d2200c35a326463d5058b4c134e3890cf",
      "mcpServer/elicitation/request": "d164b1519690cfb0b5f353c8e6eb37087f720e7dcd81df4c145bc964f9416d05",
      "item/started": "bedd6a6e59c26dba37deec380efa34ef88a4fa65902440f7b5c9977f33302529",
      "item/completed": "8ec2ff52d10fe877ce3353550dd0cbd9f4ca7358f8f47a572807994ae08a16c7",
      "item/agentMessage/delta": "427d58ea4e1b0fd7afce1035cefd40df96d7dc48b82cbe293a2f69ed4e803bf9",
      "item/commandExecution/outputDelta": "aa94a86bcbf20ceca1672b7c476c3472ef5e507b831ceb26561c2785a97a5dc4",
      "thread/tokenUsage/updated": "5dbf1e2a382453af89a44bf72660aade96c8a549068d5bb55ca56951a30505d7",
      "turn/completed": "e8d4a5e2287d87bfcea1fc04428f44545ce243ef56381cbf6c8102f423f63dde",
    });
  });

  it("keeps unknown releases and older gaps fail closed", () => {
    expect(codexContractStatus("codex-cli 0.166.0", execContract)).toEqual({ status: "verified", version: "0.166.0" });
    expect(codexContractStatus("codex-cli 0.166.1", execContract)).toEqual({ status: "unverified_newer", version: "0.166.1" });
    expect(codexContractStatus("codex-cli 0.165.1", execContract)).toEqual({ status: "unverified_older", version: "0.165.1" });
    expect(() => verifyCodexProviderContracts({ version: "0.166.1", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget: "linux-x64" })).toThrow("Codex 0.166.1 is not verified");
  });

  it("rejects a changed published schema after version qualification", () => {
    expect(() => verifyCodexProviderContracts({ version: "0.166.0", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: Buffer.concat([schemaBytes, Buffer.from("\n")]),
      runtimeTarget: "darwin-arm64" })).toThrow("Codex app-server schema digest changed");
  });

  it("accounts for the entire schema delta and keeps unknown typed failures fail closed", () => {
    const reviewed = structuredClone(schema);
    const requests = reviewed.definitions.ClientRequest.oneOf;
    const addedMethods = ["account/gcp/setup", "accountSession/list", "accountSession/switch"];
    expect(requests.filter((variant: { properties: { method: { enum: string[] } } }) =>
      addedMethods.includes(variant.properties.method.enum[0])).map(
        (variant: { properties: { method: { enum: string[] } } }) => variant.properties.method.enum[0],
      )).toEqual(addedMethods);
    reviewed.definitions.ClientRequest.oneOf = requests.filter(
      (variant: { properties: { method: { enum: string[] } } }) => !addedMethods.includes(variant.properties.method.enum[0]),
    );

    const v2 = reviewed.definitions.v2;
    for (const definition of [
      "AccountSession", "AccountSessionWorkspace", "AccountSessionWorkspaceKind",
      "AccountSessionsListParams", "AccountSessionsResponse", "AccountSessionsSwitchParams",
      "AccountSessionsSwitchResponse", "GcpSetupParams", "GcpSetupResponse", "ModelProviderError",
      "OtelExporter", "OtelHttpProtocol", "OtelRequirements", "OtelTlsConfig", "OtelToolResultLogConfig",
    ]) {
      expect(v2[definition]).toBeDefined();
      delete v2[definition];
    }

    delete v2.Account.oneOf[1].properties.workspaceName;
    delete v2.AdditionalContextEntry.properties.name;
    v2.CodexErrorInfo.anyOf[0].enum = v2.CodexErrorInfo.anyOf[0].enum.filter(
      (value: string) => value !== "policyCapacityUnavailable",
    );
    expect(codexTerminalFailureReason({ codexErrorInfo: "policyCapacityUnavailable", message: "Not logged in" })).toBeUndefined();
    delete v2.ConfigRequirements.properties.otel;
    delete v2.HookMetadata.properties.environmentId;
    v2.HookRunSummary.properties.sourcePath = previous.definitions.v2.HookRunSummary.properties.sourcePath;
    v2.HooksListParams.properties.cwds.description = previous.definitions.v2.HooksListParams.properties.cwds.description;
    delete v2.HooksListParams.properties.threadId;
    v2.NetworkRequirements.properties.domains.description = previous.definitions.v2.NetworkRequirements.properties.domains.description;
    v2.NetworkRequirements.properties.unixSockets.description = previous.definitions.v2.NetworkRequirements.properties.unixSockets.description;
    delete v2.ProcessExitedNotification.properties.outputDrainTimedOut;
    v2.ReviewDelivery = previous.definitions.v2.ReviewDelivery;
    v2.ReviewStartParams.properties.delivery.description = previous.definitions.v2.ReviewStartParams.properties.delivery.description;
    v2.ReviewStartResponse.properties.reviewThreadId.description = previous.definitions.v2.ReviewStartResponse.properties.reviewThreadId.description;
    v2.ThreadForkParams.properties.attachToSource.description = previous.definitions.v2.ThreadForkParams.properties.attachToSource.description;
    delete v2.ThreadItem.description;
    delete v2.ThreadItem.properties;
    delete v2.ThreadItem.type;
    const imageGeneration = v2.ThreadItem.oneOf.find(
      (variant: { properties: { type: { enum: string[] } } }) => variant.properties.type.enum[0] === "imageGeneration",
    );
    expect(imageGeneration.properties.generationId).toBeDefined();
    delete imageGeneration.properties.generationId;
    delete v2.ThreadUsage.properties.nativeUsageUsdMicros;

    expect(reviewed).toEqual(previous);
  });
});
