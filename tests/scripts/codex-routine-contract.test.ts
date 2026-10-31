import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import app from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import exec from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import { verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";
it("guards the newly consumed native dynamic callback and exact request/response schemas without widening versions", () => {
  expect(app.requiredServerMethods).toContain("item/tool/call");
  expect(app.latestVerifiedVersion).toBe("0.165.0");
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
    const contract = { ...app, verifiedVersions: { ...app.verifiedVersions, "0.165.0": { schemaSha256: hash } } };
    expect(() => verifyCodexProviderContracts({ version: "0.165.0", execContract: exec, appServerContract: contract, execSchemaBytes: readFileSync("tests/fixtures/codex-0158/exec-events.rs"), appServerSchemaBytes: changed })).toThrow(/routine protocol/);
  }
});
