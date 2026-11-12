// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExternalMcpApprovalsSection from "@desktop/renderer/src/features/plugins/ExternalMcpApprovalsSection";
import { useConnection } from "@desktop/renderer/src/stores/connection";

afterEach(cleanup);

describe("Electron Desktop external MCP approvals", () => {
  // Fault: Electron Desktop cannot decide external writes, or sends them outside the gateway client.
  it("lists pending writes and declines through the trusted gateway client", async () => {
    const approval = { approvalId: "22222222-2222-4222-8222-222222222222", service: "notion-9f8e7d6c", tool: "delete_page",
      createdAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    const lists = [{ approvals: [approval] }, { approvals: [] }];
    const api = { get: vi.fn(async () => lists.shift() ?? { approvals: [] }), post: vi.fn(async () => ({ status: "denied" })) };
    useConnection.setState({ api: api as never });
    render(<ExternalMcpApprovalsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline delete_page on notion-9f8e7d6c" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/api/mcp-servers/core/external-approvals/${approval.approvalId}`, { decision: "decline" }));
    expect(await screen.findByText("No external writes are waiting")).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("/api/mcp-servers/core/external-approvals");
  });
});
