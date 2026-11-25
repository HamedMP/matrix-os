import { describe, expect, it } from "vitest";
import { MANAGED_INTEGRATIONS } from "@matrix-os/contracts/managed-integrations";
import {
  REMOTE_MCP_CATALOG,
  RemoteMcpCatalogEntrySchema,
  remoteMcpCatalogEntry,
  remoteMcpCatalogTop,
  needsRegisteredOAuthClient,
  isRemoteMcpCatalogEntryConnectable,
  remoteMcpCatalogEntryForUrl,
} from "@matrix-os/contracts/remote-mcp-catalog";
import { validateCustomMcpUrl } from "../../packages/gateway/src/integrations/custom-mcp/security.js";
import { GRANOLA_PRESET } from "../../packages/platform/src/granola-integration.js";

const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("remote MCP catalog", () => {
  // Fault: a catalog URL the broker rejects would show a Connect button that always fails.
  it("only lists URLs the Custom MCP broker accepts", async () => {
    for (const entry of REMOTE_MCP_CATALOG) {
      await expect(validateCustomMcpUrl(entry.url, resolvePublic), entry.id).resolves.toMatchObject({
        url: new URL(entry.url),
      });
    }
  });

  // Fault: a malformed or duplicated entry corrupts lookup and presentation in every OS view.
  it("has valid, uniquely identified entries", () => {
    for (const entry of REMOTE_MCP_CATALOG) expect(RemoteMcpCatalogEntrySchema.safeParse(entry).success, entry.id).toBe(true);
    const ids = REMOTE_MCP_CATALOG.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const urls = REMOTE_MCP_CATALOG.map(entry => entry.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("ranks exactly twenty top entries by demand, without gaps", () => {
    const top = remoteMcpCatalogTop();
    expect(top).toHaveLength(20);
    expect(top.map(entry => entry.demandRank)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("covers the services the team named and every department", () => {
    for (const id of ["linear", "slack", "hubspot", "lemlist", "github", "notion"]) expect(remoteMcpCatalogEntry(id), id).toBeDefined();
    const departments = new Set(REMOTE_MCP_CATALOG.flatMap(entry => entry.departments));
    for (const department of ["engineering", "product", "design", "sales", "marketing", "support", "operations"]) {
      expect(departments.has(department as never), department).toBe(true);
    }
  });

  // Fault: catalog and existing presets disagree, so the same service connects to two endpoints.
  it("agrees with the endpoints of existing presets", () => {
    expect(new URL(remoteMcpCatalogEntry("granola")!.url).origin).toBe(new URL(GRANOLA_PRESET.url).origin);
    expect(new URL(remoteMcpCatalogEntry("lemlist")!.url).origin).toBe(new URL(MANAGED_INTEGRATIONS.lemlist.url).origin);
    expect(new URL(remoteMcpCatalogEntry("posthog")!.url).origin).toBe(new URL(MANAGED_INTEGRATIONS.posthog_oauth.url).origin);
  });

  it("flags vendors whose OAuth needs a pre-registered client", () => {
    expect(needsRegisteredOAuthClient(remoteMcpCatalogEntry("github")!)).toBe(true);
    expect(needsRegisteredOAuthClient(remoteMcpCatalogEntry("slack")!)).toBe(true);
    expect(needsRegisteredOAuthClient(remoteMcpCatalogEntry("linear")!)).toBe(false);
    expect(needsRegisteredOAuthClient(remoteMcpCatalogEntry("context7")!)).toBe(false);
  });

  // Fault: a registered-client preset without pinned endpoints lets vendor-advertised
  // metadata redirect the code exchange (and the Matrix client secret) to another host.
  it("pins broker-acceptable OAuth endpoints for every connectable registered-client entry", async () => {
    for (const entry of REMOTE_MCP_CATALOG) {
      if (entry.auth !== "oauth_registered_client") {
        expect(entry.registeredOAuth, entry.id).toBeUndefined();
        continue;
      }
      if (entry.deferred) continue;
      const pinned = entry.registeredOAuth;
      expect(pinned, entry.id).toBeDefined();
      for (const endpoint of [pinned!.authorizationEndpoint, pinned!.tokenEndpoint, pinned!.resource, ...(pinned!.revocationEndpoint ? [pinned!.revocationEndpoint] : [])]) {
        await expect(validateCustomMcpUrl(endpoint, resolvePublic), `${entry.id} ${endpoint}`).resolves.toBeDefined();
      }
      expect(new URL(pinned!.resource).origin, entry.id).toBe(new URL(entry.url).origin);
    }
  });

  // Fault: a Google preset renders a Connect button although restricted-scope verification is pending.
  it("hides deferred Google Workspace entries from the connect flow", () => {
    for (const id of ["google_drive", "gmail", "google_calendar"]) {
      expect(remoteMcpCatalogEntry(id)?.deferred, id).toBe(true);
      expect(isRemoteMcpCatalogEntryConnectable(remoteMcpCatalogEntry(id)!, () => true), id).toBe(false);
    }
    expect(REMOTE_MCP_CATALOG.filter(entry => entry.deferred).map(entry => entry.id).sort()).toEqual(["gmail", "google_calendar", "google_drive"]);
  });

  it("offers a registered-client entry only when its Matrix app is configured", () => {
    const github = remoteMcpCatalogEntry("github")!;
    expect(isRemoteMcpCatalogEntryConnectable(github, () => false)).toBe(false);
    expect(isRemoteMcpCatalogEntryConnectable(github, id => id === "github")).toBe(true);
    expect(isRemoteMcpCatalogEntryConnectable(remoteMcpCatalogEntry("linear")!, () => false)).toBe(true);
  });

  // Fault: a pasted vendor URL that differs only by normalization misses its pinned OAuth app.
  it("matches a pasted endpoint to its entry after URL normalization only", () => {
    expect(remoteMcpCatalogEntryForUrl("https://MCP.box.com")?.id).toBe("box");
    expect(remoteMcpCatalogEntryForUrl("https://mcp.box.com/other")).toBeUndefined();
    expect(remoteMcpCatalogEntryForUrl("not a url")).toBeUndefined();
  });

  it("returns undefined for unknown or prototype ids", () => {
    expect(remoteMcpCatalogEntry("not-a-service")).toBeUndefined();
    expect(remoteMcpCatalogEntry("__proto__")).toBeUndefined();
    expect(remoteMcpCatalogEntry("constructor")).toBeUndefined();
  });

  it("is immutable at runtime", () => {
    expect(Object.isFrozen(REMOTE_MCP_CATALOG)).toBe(true);
    expect(Object.isFrozen(REMOTE_MCP_CATALOG[0])).toBe(true);
  });
});
