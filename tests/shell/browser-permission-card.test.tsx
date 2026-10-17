// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserPermissionCard } from "../../packages/ui/src/browser-permission/BrowserPermissionCard";
import type { CanonicalChatApprovalView } from "@matrix-os/contracts";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const approval: CanonicalChatApprovalView = { id: "activity", runId: "run", approvalId: "browser_one", title: "Use Matrix Browser", description: "Use your Chrome profile.", risk: "medium", allowedDecisions: ["approve", "decline", "cancel"], pending: true, timestamp: Date.now(), actionDigest: "a".repeat(64),
  browserApproval: { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(Date.now()+60_000).toISOString() } };
it("offers distinct browser scopes and sends the chosen scope", async () => {
  const onDecision = vi.fn(async () => {}); render(<BrowserPermissionCard approval={approval} onDecision={onDecision}/>);
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow in this Chat" }));
  await waitFor(() => expect(onDecision).toHaveBeenCalledWith("allow_in_chat"));
  expect(screen.queryByRole("button", { name: "Approve for session" })).toBeNull();
});
it("blocks expired approvals and displays a recoverable outcome", () => {
  render(<BrowserPermissionCard approval={{ ...approval, browserApproval: { ...approval.browserApproval!, expiresAt: new Date(0).toISOString() } }} onDecision={vi.fn()}/>);
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull(); expect(screen.getByText(/Request expired/)).toBeTruthy();
});
it("does not claim a remembered grant was removed when Undo fails", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  const client = { getGrant: vi.fn(async () => grant), revokeGrant: vi.fn(async () => { throw new Error("Unavailable"); }) };
  render(<BrowserPermissionCard approval={{ ...approval, pending: false, browserApproval: { ...approval.browserApproval!, resolution: "allowed_in_chat" }, browserGrant: grant }} client={client}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByRole("alert"); expect(screen.getByText("Allowed in this Chat")).toBeTruthy();
  expect(warning).toHaveBeenCalledWith("[browser-permission] Decision failed", "Error");
});
it("checks expiry again between rendering and a click", async () => {
  const onDecision = vi.fn(async () => {}); render(<BrowserPermissionCard approval={approval} onDecision={onDecision}/>);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(approval.browserApproval!.expiresAt)+1);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await screen.findByRole("alert"); expect(onDecision).not.toHaveBeenCalled(); vi.restoreAllMocks();
});
