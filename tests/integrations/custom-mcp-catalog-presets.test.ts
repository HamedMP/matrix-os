import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import {
  RegisteredMcpOAuthClients,
  listConnectableCatalogPresets,
  resolveConnectableCatalogPreset,
} from "../../packages/gateway/src/integrations/custom-mcp/catalog-presets.js";

const SECRET = "matrix-github-app-secret-value";

describe("Matrix-owned OAuth apps for registered-client presets", () => {
  // Fault: a Matrix app secret leaks through logs, JSON responses, or inspection.
  it("parses configured vendors once and never serializes the secret", () => {
    const warn = vi.fn();
    const clients = RegisteredMcpOAuthClients.fromEnv({
      MCP_OAUTH_GITHUB_CLIENT_ID: "gh-client", MCP_OAUTH_GITHUB_CLIENT_SECRET: SECRET,
    }, warn);
    const github = clients.forCatalogId("github");
    expect(github).toMatchObject({ catalogId: "github", clientId: "gh-client" });
    expect(github!.clientSecret).toBe(SECRET);
    expect(JSON.stringify(github)).not.toContain(SECRET);
    expect(JSON.stringify(clients)).not.toContain(SECRET);
    expect(inspect(github, { depth: 5 })).not.toContain(SECRET);
    expect(warn).not.toHaveBeenCalled();
  });

  // Fault: a missing or malformed secret renders a Connect button that always fails, or crashes startup.
  it("treats missing, partial, malformed, deferred, and DCR vendor config as unavailable", () => {
    const warn = vi.fn();
    const clients = RegisteredMcpOAuthClients.fromEnv({
      MCP_OAUTH_SLACK_CLIENT_ID: "slack-client",
      MCP_OAUTH_HUBSPOT_CLIENT_ID: "hub spot", MCP_OAUTH_HUBSPOT_CLIENT_SECRET: "secret",
      MCP_OAUTH_GMAIL_CLIENT_ID: "gmail", MCP_OAUTH_GMAIL_CLIENT_SECRET: "secret",
      MCP_OAUTH_LINEAR_CLIENT_ID: "linear", MCP_OAUTH_LINEAR_CLIENT_SECRET: "secret",
    }, warn);
    for (const id of ["slack", "hubspot", "gmail", "linear", "asana", "box"]) expect(clients.forCatalogId(id), id).toBeUndefined();
    expect(warn.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining([
      { catalogId: "slack", reason: "incomplete" }, { catalogId: "hubspot", reason: "invalid" },
    ]));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("resolves a pasted vendor URL to its Matrix app", () => {
    const clients = RegisteredMcpOAuthClients.fromEnv({ MCP_OAUTH_BOX_CLIENT_ID: "box", MCP_OAUTH_BOX_CLIENT_SECRET: SECRET });
    expect(clients.forServerUrl("https://mcp.box.com")?.catalogId).toBe("box");
    expect(clients.forServerUrl("https://mcp.linear.app/mcp")).toBeUndefined();
    expect(clients.forServerUrl("https://mcp.box.com/elsewhere")).toBeUndefined();
  });
});

describe("connectable catalog projection", () => {
  const clients = RegisteredMcpOAuthClients.fromEnv({ MCP_OAUTH_GITHUB_CLIENT_ID: "gh", MCP_OAUTH_GITHUB_CLIENT_SECRET: SECRET });

  it("omits deferred Google entries and unconfigured registered-client vendors", () => {
    const ids = listConnectableCatalogPresets(clients).map(entry => entry.id);
    expect(ids).toContain("github");
    expect(ids).toContain("linear");
    for (const id of ["google_drive", "gmail", "google_calendar", "slack", "hubspot"]) expect(ids, id).not.toContain(id);
  });

  it("filters by department and category and exposes no pinned OAuth config", () => {
    const sales = listConnectableCatalogPresets(clients, { department: "sales" });
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every(entry => entry.departments.includes("sales"))).toBe(true);
    const developer = listConnectableCatalogPresets(clients, { category: "developer" });
    expect(developer.every(entry => entry.category === "developer")).toBe(true);
    expect(JSON.stringify(listConnectableCatalogPresets(clients))).not.toMatch(/registeredOAuth|tokenEndpoint|github\.com\/login/);
    expect(JSON.stringify(listConnectableCatalogPresets(clients))).not.toContain(SECRET);
  });

  it("orders top-demand entries first", () => {
    const ranks = listConnectableCatalogPresets(clients).map(entry => entry.demandRank ?? Number.POSITIVE_INFINITY);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  // Fault: create accepts a hidden preset id and starts a connection that cannot complete.
  it("resolves only connectable preset ids", () => {
    expect(resolveConnectableCatalogPreset(clients, "linear")?.url).toBe("https://mcp.linear.app/mcp");
    expect(resolveConnectableCatalogPreset(clients, "github")?.id).toBe("github");
    expect(resolveConnectableCatalogPreset(clients, "slack")).toBeUndefined();
    expect(resolveConnectableCatalogPreset(clients, "gmail")).toBeUndefined();
    expect(resolveConnectableCatalogPreset(clients, "__proto__")).toBeUndefined();
  });
});
