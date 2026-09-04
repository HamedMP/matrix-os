import { createHash } from "node:crypto";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
  );
}

function resolveLocalRef(schema, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Codex app-server schema uses a non-local reference: ${ref}`);
  return ref.slice(2).split("/").reduce((value, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
      throw new Error(`Codex app-server schema reference is unavailable: ${ref}`);
    }
    return value[key];
  }, schema);
}

export function codexProtocolMethodDigest(schema, definitionName, method) {
  const variants = schema?.definitions?.[definitionName]?.oneOf;
  if (!Array.isArray(variants)) {
    throw new Error(`Codex app-server schema definition is unavailable: ${definitionName}`);
  }
  const variant = variants.find((candidate) => candidate?.properties?.method?.enum?.includes(method));
  if (!variant) throw new Error(`Codex app-server method is unavailable: ${method}`);

  const references = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string" && !references.has(value.$ref)) {
      const referencedSchema = resolveLocalRef(schema, value.$ref);
      references.set(value.$ref, referencedSchema);
      visit(referencedSchema);
    }
    Object.values(value).forEach(visit);
  };
  visit(variant);

  const referencedSchemas = Object.fromEntries(
    [...references.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  return sha256(Buffer.from(JSON.stringify(stableJson({ variant, referencedSchemas }))));
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
  runtimeTarget = `${process.platform}-${process.arch}`,
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

  const appServerVerification = appServerContract.verifiedVersions?.[version];
  const expectedAppServerDigest = appServerVerification?.schemaSha256ByTarget?.[runtimeTarget]
    ?? appServerVerification?.schemaSha256;
  const actualAppServerDigest = sha256(appServerSchemaBytes);
  if (!expectedAppServerDigest || actualAppServerDigest !== expectedAppServerDigest) {
    throw new Error(
      `Codex app-server schema digest changed; received ${actualAppServerDigest}; update protocol fixtures before accepting it`,
    );
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
  for (const notification of appServerContract.requiredServerNotifications ?? []) {
    if (!serializedAppServerSchema.includes(JSON.stringify(notification))) {
      throw new Error(`Codex app-server notification is unavailable: ${notification}`);
    }
  }
  const semanticMismatches = [];
  for (const [method, verification] of Object.entries(
    appServerContract.requiredServerProtocolSchemaDigests ?? {},
  )) {
    const definitionName = (appServerContract.requiredServerMethods ?? []).includes(method)
      ? "ServerRequest"
      : "ServerNotification";
    const actualDigest = codexProtocolMethodDigest(appServerSchema, definitionName, method);
    const expectedDigest = typeof verification === "string"
      ? verification
      : verification?.schemaSha256ByTarget?.[runtimeTarget] ?? verification?.schemaSha256;
    if (actualDigest !== expectedDigest) {
      semanticMismatches.push(`${method}: received ${actualDigest}`);
    }
  }
  if (semanticMismatches.length > 0) {
    throw new Error(`Codex app-server payload schema changed for ${semanticMismatches.join("; ")}`);
  }
}
