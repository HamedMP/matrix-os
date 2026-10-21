// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { canonicalChatApprovals, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import { ConversationTranscript } from "../../desktop/src/renderer/src/components/conversation/transcript";
import { CanonicalApprovalMessage } from "../../shell/src/components/chat/CanonicalApprovalMessage";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";

function fixture(browser = true) {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  return { ...snapshot, activities: [{ id: "evt_request", chatId: run.chatId, runId: run.id,
    occurredAt: run.updatedAt, type: "approval.requested", approvalId: "approval_mixed", title: "Search the web",
    safeDescription: "Read public pages", actionDigest: "a".repeat(64), risk: "low", allowedDecisions: ["approve", "decline", "cancel"],
    ...(browser ? { browserApproval: { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90",
      challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } } : {}),
  }] } as CanonicalChatDetailResponse;
}
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps browser lifecycle/grant and generic expiry separate for identical approval IDs on different runs", () => {
  const detail = fixture(); const browser = detail.activities[0]!;
  if (browser.type !== "approval.requested") throw new Error("Missing fixture approval");
  const other = { ...detail.runs[0]!, id: "run_generic" };
  detail.runs.push(other);
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: detail.chat.id, capability: "shared_chrome" as const,
    scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: browser.occurredAt, revokedAt: null };
  detail.activities.push(
    { ...browser, id: "evt_generic", runId: other.id, browserApproval: undefined },
    { id: "evt_browser_resolved", chatId: detail.chat.id, runId: browser.runId, occurredAt: browser.occurredAt,
      type: "approval.resolved", approvalId: browser.approvalId, decision: "approve",
      browserApproval: { ...browser.browserApproval!, resolution: "allowed_in_chat" }, browserGrant: grant },
    { id: "evt_generic_resolved", chatId: detail.chat.id, runId: other.id, occurredAt: browser.occurredAt,
      type: "approval.resolved", approvalId: browser.approvalId, decision: "cancel", reason: "expired" },
  );
  const views = canonicalChatApprovals(detail);
  expect(views.find(view => view.runId === browser.runId)).toMatchObject({ decision: "approve", browserGrant: grant,
    browserApproval: { resolution: "allowed_in_chat" }, pending: false });
  expect(views.find(view => view.runId === browser.runId)).not.toHaveProperty("reason");
  expect(views.find(view => view.runId === other.id)).toMatchObject({ decision: "cancel", reason: "expired", pending: false });
  expect(views.find(view => view.runId === other.id)).not.toHaveProperty("browserGrant");
});

it.each(["Web", "Electron"])("%s keeps browser choices when the title also names a supervised tool", async surface => {
  const detail = fixture(); const perform = vi.fn().mockResolvedValue(undefined);
  if (surface === "Web") render(<CanonicalApprovalMessage message={projectCanonicalTranscript(detail).find(m => m.metadata?.canonicalApproval)!}
    submitting={false} onSubmit={perform} />);
  else render(<ConversationTranscript turns={canonicalChatPresentation(detail)} callbacks={{ copyText: vi.fn(), performAction: perform }} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow in this Chat" }));
  await waitFor(() => expect(perform).toHaveBeenCalledOnce());
  if (surface === "Web") expect(perform).toHaveBeenCalledWith(detail.runs[0]!.id, "approval_mixed", "approve", "allow_in_chat");
  else expect(perform).toHaveBeenCalledWith(expect.objectContaining({ requestId: "approval_mixed", decision: "approve", browserChoice: "allow_in_chat" }));
});

it("Electron browser rejection remains retryable instead of being reported as submitted", async () => {
  const performAction = vi.fn().mockRejectedValue(new Error("FixtureRejected"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  render(<ConversationTranscript turns={canonicalChatPresentation(fixture())} callbacks={{ copyText: vi.fn(), performAction }} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(performAction).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.queryByText("Decision submitted. Waiting for confirmation.")).toBeNull();
  expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
});

it("Electron viewers without offered-action permission receive no active browser choices", () => {
  const performAction = vi.fn();
  render(<ConversationTranscript turns={canonicalChatPresentation(fixture())}
    callbacks={{ copyText: vi.fn(), performAction, canPerformAction: () => false }} />);
  expect(screen.getByRole("button", { name: "Allow once" }).hasAttribute("disabled")).toBe(true);
  expect(performAction).not.toHaveBeenCalled();
});

it("Web supervised tool rejection retains the safe generic failure alert", async () => {
  const onSubmit = vi.fn().mockRejectedValue(new Error("FixtureRejected"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  render(<CanonicalApprovalMessage message={projectCanonicalTranscript(fixture(false)).find(m => m.metadata?.canonicalApproval)!}
    submitting={false} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not submit approval. Try again."));
});
