// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrganizationMcpAdminClient, createOrganizationMcpHttpApi, usageWindow } from "../../packages/ui/src/organization-mcp/client.js";
import { OrganizationConnectionsPanel, type WithOrganizationMcpClient } from "../../packages/ui/src/organization-mcp/OrganizationConnectionsPanel.js";

afterEach(cleanup);

const today = new Date().toISOString().slice(0, 10);
const page = (overrides: Record<string, unknown> = {}) => ({
  members: [{
    actorId: "user_mo", displayName: "Mo Member", emailAddress: "mo@example.test", blockedServerDefIds: [],
    connections: [{ connectionId: "11111111-1111-4111-8111-111111111111", name: "Linear", host: "mcp.linear.app",
      serverDefIds: ["mcp.linear.app", "linear"], status: "ready", enabled: true, connectedAt: "2026-11-01T00:00:00.000Z", lastUsedAt: null }],
  }, { actorId: "user_idle", displayName: "Ida Idle", blockedServerDefIds: [], connections: [] }],
  servers: [{ serverDefId: "linear", mode: "recommend", defaultToolPolicy: "allow", toolOverrides: {}, updatedAt: "2026-11-01T00:00:00.000Z" }],
  ...overrides,
});
const usage = { truncated: false, updatedAt: "2026-11-12T09:30:00.000Z", rows: [
  { day: today, actorId: "user_mo", serverKey: "mcp.linear.app", toolName: "list_issues", calls: 3, failures: 1 },
  { day: today, actorId: "user_mo", serverKey: "mcp.linear.app", toolName: "get_issue", calls: 2, failures: 0 },
] };

/** A fake platform at the HTTP edge; the real client parses every response. */
function fakeApi(responses: { connections?: unknown; usage?: unknown; mutation?: () => Promise<unknown> } = {}) {
  const calls: Array<[string, string, unknown?]> = [];
  const api = {
    get: vi.fn(async (path: string) => {
      calls.push(["GET", path]);
      return path.includes("/usage?") ? responses.usage ?? usage : responses.connections ?? page();
    }),
    put: vi.fn(async (path: string, body: unknown) => { calls.push(["PUT", path, body]); return responses.mutation ? responses.mutation() : { ok: true }; }),
    delete: vi.fn(async (path: string) => { calls.push(["DELETE", path]); return responses.mutation ? responses.mutation() : { ok: true }; }),
  };
  const withClient: WithOrganizationMcpClient = (action) => action(createOrganizationMcpAdminClient(api, "org_acme1"));
  return { api, calls, withClient };
}

describe("Organization → Connections panel", () => {
  // Fault: the admin view drops members' connections or miscounts calls from the usage aggregates.
  it("lists member connections with status and the 30-day call count from usage rows", async () => {
    const { withClient, calls } = fakeApi();
    render(<OrganizationConnectionsPanel organizationName="Acme" withClient={withClient} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    const list = await screen.findByRole("list", { name: "Connections for Mo Member" });
    expect(list.textContent).toContain("Connected");
    expect(list.textContent).toContain("5 calls in 30 days");
    expect(list.textContent).toContain("Recommended");
    expect(screen.queryByText("Ida Idle")).toBeNull();
    expect(screen.getByText("3 (1 failed)")).toBeTruthy();
    expect(screen.getByText(/^Totals updated /).textContent).toBe(`Totals updated ${new Date("2026-11-12T09:30:00.000Z").toLocaleString()}`);
    const { from, to } = usageWindow(new Date());
    expect(calls).toContainEqual(["GET", `/api/orgs/org_acme1/mcp/usage?from=${from}&to=${to}`]);
  });

  // Fault: a block targets the wrong server id, or the view changes before the server confirms.
  it("blocks the connection host for that member and reloads only after the server confirms", async () => {
    const { withClient, calls } = fakeApi();
    render(<OrganizationConnectionsPanel organizationName="Acme" withClient={withClient} />);
    fireEvent.click(await screen.findByRole("button", { name: "Block mcp.linear.app for Mo Member" }));
    await waitFor(() => expect(calls).toContainEqual(["PUT", "/api/orgs/org_acme1/mcp/members/user_mo/blocks/mcp.linear.app", {}]));
    await waitFor(() => expect(calls.filter(([method, path]) => method === "GET" && path.includes("/connections")).length).toBe(2));
  });

  // Fault: unblock removes only the first matching id, so a block saved under the catalog id survives.
  it("unblocks every matching block id, catalog id and hostname alike", async () => {
    const blockedBoth = page();
    (blockedBoth.members[0] as { blockedServerDefIds: string[] }).blockedServerDefIds = ["linear"];
    const { withClient, calls } = fakeApi({ connections: blockedBoth });
    render(<OrganizationConnectionsPanel organizationName="Acme" withClient={withClient} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unblock mcp.linear.app for Mo Member" }));
    await waitFor(() => expect(calls).toContainEqual(["DELETE", "/api/orgs/org_acme1/mcp/members/user_mo/blocks/linear"]));
    expect(calls.filter(([method]) => method === "DELETE")).toEqual([["DELETE", "/api/orgs/org_acme1/mcp/members/user_mo/blocks/linear"]]);
  });

  // Fault: a mode change sends tool fields that overwrite the saved tool policy.
  it("sends only the mode when an admin changes a server's mode", async () => {
    const api = { get: vi.fn(), put: vi.fn(async () => ({ ok: true })), delete: vi.fn() };
    await createOrganizationMcpAdminClient(api, "org_acme1").setServerMode("linear", "block");
    expect(api.put).toHaveBeenCalledWith("/api/orgs/org_acme1/mcp/servers/linear", { mode: "block" });
  });

  // Fault: provider, path, or database text from a failed request reaches the admin.
  it("shows only allowlisted copy when a change fails and keeps the current view", async () => {
    const { withClient } = fakeApi({ mutation: async () => { throw new Error("pg: relation org_mcp_member_blocks does not exist at /srv/db"); } });
    render(<OrganizationConnectionsPanel organizationName="Acme" withClient={withClient} />);
    fireEvent.click(await screen.findByRole("button", { name: "Block mcp.linear.app for Mo Member" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That change couldn’t be saved. Try again.");
    expect(screen.getByRole("list", { name: "Connections for Mo Member" })).toBeTruthy();
  });

  // Fault: an invalid server id is sent, or a valid one is sent with the wrong default policy.
  it("validates a new server id before saving it as recommended", async () => {
    const { withClient, calls } = fakeApi();
    render(<OrganizationConnectionsPanel organizationName="Acme" withClient={withClient} />);
    const input = await screen.findByRole("textbox", { name: "Server to govern" });
    fireEvent.change(input, { target: { value: "../etc/passwd" } });
    fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
    expect(await screen.findByText(/Enter a catalog id/)).toBeTruthy();
    expect(calls.some(([method]) => method === "PUT")).toBe(false);
    fireEvent.change(input, { target: { value: "Mcp.Notion.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
    await waitFor(() => expect(calls).toContainEqual(["PUT", "/api/orgs/org_acme1/mcp/servers/mcp.notion.com", { mode: "recommend" }]));
  });

  // Fault: a response carrying credential-shaped fields is rendered instead of rejected.
  it("rejects responses that carry fields outside the metadata contract", async () => {
    const leaked = page();
    (leaked.members[0]!.connections[0] as Record<string, unknown>).encryptedCredentials = "ciphertext";
    const { withClient } = fakeApi({ connections: leaked });
    render(<OrganizationConnectionsPanel organizationName="Acme" withClient={withClient} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Connections are unavailable right now.");
    expect(screen.queryByText(/ciphertext/)).toBeNull();
  });

  it("shows an onboarding empty state when no member has connected a server", async () => {
    const { withClient } = fakeApi({ connections: page({ members: [], servers: [] }), usage: { truncated: false, updatedAt: "2026-11-12T09:30:00.000Z", rows: [] } });
    render(<OrganizationConnectionsPanel organizationName="Acme" withClient={withClient} />);
    expect((await screen.findByText("No member connections yet"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  // Fault: the transport follows redirects, reaches non-admin paths, hangs, or surfaces server text.
  it("sends bounded same-origin requests to admin paths only and reports one generic error", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    const api = createOrganizationMcpHttpApi({ baseUrl: "https://app.matrix-os.test/vm/alice", fetchImpl: fetchImpl as unknown as typeof fetch });
    await api.put!("/api/orgs/org_acme1/mcp/servers/linear", { mode: "block" });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.matrix-os.test/api/orgs/org_acme1/mcp/servers/linear", expect.objectContaining({
      method: "PUT", redirect: "error", credentials: "same-origin", body: JSON.stringify({ mode: "block" }), signal: expect.any(AbortSignal),
    }));
    for (const path of ["/api/organizations/org_acme1", "//evil.test/api/orgs/org_a/mcp/x", "/api/orgs/org_a/mcp/../../admin"]) {
      await expect(api.get(path)).rejects.toThrow("OrganizationConnectionsUnavailable");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: "pg: connection refused" }), { status: 503, headers: { "content-type": "application/json" } }));
    await expect(api.get("/api/orgs/org_acme1/mcp/connections")).rejects.toThrow(/^OrganizationConnectionsUnavailable$/);
  });
});
