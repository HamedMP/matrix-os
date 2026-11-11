import { describe, expect, it, vi } from "vitest";
import { remoteMcpCatalogEntry, REMOTE_MCP_CATALOG } from "@matrix-os/contracts/remote-mcp-catalog";
import type { RemoteMcpRequester } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import {
  authorizationMetadataCandidates,
  evaluateRegistration,
  isInitializeResult,
  probeEntry,
  selectCatalogEntries,
} from "../../scripts/mcp-catalog/verify-remote-mcp-catalog.js";

const initializeOk = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } };
const respond = (status: number, body?: unknown, headers: Record<string, string> = {}): RemoteMcpRequester =>
  async () => ({ status, headers, body });
const linear = remoteMcpCatalogEntry("linear")!;
const github = remoteMcpCatalogEntry("github")!;
const context7 = remoteMcpCatalogEntry("context7")!;
const gmail = remoteMcpCatalogEntry("gmail")!;

describe("remote MCP catalog verifier", () => {
  // Fault: a typo silently checks zero entries and exits successfully.
  it("reports requested ids that are not in the catalog", () => {
    expect(selectCatalogEntries(REMOTE_MCP_CATALOG, ["linear", "linaer"])).toMatchObject({ unknown: ["linaer"] });
    expect(selectCatalogEntries(REMOTE_MCP_CATALOG, []).entries).toHaveLength(REMOTE_MCP_CATALOG.length);
  });

  // Fault: an HTML page or JSON-RPC error served with 200 counts as a working MCP server.
  it("accepts only a matching initialize result", () => {
    expect(isInitializeResult(initializeOk)).toBe(true);
    expect(isInitializeResult({ jsonrpc: "2.0", id: 1, error: { code: -32600 } })).toBe(false);
    expect(isInitializeResult({ jsonrpc: "2.0", id: 2, result: { protocolVersion: "x" } })).toBe(false);
    expect(isInitializeResult("<html>")).toBe(false);
  });

  it("fails an unauthenticated server whose 200 is not an MCP result", async () => {
    await expect(probeEntry(context7, respond(200, { error: "maintenance" }), vi.fn()))
      .resolves.toMatchObject({ kind: "failed", reason: "invalid_initialize_result" });
    await expect(probeEntry(context7, respond(200, initializeOk), vi.fn())).resolves.toMatchObject({ kind: "verified" });
  });

  // Fault: a timeout or removed discovery endpoint counts as a verified auth mode.
  it("never counts missing OAuth metadata as verified", async () => {
    await expect(evaluateRegistration(linear, 401, undefined, async () => undefined))
      .resolves.toMatchObject({ kind: "unverified", reason: "oauth_metadata_unavailable" });
  });

  it("detects registration drift in both directions", async () => {
    const withDcr = async (url: string) => url.includes("authorization-server") ? { registration_endpoint: "https://as.example/register" } : undefined;
    const withoutDcr = async (url: string) => url.includes("authorization-server") ? { issuer: "https://as.example" } : undefined;
    await expect(evaluateRegistration(linear, 401, undefined, withDcr)).resolves.toMatchObject({ kind: "verified", dcr: true });
    await expect(evaluateRegistration(linear, 401, undefined, withoutDcr)).resolves.toMatchObject({ kind: "failed", reason: "dcr_missing" });
    await expect(evaluateRegistration(github, 401, undefined, withDcr)).resolves.toMatchObject({ kind: "failed", reason: "dcr_now_available" });
  });

  it("follows the advertised resource metadata to its authorization server", async () => {
    const seen: string[] = [];
    const getJson = async (url: string) => {
      seen.push(url);
      if (url === "https://mcp.example/prm") return { authorization_servers: ["https://auth.example/tenant"] };
      return url === "https://auth.example/.well-known/oauth-authorization-server/tenant" ? { registration_endpoint: "https://auth.example/r" } : undefined;
    };
    await expect(evaluateRegistration(linear, 401, 'Bearer resource_metadata="https://mcp.example/prm"', getJson))
      .resolves.toMatchObject({ kind: "verified", dcr: true });
    expect(seen[0]).toBe("https://mcp.example/prm");
  });

  // Fault: one vendor's malformed metadata aborts the run before later vendors are checked.
  it("reports malformed authorization server metadata as that entry's failure", async () => {
    const getJson = async () => ({ authorization_servers: ["not-a-url"] });
    await expect(probeEntry(linear, respond(401), getJson)).resolves.toMatchObject({ kind: "failed" });
  });

  it("marks per-call-auth servers as unverified, not verified", async () => {
    await expect(probeEntry(gmail, respond(200, initializeOk), vi.fn())).resolves.toMatchObject({ kind: "unverified", reason: "per_call_auth" });
  });

  it("reports request errors without throwing", async () => {
    const failing: RemoteMcpRequester = async () => { throw new Error("Custom MCP redirects are not allowed"); };
    await expect(probeEntry(linear, failing, vi.fn())).resolves.toMatchObject({ kind: "failed", reason: "Custom MCP redirects are not allowed" });
  });

  it("builds RFC 8414 and OIDC discovery candidates for path issuers", () => {
    expect(authorizationMetadataCandidates("https://auth.example/tenant/")).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server/tenant",
      "https://auth.example/tenant/.well-known/oauth-authorization-server",
      "https://auth.example/tenant/.well-known/openid-configuration",
    ]);
  });
});

describe("MCP body parsing for probes", () => {
  it("parses JSON, picks the id-bearing SSE message, and tolerates plain-text 401 bodies", async () => {
    const { parseMcpBody } = await import("../../scripts/mcp-catalog/verify-remote-mcp-catalog.js");
    expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json")).toMatchObject({ id: 1 });
    expect(parseMcpBody('data: {"jsonrpc":"2.0","method":"notice"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', "text/event-stream")).toMatchObject({ id: 1 });
    expect(parseMcpBody("bad request", "text/plain")).toBeUndefined();
    expect(parseMcpBody(undefined, undefined)).toBeUndefined();
  });
});
