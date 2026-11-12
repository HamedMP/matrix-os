// @vitest-environment jsdom
/**
 * External MCP approval surfaces are wired to the owner routes: Settings →
 * Integrations (Web Desktop and Web Canvas share the shell Settings) and the
 * shell notification stack.
 */
import { readFile } from "node:fs/promises";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/websocket-auth", () => ({ buildAuthenticatedWebSocketUrl: vi.fn(async () => "ws://gateway.test/ws") }));
vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  getGatewayUrl: () => "http://gateway.test",
  getGatewayWs: () => "ws://gateway.test/ws",
}));

import { IntegrationsSection } from "../../shell/src/components/settings/sections/IntegrationsSection.js";

const APPROVAL = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("shell external MCP approvals wiring", () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://gateway.test/api/mcp-servers/core/external-approvals") {
      return json({ approvals: [{ approvalId: APPROVAL, service: "linear-1a2b3c4d", tool: "create_issue",
        createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }] });
    }
    if (url.endsWith(`/external-approvals/${APPROVAL}`) && init?.method === "POST") return json({ status: "approved" });
    if (url.includes("/api/integrations/available")) return json({ services: [] });
    if (url.includes("/api/integrations")) return json({ connections: [] });
    if (url.endsWith("/api/mcp-servers/catalog")) return json({ presets: [] });
    if (url.endsWith("/api/mcp-servers")) return json([]);
    return json({});
  });
  beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  // Fault: Integrations never shows pending external writes, so they can never be approved.
  it("lists and approves pending external writes from Settings → Integrations", async () => {
    render(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve create_issue on linear-1a2b3c4d" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`http://gateway.test/api/mcp-servers/core/external-approvals/${APPROVAL}`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approve" }) })));
  });

  it("mounts the pending-approval pill in the shell notification stack, opening Integrations", async () => {
    const desktop = await readFile("shell/src/components/Desktop.tsx", "utf8");
    expect(desktop).toMatch(/<ShellNotificationStack>\s*<RuntimeIdentityBanner \/>\s*<ConnectionIndicator \/>\s*<ExternalMcpApprovalsIndicator transport=\{shellExternalMcpApprovals\} onOpen=\{\(\) => openSettings\("integrations"\)\} \/>/);
  });
});
