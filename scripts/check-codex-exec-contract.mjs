import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

if (!/^\d+\.\d+\.\d+$/.test(latestVersion ?? "")) {
  throw new Error("Codex package version is invalid");
}
if (!schemaPath || !appServerSchemaPath) {
  throw new Error("Both Codex schema paths are required");
}
if (latestVersion !== config.latestVerifiedVersion) {
  throw new Error(
    `Codex ${latestVersion} is not verified; review its exec JSONL schema and update the compatibility contract`,
  );
}
if (latestVersion !== appServerConfig.latestVerifiedVersion) {
  throw new Error(
    `Codex ${latestVersion} is not verified; review its app-server schema and update the compatibility contract`,
  );
}
if (config.minimumVersion !== appServerConfig.minimumVersion) {
  throw new Error("Codex exec and app-server minimum versions must evolve together");
}
const schemaBytes = await readFile(schemaPath);
const digest = createHash("sha256").update(schemaBytes).digest("hex");
if (digest !== config.schemaSha256) {
  throw new Error("Codex exec JSONL schema digest changed; update parser fixtures before accepting it");
}

const appServerSchemaBytes = await readFile(appServerSchemaPath);
const appServerDigest = createHash("sha256").update(appServerSchemaBytes).digest("hex");
if (appServerDigest !== appServerConfig.schemaSha256) {
  throw new Error("Codex app-server schema digest changed; update protocol fixtures before accepting it");
}
const appServerSchema = JSON.parse(appServerSchemaBytes.toString("utf-8"));
const serializedAppServerSchema = JSON.stringify(appServerSchema);
for (const method of appServerConfig.requiredServerMethods) {
  if (!serializedAppServerSchema.includes(JSON.stringify(method))) {
    throw new Error(`Codex app-server method is unavailable: ${method}`);
  }
}

console.log(`Codex ${latestVersion} matches the verified JSONL and app-server contracts.`);
