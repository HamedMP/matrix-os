// @vitest-environment jsdom
/**
 * External MCP approval surfaces are wired to the platform-owned owner routes:
 * Settings → Integrations (Web Desktop and Web Canvas share the shell
 * Settings) and the shell notification stack. The owner routes live on the
 * app origin's session-routed `/api/mcp-servers`, never under `/vm/<handle>`,
 * because a VPS gateway does not mount them.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/websocket-auth", () => ({ buildAuthenticatedWebSocketUrl: vi.fn(async () => "ws://gateway.test/ws") }));
vi.mock("@/lib/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gateway")>()),
  getGatewayUrl: () => `${window.location.origin}/vm/alice`,
  getGatewayWs: () => "ws://gateway.test/ws",
}));

import { IntegrationsSection } from "../../shell/src/components/settings/sections/IntegrationsSection.js";
import { ShellExternalMcpApprovalsPill } from "../../shell/src/components/ShellExternalMcpApprovalsPill.js";
import { ShellNotificationStack } from "../../shell/src/components/ShellNotificationStack.js";
import { useSettingsNavigation } from "../../shell/src/hooks/useSettingsNavigation.js";

const APPROVAL = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const pending = () => ({ approvals: [{ approvalId: APPROVAL, service: "linear-1a2b3c4d", tool: "create_issue",
  createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }] });

describe("shell external MCP approvals wiring", () => {
  let approvalsUrl: string;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === approvalsUrl) return json(pending());
    if (url === `${approvalsUrl}/${APPROVAL}` && init?.method === "POST") return json({ status: "approved" });
    if (url.includes("/api/integrations/available")) return json({ services: [] });
    if (url.includes("/api/integrations")) return json({ connections: [] });
    if (url.endsWith("/api/mcp-servers/catalog")) return json({ presets: [] });
    if (url.endsWith("/api/mcp-servers")) return json([]);
    return json({});
  });
  beforeEach(() => {
    // An explicit-computer tab: ordinary gateway calls carry /vm/alice.
    window.history.pushState({}, "", "/vm/alice/");
    approvalsUrl = `${window.location.origin}/api/mcp-servers/core/external-approvals`;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });

  // Fault: under /vm/<handle> the approvals go to a VPS gateway that has no owner routes, so nothing can be approved.
  it("lists and approves pending writes from Settings → Integrations through the platform origin", async () => {
    render(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve create_issue on linear-1a2b3c4d" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${approvalsUrl}/${APPROVAL}`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approve" }) })));
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.includes("external-approvals"))
      .every(url => !url.includes("/vm/"))).toBe(true);
  });

  // Fault: the notification pill never appears, or clicking it opens some other Settings section.
  it("shows the pill in the notification stack and opens Settings → Integrations", async () => {
    function Harness() {
      const { settingsOpen, settingsDefaultSection, openSettings } = useSettingsNavigation();
      return <>
        <ShellNotificationStack><ShellExternalMcpApprovalsPill openSettings={openSettings} /></ShellNotificationStack>
        {settingsOpen ? <p>Settings open at {settingsDefaultSection}</p> : null}
      </>;
    }
    render(<Harness />);
    const pill = await screen.findByRole("button", { name: "1 external MCP write waiting for approval" });
    expect(screen.getByTestId("shell-notification-stack").contains(pill)).toBe(true);
    await act(async () => { fireEvent.click(pill); });
    expect(screen.getByText("Settings open at integrations")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(approvalsUrl, expect.objectContaining({ method: "GET" }));
  });
});
