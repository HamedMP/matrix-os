import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import execContract from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import appServerContract from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import { codexContractStatus } from "../../packages/gateway/src/coding-agents/codex-contract-version.js";
import { codexProtocolMethodDigest, verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const execBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const schemaBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0167/app-server-schema-0167.json.gz", import.meta.url)));
const previousBytes = gunzipSync(readFileSync(new URL("../fixtures/codex-0166/app-server-schema-0166.json.gz", import.meta.url)));
const schema = JSON.parse(schemaBytes.toString("utf8"));
const previous = JSON.parse(previousBytes.toString("utf8"));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const changedMethodDigests: Record<string, string> = {
  "item/commandExecution/requestApproval": "4305e3c4d4828ca41a134cae982cf47f59d70e56390e1f07d33691f5d701c890",
  "item/started": "91a60058ca9e9b9dee61f91aa674d5577f48ab94ecd80833b7500573ed19d644",
  "item/completed": "091914fa7fb2f8aa285ce5c2452b3abbd7177c6d7193d56d7bb3e8c0f1dcddff",
  "turn/completed": "a422130287e89c148ef74c9c38773df548c11153e68cfd57409705154ca16940",
};

const historicalAppServerContract = { ...appServerContract, requiredServerProtocolSchemaDigests: {
  ...appServerContract.requiredServerProtocolSchemaDigests, ...changedMethodDigests,
} };

type ProtocolVariant = { properties: { method: { enum: string[] } } };

describe("exact published Codex 0.167.x qualification", () => {
  it.each(["linux-x64", "darwin-arm64"])("verifies official bytes and consumed payloads on %s", runtimeTarget => {
    expect(sha256(execBytes)).toBe("dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5");
    expect(sha256(schemaBytes)).toBe("486c7c8daa5dc7f3ab2a1fb56de5316804caf7a4210fda1dc28d3f0f4e90cfe1");
    expect(() => verifyCodexProviderContracts({
      version: "0.167.0",
      execContract: { ...execContract, latestVerifiedVersion: "0.167.0" },
      appServerContract: { ...historicalAppServerContract, latestVerifiedVersion: "0.167.0" },
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget,
    })).not.toThrow();
  });

  it.each([
    ["0.167.1", "linux-x64"], ["0.167.1", "darwin-arm64"],
    ["0.167.2", "linux-x64"], ["0.167.2", "darwin-arm64"],
  ])("verifies identical published %s schemas on %s", (version, runtimeTarget) => {
    expect(execContract.verifiedVersions[version as keyof typeof execContract.verifiedVersions]).toEqual(execContract.verifiedVersions["0.167.0"]);
    expect(appServerContract.verifiedVersions[version as keyof typeof appServerContract.verifiedVersions]).toEqual(appServerContract.verifiedVersions["0.167.0"]);
    expect(() => verifyCodexProviderContracts({
      version,
      execContract: { ...execContract, latestVerifiedVersion: version },
      appServerContract: { ...historicalAppServerContract, latestVerifiedVersion: version },
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget,
    })).not.toThrow();
  });

  it("accounts for all changed consumed method digests", () => {
    const changed = Object.fromEntries(
      [...appServerContract.requiredServerMethods, ...appServerContract.requiredServerNotifications].flatMap(method => {
        const definition = appServerContract.requiredServerMethods.includes(method) ? "ServerRequest" : "ServerNotification";
        const digest = codexProtocolMethodDigest(schema, definition, method);
        return digest === codexProtocolMethodDigest(previous, definition, method) ? [] : [[method, digest]];
      }),
    );
    expect(changed).toEqual(changedMethodDigests);
  });

  it("keeps unknown releases fail closed and detects altered published bytes", () => {
    expect(codexContractStatus("codex-cli 0.167.0", execContract)).toEqual({ status: "verified", version: "0.167.0" });
    expect(codexContractStatus("codex-cli 0.167.1", execContract)).toEqual({ status: "verified", version: "0.167.1" });
    expect(codexContractStatus("codex-cli 0.167.2", execContract)).toEqual({ status: "verified", version: "0.167.2" });
    expect(codexContractStatus("codex-cli 0.166.1", execContract)).toEqual({ status: "unverified_older", version: "0.166.1" });
    expect(() => verifyCodexProviderContracts({
      version: "0.167.3", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget: "linux-x64",
    })).toThrow("Codex 0.167.3 is not verified");
    expect(() => verifyCodexProviderContracts({
      version: "0.167.99", execContract, appServerContract,
      execSchemaBytes: execBytes, appServerSchemaBytes: schemaBytes, runtimeTarget: "linux-x64",
    })).toThrow("Codex 0.167.99 is not verified");
    expect(() => verifyCodexProviderContracts({
      version: "0.167.2", execContract: { ...execContract, latestVerifiedVersion: "0.167.2" },
      appServerContract: { ...historicalAppServerContract, latestVerifiedVersion: "0.167.2" },
      execSchemaBytes: execBytes, appServerSchemaBytes: Buffer.concat([schemaBytes, Buffer.from("\n")]),
      runtimeTarget: "darwin-arm64",
    })).toThrow("Codex app-server schema digest changed");
  });

  it("accounts for the full schema delta, including changes outside the consumed payloads", () => {
    const reviewed = structuredClone(schema);
    const definitions = reviewed.definitions;
    const priorDefinitions = previous.definitions;
    for (const [definition, method] of [
      ["ClientRequest", "thread/guardianReview"],
      ["ServerNotification", "thread/section/changed"],
    ]) {
      const variants: ProtocolVariant[] = definitions[definition].oneOf;
      const retained = variants.filter(variant => variant.properties.method.enum[0] !== method);
      expect(variants.length - retained.length).toBe(1);
      definitions[definition].oneOf = retained;
    }

    const approvalKind = definitions.CommandExecutionApprovalKind;
    expect(approvalKind.oneOf[0]).toEqual({ enum: ["command", "writeStdin"], type: "string" });
    expect(approvalKind.oneOf[1]).toMatchObject({ enum: ["humanCommand"], type: "string" });
    definitions.CommandExecutionApprovalKind = priorDefinitions.CommandExecutionApprovalKind;
    expect(definitions.InitializeCapabilities.properties.requiredHumanApproval).toMatchObject({ type: "boolean" });
    delete definitions.InitializeCapabilities.properties.requiredHumanApproval;

    const v2 = definitions.v2;
    for (const definition of [
      "GuardianAssessmentOutcome", "ThreadGuardianAssessment", "ThreadGuardianReviewParams",
      "ThreadGuardianReviewResponse", "ThreadSectionChangedNotification",
    ]) {
      expect(v2[definition]).toBeDefined();
      delete v2[definition];
    }
    expect(v2.OtelRequirements.properties.log_sse_deltas.type).toEqual(["boolean", "null"]);
    delete v2.OtelRequirements.properties.log_sse_deltas;
    expect(v2.ThreadSampleParams.properties.interruptOnCancel.type).toEqual(["boolean", "null"]);
    delete v2.ThreadSampleParams.properties.interruptOnCancel;

    for (const [definition, index, urlKey, fileKey] of [
      ["ContentItem", 2, "audio_url", "file_id"],
      ["UserInput", 3, "url", "fileId"],
    ] as const) {
      expect(v2[definition].oneOf[index].anyOf.map(
        (variant: { required: string[] }) => variant.required,
      )).toEqual([[urlKey], [fileKey]]);
      v2[definition].oneOf[index] = priorDefinitions.v2[definition].oneOf[index];
    }
    expect(reviewed).toEqual(previous);
  });
});
