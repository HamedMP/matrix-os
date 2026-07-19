import { readFile } from "node:fs/promises";
import { verifyCodexProviderContracts } from "./lib/codex-provider-contract-check.mjs";

const configUrl = new URL(
  "../packages/gateway/src/coding-agents/codex-exec-contract.json",
  import.meta.url,
);
const appServerConfigUrl = new URL(
  "../packages/gateway/src/coding-agents/codex-app-server-contract.json",
  import.meta.url,
);
const config = JSON.parse(await readFile(configUrl, "utf-8"));
const appServerConfig = JSON.parse(await readFile(appServerConfigUrl, "utf-8"));
const latestVersion = process.argv[2]?.trim();
const schemaPath = process.argv[3];
const appServerSchemaPath = process.argv[4];

if (!schemaPath || !appServerSchemaPath) {
  throw new Error("Both Codex schema paths are required");
}
const schemaBytes = await readFile(schemaPath);
const appServerSchemaBytes = await readFile(appServerSchemaPath);
verifyCodexProviderContracts({
  version: latestVersion,
  execContract: config,
  appServerContract: appServerConfig,
  execSchemaBytes: schemaBytes,
  appServerSchemaBytes,
});

console.log(`Codex ${latestVersion} matches the verified JSONL and app-server contracts.`);
