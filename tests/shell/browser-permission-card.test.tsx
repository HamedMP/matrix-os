// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserPermissionCard } from "../../packages/ui/src/browser-permission/BrowserPermissionCard";
import { BrowserPermissionReviewProvider } from "../../packages/ui/src/browser-permission/BrowserPermissionReview";
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
it("retries an uncertain Undo with the same owner request identity", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  const revokeGrant = vi.fn().mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce({ ...grant, state: "revoked", revision: 2, revokedAt: new Date().toISOString() });
  render(<BrowserPermissionCard approval={{ ...approval, pending: false, browserApproval: { ...approval.browserApproval!, resolution: "allowed_in_chat" }, browserGrant: grant }} client={{ getGrant: async () => grant, revokeGrant }}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" })); await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Undo" })); await screen.findByText("Remembered browser access removed");
  expect(revokeGrant.mock.calls[1]![1]).toBe(revokeGrant.mock.calls[0]![1]);
});
it("finds and revokes saved Chat access when the confirmation activity was lost", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  const client = { getGrant: vi.fn(async () => grant), revokeGrant: vi.fn(async () => ({ ...grant, state: "revoked" as const, revision: 2, revokedAt: new Date().toISOString() })) };
  render(<BrowserPermissionCard chatId="chat_test" approval={approval} client={client}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByText("Remembered browser access removed");
  expect(client.getGrant).toHaveBeenCalledWith("chat_test");
  expect(client.revokeGrant).toHaveBeenCalledWith(grant, expect.any(String));
});
it("checks saved access after an uncertain Allow in this Chat response", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  const getGrant = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(grant);
  render(<BrowserPermissionCard chatId="chat_test" approval={approval} client={{ getGrant, revokeGrant: vi.fn() }} onDecision={async () => { throw new Error("Response lost"); }}/>);
  await waitFor(() => expect(getGrant).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Allow in this Chat" }));
  await screen.findByRole("button", { name: "Undo" });
  expect(screen.getByText("Browser access is saved for this Chat")).toBeTruthy();
});
it("never projects another Chat's returned grant", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_other", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  const getGrant = vi.fn(async () => grant);
  render(<BrowserPermissionCard chatId="chat_test" approval={approval} client={{ getGrant, revokeGrant: vi.fn() }}/>);
  await waitFor(() => expect(getGrant).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});
it("ignores a late grant read after switching Chat", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_old", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  let finish!: (value: typeof grant) => void;
  const getGrant = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  const client = { getGrant, revokeGrant: vi.fn() };
  const { rerender } = render(<BrowserPermissionCard chatId="chat_old" approval={approval} client={client}/>);
  rerender(<BrowserPermissionCard chatId="chat_new" approval={approval} client={client}/>);
  finish(grant);
  await waitFor(() => expect(getGrant).toHaveBeenCalledWith("chat_new"));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});
it("refreshes every browser card after another card removes the shared Chat grant", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  let active: typeof grant | null = grant;
  const client = { getGrant: vi.fn(async () => active), revokeGrant: vi.fn(async () => { active = null; return { ...grant, state: "revoked" as const, revision: 2, revokedAt: new Date().toISOString() }; }) };
  render(<BrowserPermissionReviewProvider>{["first", "second"].map(id => <BrowserPermissionCard key={id} chatId="chat_test" approval={{ ...approval, approvalId: id }} client={client}/>)}</BrowserPermissionReviewProvider>);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]!);
  await waitFor(() => expect(screen.queryAllByRole("button", { name: "Undo" })).toHaveLength(0));
  expect(screen.queryAllByText("Browser access is saved for this Chat")).toHaveLength(0);
});
it("shows an accepted browser decision as awaiting confirmation", async () => {
  render(<BrowserPermissionCard approval={approval} onDecision={async () => {}}/>);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await screen.findByText("Decision submitted. Waiting for confirmation.");
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
});
it.each(["active", "error"])("ignores an older %s read after confirmed Undo", async outcome => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome" as const, scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  let finish!: (value: typeof grant) => void; let fail!: (error: Error) => void;
  const client = { getGrant: vi.fn().mockResolvedValueOnce(grant).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; })),
    revokeGrant: vi.fn(async () => ({ ...grant, state: "revoked" as const, revision: 2, revokedAt: new Date().toISOString() })) };
  const { rerender } = render(<BrowserPermissionCard chatId="chat_test" approval={{ ...approval, browserGrant: grant }} client={client}/>);
  await screen.findByRole("button", { name: "Undo" });
  rerender(<BrowserPermissionCard chatId="chat_test" approval={{ ...approval, browserGrant: { ...grant } }} client={client}/>);
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Undo" })); await screen.findByText("Remembered browser access removed");
  await React.act(async () => { if (outcome === "active") finish(grant); else fail(new Error("Old read failed")); });
  expect(screen.getByText("Remembered browser access removed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
