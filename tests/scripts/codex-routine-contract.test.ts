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
  "mcpServer/elicitation/request": "d164b1519690cfb0b5f353c8e6eb37087f720e7dcd81df4c145bc964f9416d05",
  "item/started": "bedd6a6e59c26dba37deec380efa34ef88a4fa65902440f7b5c9977f33302529",
  "item/completed": "8ec2ff52d10fe877ce3353550dd0cbd9f4ca7358f8f47a572807994ae08a16c7",
  "turn/completed": "e8d4a5e2287d87bfcea1fc04428f44545ce243ef56381cbf6c8102f423f63dde",
};
const historical0167ServerDigests = {
  "mcpServer/elicitation/request": "d164b1519690cfb0b5f353c8e6eb37087f720e7dcd81df4c145bc964f9416d05",
  "item/started": "91a60058ca9e9b9dee61f91aa674d5577f48ab94ecd80833b7500573ed19d644",
  "item/completed": "091914fa7fb2f8aa285ce5c2452b3abbd7177c6d7193d56d7bb3e8c0f1dcddff",
  "turn/completed": "a422130287e89c148ef74c9c38773df548c11153e68cfd57409705154ca16940",
};
const historical0169ServerDigests = {
  "mcpServer/elicitation/request": "d164b1519690cfb0b5f353c8e6eb37087f720e7dcd81df4c145bc964f9416d05",
  "item/started": "617275c94854b1871af5371cbfdfdd88d03c66d681983ed82e3efeea1adec800",
  "item/completed": "bd38783bca8b6bd3ecf75796883f3784bffca1d7797c33b3248e43a754e92c0d",
  "turn/completed": "ea32be3552e720e9f07bffae9bb0b4270c0f33a7d86a1df9c701fc77197e3906",
};
const historical0170ServerDigests = {
  "mcpServer/elicitation/request": "d164b1519690cfb0b5f353c8e6eb37087f720e7dcd81df4c145bc964f9416d05",
  "item/started": "eaf107de5620c148a28100d23dd6945144d80d4ec3acbff39afc5dc6d6938a10",
  "item/completed": "8a036a0125593390eb2fb90f146439dee351c63e3551eb1b195524d56c51e4b5",
  "turn/completed": "78c2fd6a7d434b930cbf4fd7a04422f1c8c83935a92f01f8d7bce642e025caa4",
};

it("guards the native callback and the exact managed request and response schemas", () => {
  expect(CODEX_VERIFIED_VERSION).toBe("0.171.0");
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

const routineFixtures: Record<string, string> = {
  "0.166.0": "0166", "0.167.0": "0167", "0.167.1": "0167", "0.167.2": "0167",
  "0.169.0": "0169", "0.169.1": "0169", "0.170.0": "0170", "0.171.0": "0171", "0.172.0": "0172",
};
const historicalDigestsByFixture: Record<string, Record<string, string>> = {
  "0166": historicalServerDigests, "0167": historical0167ServerDigests,
  "0169": historical0169ServerDigests, "0170": historical0170ServerDigests,
  "0171": { "turn/completed": "b6bd55f1da742df68c275dd2e016f76152bd705b223ef4fc5652446b3be6b3df" },
};

it.each(Object.keys(routineFixtures))("rejects every changed routine payload in %s after a whole-schema digest refresh", version => {
  const fixture = routineFixtures[version];
  const schemaBytes = gunzipSync(readFileSync(new URL(
    `../fixtures/codex-${fixture}/app-server-schema-${fixture}.json.gz`, import.meta.url,
  )));
  const appServerContract = {
    ...app,
    latestVerifiedVersion: version,
    requiredServerProtocolSchemaDigests: { ...app.requiredServerProtocolSchemaDigests, ...historicalDigestsByFixture[fixture] },
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
