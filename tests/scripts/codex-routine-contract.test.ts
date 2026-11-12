import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import app from "../../packages/gateway/src/coding-agents/codex-app-server-contract.json" with { type: "json" };
import exec from "../../packages/gateway/src/coding-agents/codex-exec-contract.json" with { type: "json" };
import { CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";
import { verifyCodexProviderContracts } from "../../scripts/lib/codex-provider-contract-check.mjs";

const execBytes = readFileSync(new URL("../fixtures/codex-0158/exec-events.rs", import.meta.url));
const historicalServerDigests = {
  "item/commandExecution/requestApproval": "ef803ac64161397389bc35428803c3ec8dcc94757c93d758a9fdf0ae6b5a944f",
  "item/started": "bedd6a6e59c26dba37deec380efa34ef88a4fa65902440f7b5c9977f33302529",
  "item/completed": "8ec2ff52d10fe877ce3353550dd0cbd9f4ca7358f8f47a572807994ae08a16c7",
  "turn/completed": "e8d4a5e2287d87bfcea1fc04428f44545ce243ef56381cbf6c8102f423f63dde",
};

it("guards the native callback and the exact managed request and response schemas", () => {
  expect(CODEX_VERIFIED_VERSION).toBe("0.162.1");
  expect(app.requiredServerMethods).toContain("item/tool/call");
  const pin = JSON.parse(gunzipSync(readFileSync(new URL(
    "../fixtures/codex-0162/app-server-schema-0162.json.gz", import.meta.url,
  ))).toString("utf8"));
  for (const name of ["ThreadResumeParams", "ThreadForkParams", "TurnStartParams"]) {
    expect(pin.definitions.v2[name].properties).not.toHaveProperty("dynamicTools");
  }
  expect(pin.definitions.v2.ThreadStartParams.properties).toHaveProperty("dynamicTools");
});

const mutations = [
  ...["initialize", "thread/start", "thread/resume", "turn/start"].map(method => ({
    name: method,
    mutate(value: Record<string, any>) {
      const request = value.definitions.ClientRequest.oneOf.find(
        (variant: { properties: { method: { enum: string[] } } }) => variant.properties.method.enum[0] === method,
      );
      request.properties.params = { type: "null" };
    },
  })),
  ...["DynamicToolCallParams", "DynamicToolCallResponse", "v2/DynamicToolSpec"].map(name => ({
    name,
    mutate(value: Record<string, any>) {
      const definition = name.split("/").reduce((node, key) => node[key], value.definitions);
      if (name === "v2/DynamicToolSpec") definition.oneOf[0].properties.inputSchema = { type: "null" };
      else definition.properties.unreviewedRoutineField = { type: "boolean" };
    },
  })),
];

it.each(["0.166.0", "0.167.0", "0.167.1", "0.167.2"])("rejects every changed routine payload in %s after a whole-schema digest refresh", version => {
  const fixture = version === "0.166.0" ? "0166" : "0167";
  const schemaBytes = gunzipSync(readFileSync(new URL(
    `../fixtures/codex-${fixture}/app-server-schema-${fixture}.json.gz`, import.meta.url,
  )));
  const appServerContract = {
    ...app,
    latestVerifiedVersion: version,
    requiredServerProtocolSchemaDigests: version === "0.166.0"
      ? { ...app.requiredServerProtocolSchemaDigests, ...historicalServerDigests }
      : app.requiredServerProtocolSchemaDigests,
  };
  const verify = (bytes: Buffer, contract: typeof appServerContract) => verifyCodexProviderContracts({
    version, execContract: { ...exec, latestVerifiedVersion: version }, appServerContract: contract,
    execSchemaBytes: execBytes, appServerSchemaBytes: bytes, runtimeTarget: "linux-x64",
  });
  expect(() => verify(schemaBytes, appServerContract)).not.toThrow();
  for (const { name, mutate } of mutations) {
    const schema = JSON.parse(schemaBytes.toString("utf8"));
    mutate(schema);
    const changed = Buffer.from(JSON.stringify(schema));
    const schemaSha256 = createHash("sha256").update(changed).digest("hex");
    // The dynamic descriptor is also reachable from the thread/start request.
    const changedPayload = name === "v2/DynamicToolSpec" ? "thread/start" : name;
    expect(() => verify(changed, {
      ...appServerContract,
      verifiedVersions: { ...app.verifiedVersions, [version]: { schemaSha256 } },
    })).toThrow(`Codex routine protocol changed for ${changedPayload}`);
  }
});
