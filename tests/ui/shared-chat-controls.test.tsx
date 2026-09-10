// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { SharedChatControls } from "../../packages/ui/src/collaboration/SharedChatControls";

const scopeId = "10000000-0000-4000-8000-000000000001";
const chatId = "chat_one";
const baseScope = {
  id: scopeId,
  ownerId: "user_owner",
  kind: "chat" as const,
  resourceId: chatId,
  membershipMode: "direct" as const,
  lifecycle: "shared" as const,
  revision: "1",
  authEpoch: "1",
  authorityGeneration: "1",
  role: "editor" as const,
  capabilities: { read: true, discuss: true, manageMembers: false, requestAi: true },
};
const defaultSelection = { instanceId: "claude_shared", model: "claude-opus-4-6" };

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "qturn_one",
    chatId,
    acceptedSequence: "1",
    actor: { actorId: "user_editor", displayName: "Ada" },
    state: "queued",
    text: "Ship the release",
    selection: defaultSelection,
    acceptedAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("shared Chat AI controls", () => {
  it("keeps AI text private after failure, then submits it as a distinct request", async () => {
    let fail = true;
    const updateDraft = vi.fn();
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => ({ requests: [], approvals: [], defaultSelection })),
      post: vi.fn(async () => {
        if (fail) throw new Error("private provider detail");
        return { request: request(), resourceRevision: "5" };
      }),
      delete: vi.fn(),
    };
    const { rerender } = render(<SharedChatControls api={api} scope={baseScope} actorId="user_editor"
      resourceRevision="4" draft={{ text: "", mode: "discussion" }} updateDraft={updateDraft}
      changeDraftMode={(mode) => updateDraft("", mode)}
      discussionSending={false} discussionError={false} sendDiscussion={vi.fn()} refreshVersion={0} />);

    expect(await screen.findByRole("button", { name: "Ask AI" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(updateDraft).toHaveBeenCalledWith("", "ai");
    rerender(<SharedChatControls api={api} scope={baseScope} actorId="user_editor"
      resourceRevision="4" draft={{ text: "Summarize decisions", mode: "ai" }} updateDraft={updateDraft}
      changeDraftMode={(mode) => updateDraft("", mode)}
      discussionSending={false} discussionError={false} sendDiscussion={vi.fn()} refreshVersion={0} />);
    updateDraft.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Request AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI request was not accepted");
    expect(updateDraft).not.toHaveBeenCalledWith("", "ai");

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Request AI" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/chat/requests`,
      expect.objectContaining({ expectedRevision: "1", text: "Summarize decisions", selection: defaultSelection }),
    ));
    await waitFor(() => expect(updateDraft).toHaveBeenCalledWith("", "ai"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel request 1" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/chat/requests/qturn_one/cancel`,
      expect.objectContaining({ expectedRevision: "5" }),
    ));
  });

  it("keeps Ask AI disabled when current scope capabilities deny requests", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => ({ requests: [], approvals: [], defaultSelection })),
      post: vi.fn(), delete: vi.fn(),
    };
    render(<SharedChatControls api={api} scope={{ ...baseScope,
      capabilities: { ...baseScope.capabilities, requestAi: false } }} actorId="user_editor"
      resourceRevision="4" draft={{ text: "Private AI draft", mode: "discussion" }} updateDraft={vi.fn()}
      changeDraftMode={vi.fn()}
      discussionSending={false} discussionError={false} sendDiscussion={vi.fn()} refreshVersion={0} />);

    expect(await screen.findByRole("button", { name: "Ask AI" })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("renders immutable queue order and scopes editor controls to their own requests", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => ({
        defaultSelection,
        approvals: [],
        requests: [
          request(),
          request({ id: "qturn_two", acceptedSequence: "2", actor: { actorId: "user_owner", displayName: "Nima" },
            state: "interrupted", text: "Check deployment" }),
        ],
      })),
      post: vi.fn(async () => ({})),
      delete: vi.fn(),
    };
    render(<SharedChatControls api={api} scope={baseScope} actorId="user_editor"
      resourceRevision="4" draft={{ text: "", mode: "ai" }} updateDraft={vi.fn()}
      changeDraftMode={vi.fn()}
      discussionSending={false} discussionError={false} sendDiscussion={vi.fn()} refreshVersion={0} />);

    expect(await screen.findByText("1 · Ada")).toBeVisible();
    expect(screen.getByText("2 · Nima")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel request 1" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry request 2" })).toBeNull();
  });

  it("keeps viewers read-only even when M2 is available", async () => {
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => ({ requests: [request()], approvals: [], defaultSelection })),
      post: vi.fn(), delete: vi.fn(),
    };
    render(<SharedChatControls api={api} scope={{ ...baseScope, role: "viewer",
      capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false } }} actorId="user_viewer"
      resourceRevision="4" draft={{ text: "", mode: "discussion" }} updateDraft={vi.fn()}
      changeDraftMode={vi.fn()}
      discussionSending={false} discussionError={false} sendDiscussion={vi.fn()} refreshVersion={0} />);

    expect(await screen.findByRole("button", { name: "Ask AI" })).toBeDisabled();
    expect(screen.getByLabelText("Message everyone")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Cancel request/i })).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows pending approvals only to owners and submits one attributed decision", async () => {
    const ownerScope = { ...baseScope, role: "owner" as const,
      capabilities: { read: true, discuss: true, manageMembers: true, requestAi: true } };
    const api = {
      baseUrl: "https://app.matrix-os.com",
      get: vi.fn(async () => ({
        requests: [request({ runId: "run_one", state: "waiting_for_approval" })],
        approvals: [{ approvalId: "approval_one", runId: "run_one", requestId: "qturn_one",
          title: "Publish release", risk: "high", allowedDecisions: ["approve", "decline"], state: "pending" }],
        defaultSelection,
      })),
      post: vi.fn(async () => ({ state: "completed" })), delete: vi.fn(),
    };
    render(<SharedChatControls api={api} scope={ownerScope} actorId="user_owner"
      resourceRevision="4" draft={{ text: "", mode: "ai" }} updateDraft={vi.fn()}
      changeDraftMode={vi.fn()}
      discussionSending={false} discussionError={false} sendDiscussion={vi.fn()} refreshVersion={0} />);

    expect(await screen.findByText("Approval needed: Publish release")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Approve Publish release" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      `/api/collaboration/scopes/${scopeId}/chat/approvals/approval_one/decision`,
      expect.objectContaining({ runId: "run_one", decision: "approve", expectedRevision: "4" }),
    ));
  });
});
