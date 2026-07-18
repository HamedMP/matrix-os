import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const configUrl = new URL(
  "../packages/gateway/src/coding-agents/codex-exec-contract.json",
  import.meta.url,
);
const config = JSON.parse(await readFile(configUrl, "utf-8"));
const latestVersion = process.argv[2]?.trim();
const schemaPath = process.argv[3];

if (!/^\d+\.\d+\.\d+$/.test(latestVersion ?? "")) {
  throw new Error("Codex package version is invalid");
}
if (latestVersion !== config.latestVerifiedVersion) {
  throw new Error(
    `Codex ${latestVersion} is not verified; review its exec JSONL schema and update the compatibility contract`,
  );
}
if (schemaPath) {
  const schemaBytes = await readFile(schemaPath);
  const digest = createHash("sha256").update(schemaBytes).digest("hex");
  if (digest !== config.schemaSha256) {
    throw new Error("Codex exec JSONL schema digest changed; update parser fixtures before accepting it");
  }
}

console.log(`Codex ${latestVersion} matches the verified exec JSONL contract.`);
