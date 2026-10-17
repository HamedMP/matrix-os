// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserPermissionCard } from "../../packages/ui/src/browser-permission/BrowserPermissionCard";
import type { BrowserGrantView, CanonicalChatApprovalView } from "@matrix-os/contracts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const grant: BrowserGrantView = {
  id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome",
  scopeVersion: 1, revision: 1, state: "active", createdAt: "2026-10-17T00:00:00.000Z", revokedAt: null,
};
const approval: CanonicalChatApprovalView = {
  id: "activity", runId: "run", approvalId: "browser_one", title: "Use Matrix Browser",
  description: "Use your Chrome profile.", risk: "medium", allowedDecisions: ["approve", "decline", "cancel"],
  pending: false, timestamp: 0, actionDigest: "a".repeat(64), browserGrant: grant,
  browserApproval: { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90",
    challengeRevision: 0, scopeVersion: 1, expiresAt: "2026-10-17T00:01:00.000Z", resolution: "allowed_in_chat" },
};

it("refreshes a stale Undo after another view already removed the grant", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const getGrant = vi.fn().mockResolvedValueOnce(grant).mockResolvedValue(null);
  const revokeGrant = vi.fn().mockRejectedValue(new Error("Stale revision"));
  render(<BrowserPermissionCard approval={approval} client={{ getGrant, revokeGrant }}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByText("Browser access is no longer saved for this Chat.");
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(getGrant).toHaveBeenCalledTimes(2);
  expect(revokeGrant).toHaveBeenCalledOnce();
  expect(screen.queryByText("Remembered browser access removed")).toBeNull();
});

it.each(["same_id", "new_id"])("refreshes a replacement %s grant without automatically revoking it", async kind => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const replacement = { ...grant, id: kind === "same_id" ? grant.id : "378ca19d-9760-4e67-a221-62bedf393b90", revision: 3 };
  const getGrant = vi.fn().mockResolvedValueOnce(grant).mockResolvedValue(replacement);
  const revokeGrant = vi.fn().mockRejectedValueOnce(new Error("Stale revision")).mockImplementationOnce(async current => ({
    ...current, state: "revoked", revision: current.revision + 1, revokedAt: "2026-10-17T00:02:00.000Z",
  }));
  render(<BrowserPermissionCard approval={approval} client={{ getGrant, revokeGrant }}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByText("Browser access changed. Review it before using Undo again.");
  expect(revokeGrant).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByText("Remembered browser access removed");
  expect(revokeGrant.mock.calls[1]![0]).toEqual(replacement);
  expect(revokeGrant.mock.calls[1]![1]).not.toBe(revokeGrant.mock.calls[0]![1]);
});

it("preserves an uncertain Undo identity when the current grant is unchanged", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const getGrant = vi.fn().mockResolvedValue(grant);
  const revokeGrant = vi.fn().mockRejectedValue(new Error("Response lost"));
  render(<BrowserPermissionCard approval={approval} client={{ getGrant, revokeGrant }}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByRole("alert");
  expect(getGrant).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(revokeGrant).toHaveBeenCalledTimes(2));
  expect(revokeGrant.mock.calls[1]![1]).toBe(revokeGrant.mock.calls[0]![1]);
  expect(screen.queryByText("Remembered browser access removed")).toBeNull();
});

it("keeps the current grant when the recovery read fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const getGrant = vi.fn().mockResolvedValueOnce(grant).mockRejectedValue(new Error("Read unavailable"));
  const revokeGrant = vi.fn().mockRejectedValue(new Error("Undo unavailable"));
  render(<BrowserPermissionCard approval={approval} client={{ getGrant, revokeGrant }}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await screen.findByRole("alert");
  expect(getGrant).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  expect(screen.queryByText("Remembered browser access removed")).toBeNull();
});

it("ignores a late recovery read after the owner switches Chats", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let finish!: (value: null) => void;
  const getGrant = vi.fn().mockResolvedValueOnce(grant)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  const client = { getGrant, revokeGrant: vi.fn().mockRejectedValue(new Error("Stale revision")) };
  const { rerender } = render(<BrowserPermissionCard chatId="chat_test" approval={approval} client={client}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  await waitFor(() => expect(finish).toBeDefined());
  rerender(<BrowserPermissionCard chatId="chat_other" approval={approval} client={client}/>);
  await React.act(async () => { finish(null); });
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Browser access is no longer saved for this Chat.")).toBeNull();
});
