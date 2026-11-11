#!/usr/bin/env node
// Live drift check for packages/contracts/src/remote-mcp-catalog.ts (spec 2691).
// Probes each vendor endpoint without credentials and confirms that it still
// speaks MCP and that its OAuth registration mode matches the catalog.
// Manual/maintenance tool: it makes network calls, so it is not part of CI.
//
//   node scripts/mcp-catalog/verify-remote-mcp-catalog.mjs [id ...]
import { REMOTE_MCP_CATALOG } from "../../packages/contracts/src/remote-mcp-catalog.ts";

const TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "matrix-catalog-verify", version: "1" } },
});

async function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function readJson(url) {
  try {
    const response = await request(url, { headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) return undefined;
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "TypeError"))) return undefined;
    throw error;
  }
}

async function authorizationMetadata(issuer) {
  const base = issuer.replace(/\/$/, "");
  const parsed = new URL(base);
  const candidates = [
    `${parsed.origin}/.well-known/oauth-authorization-server${parsed.pathname === "/" ? "" : parsed.pathname}`,
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  for (const candidate of candidates) {
    const metadata = await readJson(candidate);
    if (metadata && typeof metadata === "object") return metadata;
  }
  return undefined;
}

async function probe(entry) {
  let response;
  try {
    response = await request(entry.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: INITIALIZE,
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : "request_failed" };
  }
  await response.body?.cancel();
  const status = response.status;
  if (entry.auth === "none") return status === 200 ? { ok: true, status } : { ok: false, status, reason: "expected_200" };
  // Google Workspace MCPs answer initialize anonymously and authorize per call.
  if (status !== 401 && !(status === 200 && entry.auth === "oauth_registered_client")) {
    return { ok: false, status, reason: "expected_401" };
  }

  const challenge = response.headers.get("www-authenticate") ?? "";
  const resourceMetadataUrl = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1]
    ?? `${new URL(entry.url).origin}/.well-known/oauth-protected-resource`;
  const resource = await readJson(resourceMetadataUrl);
  const issuer = Array.isArray(resource?.authorization_servers) ? resource.authorization_servers[0] : new URL(entry.url).origin;
  const metadata = typeof issuer === "string" ? await authorizationMetadata(issuer) : undefined;
  if (!metadata) return { ok: true, status, dcr: "unknown" };
  const dcr = typeof metadata.registration_endpoint === "string";
  const expectedDcr = entry.auth === "oauth_dcr";
  return dcr === expectedDcr ? { ok: true, status, dcr } : { ok: false, status, dcr, reason: dcr ? "dcr_now_available" : "dcr_missing" };
}

const filter = new Set(process.argv.slice(2));
const selected = REMOTE_MCP_CATALOG.filter(entry => filter.size === 0 || filter.has(entry.id));
let failures = 0;
for (const entry of selected) {
  const result = await probe(entry);
  if (!result.ok) failures += 1;
  console.log([
    result.ok ? "ok  " : "FAIL",
    entry.id.padEnd(16),
    String(result.status ?? "-").padEnd(4),
    `dcr=${result.dcr ?? "-"}`.padEnd(13),
    result.reason ?? "",
  ].join(" "));
}
console.log(`${selected.length - failures}/${selected.length} catalog entries verified`);
process.exitCode = failures === 0 ? 0 : 1;
