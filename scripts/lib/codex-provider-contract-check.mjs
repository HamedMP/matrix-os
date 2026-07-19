import { createHash } from "node:crypto";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortedVersions(contract) {
  return Object.keys(contract.verifiedVersions ?? {}).sort();
}

export function verifyCodexProviderContracts({
  version,
  execContract,
  appServerContract,
  execSchemaBytes,
  appServerSchemaBytes,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error("Codex package version is invalid");
  }
  if (version !== execContract.latestVerifiedVersion) {
    throw new Error(
      `Codex ${version} is not verified; review its exec JSONL schema and update the compatibility contract`,
    );
  }
  if (version !== appServerContract.latestVerifiedVersion) {
    throw new Error(
      `Codex ${version} is not verified; review its app-server schema and update the compatibility contract`,
    );
  }
  if (JSON.stringify(sortedVersions(execContract)) !== JSON.stringify(sortedVersions(appServerContract))) {
    throw new Error("Codex exec and app-server verified versions must evolve together");
  }

  const expectedExecDigest = execContract.verifiedVersions?.[version]?.schemaSha256;
  if (!expectedExecDigest || sha256(execSchemaBytes) !== expectedExecDigest) {
    throw new Error("Codex exec JSONL schema digest changed; update parser fixtures before accepting it");
  }
  const execSchema = execSchemaBytes.toString("utf8");
  for (const eventType of execContract.requiredEventTypes ?? []) {
    if (!execSchema.includes(eventType)) {
      throw new Error(`Codex exec event is unavailable: ${eventType}`);
    }
  }

  const expectedAppServerDigest = appServerContract.verifiedVersions?.[version]?.schemaSha256;
  if (!expectedAppServerDigest || sha256(appServerSchemaBytes) !== expectedAppServerDigest) {
    throw new Error("Codex app-server schema digest changed; update protocol fixtures before accepting it");
  }
  let appServerSchema;
  try {
    appServerSchema = JSON.parse(appServerSchemaBytes.toString("utf8"));
  } catch (_error) {
    throw new Error("Codex app-server schema is invalid");
  }
  const serializedAppServerSchema = JSON.stringify(appServerSchema);
  for (const method of appServerContract.requiredServerMethods ?? []) {
    if (!serializedAppServerSchema.includes(JSON.stringify(method))) {
      throw new Error(`Codex app-server method is unavailable: ${method}`);
    }
  }
}
