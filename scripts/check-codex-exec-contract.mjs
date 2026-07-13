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
if (schemaPath) {
  const schemaBytes = await readFile(schemaPath);
  const digest = createHash("sha256").update(schemaBytes).digest("hex");
  if (digest !== config.schemaSha256) {
    throw new Error("Codex exec JSONL schema digest changed; update parser fixtures before accepting it");
  }
}
if (appServerSchemaPath) {
  const schemaBytes = await readFile(appServerSchemaPath);
  const digest = createHash("sha256").update(schemaBytes).digest("hex");
  if (digest !== appServerConfig.schemaSha256) {
    throw new Error("Codex app-server schema digest changed; update protocol fixtures before accepting it");
  }
  const schema = JSON.parse(schemaBytes.toString("utf-8"));
  const serialized = JSON.stringify(schema);
  for (const method of appServerConfig.requiredServerMethods) {
    if (!serialized.includes(JSON.stringify(method))) {
      throw new Error(`Codex app-server method is unavailable: ${method}`);
    }
  }
}

console.log(`Codex ${latestVersion} matches the verified JSONL and app-server contracts.`);
