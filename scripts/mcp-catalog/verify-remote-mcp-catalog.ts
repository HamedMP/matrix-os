// Live drift check for packages/contracts/src/remote-mcp-catalog.ts (spec 2691).
// Probes each vendor endpoint without credentials and confirms that it still
// speaks MCP and that its OAuth registration mode matches the catalog.
// Maintenance tool: it makes network calls, so it is not part of CI.
//
//   bun run mcp-catalog:verify [id ...]
//
// Exit codes: 0 all verified, 1 any failure, 2 no failures but some entries
// could not have their auth mode verified (for example, Google Workspace
// servers that authorize per call and publish no discovery metadata).
import { request as httpsRequest } from "node:https";
import { REMOTE_MCP_CATALOG, type RemoteMcpCatalogEntry } from "../../packages/contracts/src/remote-mcp-catalog.js";
import type { RemoteMcpRequester } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import { createPinnedCustomMcpLookup } from "../../packages/gateway/src/integrations/custom-mcp/pinned-lookup.js";
import { validateCustomMcpUrl } from "../../packages/gateway/src/integrations/custom-mcp/security.js";

const TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

export type ProbeOutcome =
  | { kind: "verified"; status: number; dcr?: boolean }
  | { kind: "unverified"; status: number; reason: string }
  | { kind: "failed"; status?: number; reason: string };

export type JsonGetter = (url: string) => Promise<unknown | undefined>;

/** Reject ids that are not in the catalog so a typo cannot pass with zero checks. */
export function selectCatalogEntries(
  catalog: readonly Readonly<RemoteMcpCatalogEntry>[],
  ids: readonly string[],
): { entries: Readonly<RemoteMcpCatalogEntry>[]; unknown: string[] } {
  const known = new Set(catalog.map(entry => entry.id));
  const unknown = ids.filter(id => !known.has(id));
  const wanted = new Set(ids);
  return { entries: catalog.filter(entry => ids.length === 0 || wanted.has(entry.id)), unknown };
}

/** A 200 only counts when it is the JSON-RPC result for our initialize request. */
export function isInitializeResult(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const message = body as { jsonrpc?: unknown; id?: unknown; result?: { protocolVersion?: unknown } };
  return message.jsonrpc === "2.0" && message.id === 1
    && typeof message.result?.protocolVersion === "string" && message.result.protocolVersion.length > 0;
}

export function resourceMetadataUrl(entryUrl: string, challenge: string | undefined): string {
  return /resource_metadata="([^"]+)"/i.exec(challenge ?? "")?.[1]
    ?? `${new URL(entryUrl).origin}/.well-known/oauth-protected-resource`;
}

export function authorizationMetadataCandidates(issuer: string): string[] {
  const parsed = new URL(issuer);
  const path = parsed.pathname.replace(/\/$/, "");
  return [
    `${parsed.origin}/.well-known/oauth-authorization-server${path}`,
    `${parsed.origin}${path}/.well-known/oauth-authorization-server`,
    `${parsed.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Compare the live registration mode to the catalog; missing metadata is never a pass. */
export async function evaluateRegistration(
  entry: Pick<RemoteMcpCatalogEntry, "auth" | "url">,
  status: number,
  challenge: string | undefined,
  getJson: JsonGetter,
): Promise<ProbeOutcome> {
  const resource = await getJson(resourceMetadataUrl(entry.url, challenge));
  const servers = (resource as { authorization_servers?: unknown } | undefined)?.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : new URL(entry.url).origin;
  let metadata: unknown;
  for (const candidate of authorizationMetadataCandidates(issuer)) {
    metadata = await getJson(candidate);
    if (metadata && typeof metadata === "object") break;
  }
  if (!metadata || typeof metadata !== "object") {
    return { kind: "unverified", status, reason: "oauth_metadata_unavailable" };
  }
  const dcr = typeof (metadata as { registration_endpoint?: unknown }).registration_endpoint === "string";
  if (dcr === (entry.auth === "oauth_dcr")) return { kind: "verified", status, dcr };
  return { kind: "failed", status, reason: dcr ? "dcr_now_available" : "dcr_missing" };
}

export async function probeEntry(
  entry: Readonly<RemoteMcpCatalogEntry>,
  requester: RemoteMcpRequester,
  getJson: JsonGetter,
): Promise<ProbeOutcome> {
  let response;
  try {
    response = await requester({
      url: entry.url,
      headers: {},
      timeoutMs: TIMEOUT_MS,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "matrix-catalog-verify", version: "1" } } },
    });
  } catch (error: unknown) {
    return { kind: "failed", reason: error instanceof Error ? error.message : "request_failed" };
  }
  const { status } = response;
  if (status === 200 && !isInitializeResult(response.body)) return { kind: "failed", status, reason: "invalid_initialize_result" };
  if (entry.auth === "none") return status === 200 ? { kind: "verified", status } : { kind: "failed", status, reason: "expected_200" };
  if (status === 200) {
    // Google Workspace MCPs initialize anonymously and authorize each call.
    return entry.auth === "oauth_registered_client"
      ? { kind: "unverified", status, reason: "per_call_auth" }
      : { kind: "failed", status, reason: "expected_401" };
  }
  if (status !== 401) return { kind: "failed", status, reason: "expected_401" };
  try {
    return await evaluateRegistration(entry, status, response.headers["www-authenticate"], getJson);
  } catch (error: unknown) {
    return { kind: "failed", status, reason: error instanceof Error ? `metadata_${error.name}` : "metadata_error" };
  }
}

interface PinnedResponse { status: number; headers: Record<string, string>; text?: string }

/**
 * SSRF-validated, DNS-pinned, byte-capped HTTPS request. Unlike the broker
 * requester it keeps status and headers when the body is not JSON, because
 * unauthenticated 401 responses are often plain text. Redirects are not followed.
 */
/** One deadline covers URL validation, DNS, connect, and the full body read. */
async function pinnedRequest(rawUrl: string, method: "GET" | "POST", body?: string): Promise<PinnedResponse | undefined> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const settled = new AbortController();
  const expired = new Promise<undefined>((resolve) => {
    deadline.addEventListener("abort", () => {
      console.warn("[mcp-catalog] request deadline exceeded");
      resolve(undefined);
    }, { once: true, signal: settled.signal });
  });
  try {
    return await Promise.race([boundedRequest(rawUrl, method, body, deadline), expired]);
  } finally {
    // Detach the deadline listener so a finished request never logs a timeout.
    settled.abort();
  }
}

async function boundedRequest(rawUrl: string, method: "GET" | "POST", body: string | undefined, signal: AbortSignal): Promise<PinnedResponse | undefined> {
  let target;
  try {
    target = await validateCustomMcpUrl(rawUrl);
  } catch (error: unknown) {
    console.warn(`[mcp-catalog] rejected URL: ${error instanceof Error ? error.name : "invalid"}`);
    return undefined;
  }
  return new Promise((resolve) => {
    const request = httpsRequest(target.url, {
      method,
      headers: method === "POST"
        ? { accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": String(Buffer.byteLength(body ?? "")) }
        : { accept: "application/json" },
      lookup: createPinnedCustomMcpLookup(target),
      servername: target.url.hostname,
      timeout: TIMEOUT_MS,
      signal,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const headers = Object.fromEntries(Object.entries(response.headers)
        .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
        .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]));
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer) => {
        if (truncated) return;
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          truncated = true;
          response.destroy();
          resolve({ status, headers });
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) => {
        if (truncated) return;
        console.warn(`[mcp-catalog] response read failed: ${error.name}`);
        resolve({ status, headers });
      });
      response.on("end", () => resolve({ status, headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", (error) => {
      console.warn(`[mcp-catalog] request failed: ${error.message}`);
      resolve(undefined);
    });
    request.end(body);
  });
}

export function parseMcpBody(text: string | undefined, contentType: string | undefined): unknown {
  if (!text) return undefined;
  try {
    if (!contentType?.includes("text/event-stream")) return JSON.parse(text);
    const messages = text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      return data ? [JSON.parse(data) as unknown] : [];
    });
    return messages.findLast(message => Boolean(message) && typeof message === "object" && "id" in (message as object));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const probeRequester: RemoteMcpRequester = async (input) => {
  const response = await pinnedRequest(input.url, "POST", JSON.stringify(input.body));
  if (!response) throw new Error("request_failed");
  return { status: response.status, headers: response.headers, body: parseMcpBody(response.text, response.headers["content-type"]) };
};

const pinnedJsonGet: JsonGetter = async (url) => {
  const response = await pinnedRequest(url, "GET");
  if (!response || response.status !== 200 || !response.text || response.text.length > MAX_METADATA_BYTES) return undefined;
  return parseMcpBody(response.text, "application/json");
};

async function main(): Promise<void> {
  const { entries, unknown } = selectCatalogEntries(REMOTE_MCP_CATALOG, process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`Unknown catalog id(s): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  let failed = 0;
  let unverified = 0;
  for (const entry of entries) {
    const outcome = await probeEntry(entry, probeRequester, pinnedJsonGet);
    if (outcome.kind === "failed") failed += 1;
    if (outcome.kind === "unverified") unverified += 1;
    const label = outcome.kind === "verified" ? "ok   " : outcome.kind === "unverified" ? "UNVER" : "FAIL ";
    const dcr = outcome.kind === "verified" && outcome.dcr !== undefined ? `dcr=${outcome.dcr}` : "";
    console.log([label, entry.id.padEnd(16), String(outcome.status ?? "-").padEnd(4), dcr.padEnd(10), "reason" in outcome ? outcome.reason : ""].join(" "));
  }
  console.log(`${entries.length - failed - unverified} verified, ${unverified} unverified, ${failed} failed of ${entries.length}`);
  process.exitCode = failed > 0 ? 1 : unverified > 0 ? 2 : 0;
}

if (import.meta.main) await main();
