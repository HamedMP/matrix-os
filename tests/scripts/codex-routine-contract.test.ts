import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import app from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import exec from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import { verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";
it("guards the native dynamic callback and exact pinned request/response schemas", () => {
  expect(app.requiredServerMethods).toContain("item/tool/call");
  const pin = JSON.parse(gunzipSync(readFileSync("tests/fixtures/codex-0162/app-server-schema-0162.json.gz")).toString("utf8"));
  for (const name of ["ThreadResumeParams", "ThreadForkParams", "TurnStartParams"]) expect(pin.definitions.v2[name].properties).not.toHaveProperty("dynamicTools");
  expect(pin.definitions.v2.ThreadStartParams.properties).toHaveProperty("dynamicTools");
});
it("rejects changed dynamic result or thread-start shapes even if someone refreshes the whole schema digest", () => {
  const bytes = gunzipSync(readFileSync("tests/fixtures/codex-0165/app-server-schema-0165.json.gz"));
  for (const definition of ["DynamicToolCallResponse", "v2.ThreadStartParams"]) {
    const schema = JSON.parse(bytes.toString("utf8"));
    const value = definition.split(".").reduce((node, key) => node[key], schema.definitions);
    value.properties.unreviewedRoutineField = { type: "boolean" };
    const changed = Buffer.from(JSON.stringify(schema)), hash = createHash("sha256").update(changed).digest("hex");
    const contract = { ...app, latestVerifiedVersion: "0.165.0",
      requiredServerProtocolSchemaDigests: { ...app.requiredServerProtocolSchemaDigests,
        "item/started": "554ed510ef9adc011a14b1d0045b2741c536a0f6a4728b07723537c31f088cb5",
        "item/completed": "7f57001a4be1380e4d2d183ae76dafc2beb274a9e4401edc4bd676cc59e7d2a3",
        "turn/completed": "d775b4d4e65c194a34726c88625fd88f71e5ffc00cd5ba5a6bc64ac913a90055" },
      verifiedVersions: { ...app.verifiedVersions, "0.165.0": { schemaSha256: hash } } };
    expect(() => verifyCodexProviderContracts({ version: "0.165.0", execContract: { ...exec, latestVerifiedVersion: "0.165.0" }, appServerContract: contract, execSchemaBytes: readFileSync("tests/fixtures/codex-0158/exec-events.rs"), appServerSchemaBytes: changed })).toThrow(/routine protocol/);
  }
});
