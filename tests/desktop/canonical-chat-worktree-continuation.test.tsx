// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useRetainedComposerDrafts } from "@desktop/renderer/src/features/chat/retained-composer-drafts";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import { AppError } from "@desktop/shared/app-error";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { mockSharedComposerPopoverLayout, setSharedComposerText } from "./shared-chat-composer-test-utils";

const worktree = { kind: "worktree", projectId: "matrix-os", worktreeId: "wt_00000000000a" } as const;

function worktreeFixture(state: "completed" | "running" = "completed") {
  const { snapshot, providerCatalog } = createCanonicalChatFixture(state);
  const { project, providerBinding, activeRun, ...chat } = snapshot.chat;
  const run = { ...snapshot.runs[0]!, executionRoot: worktree };
  const detail: CanonicalChatDetailResponse = {
    record: { chat, projectId: project.projectId, providerBinding, ...(activeRun ? { activeRun } : {}) },
    messages: snapshot.messages,
    turns: snapshot.turns,
    runs: [run],
    activities: snapshot.activities,
  };
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [detail.record] });
  vi.mocked(client.getDetail).mockResolvedValue(detail);
  vi.mocked(client.admitTurn).mockImplementation(async (_chatId, input) => ({
    admission: "accepted",
    record: detail.record,
    message: snapshot.messages[0]!,
    turn: { ...snapshot.turns[0]!, clientRequestId: input.clientRequestId },
    run: { ...run, permissionMode: input.permissionMode, executionRoot: input.executionRoot },
  }));
  vi.mocked(client.queueTurn).mockImplementation(async (_chatId, input) => ({
    queueDepth: 1,
    queuedTurn: {
      ...input, id: "qturn_continuation", chatId: chat.id, position: 1,
      createdAt: run.createdAt, updatedAt: run.updatedAt,
    },
  }));
  return { detail, client, providerCatalog };
}

function openWorkspace(fixture: ReturnType<typeof worktreeFixture>) {
  return render(<CanonicalChatWorkspace client={fixture.client} projectId="matrix-os"
    initialChatId={fixture.detail.record.chat.id} initialView="conversation"
    active catalog={fixture.providerCatalog} />);
}

describe("native Chat worktree continuation", () => {
  let restoreLayout: () => void;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    restoreLayout = mockSharedComposerPopoverLayout();
    useConnection.setState({ ...useConnection.getInitialState(), status: "signed-in", userId: "user_fixture" }, true);
    useBoard.setState(useBoard.getInitialState(), true);
    useProviderPreferences.setState({ ...useProviderPreferences.getInitialState(), hydrated: true }, true);
    useRetainedComposerDrafts.setState(useRetainedComposerDrafts.getInitialState(), true);
    window.operator = { invoke: vi.fn(async () => ({ available: false })), on: vi.fn(() => () => undefined) };
  });
  afterEach(() => { cleanup(); restoreLayout(); vi.unstubAllGlobals(); });

  it("continues in the same worktree after reopening and keeps the selected Full Access mode", async () => {
    const fixture = worktreeFixture();
    const first = openWorkspace(fixture);
    await screen.findByRole("textbox", { name: "Reply to chat" });
    first.unmount();
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Full Access" }));
    await setSharedComposerText(editor, "Change the Files menu in this worktree.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.client.admitTurn).toHaveBeenCalledWith(
      fixture.detail.record.chat.id,
      expect.objectContaining({ executionRoot: worktree, permissionMode: "full_access",
        parts: [{ type: "text", text: "Change the Files menu in this worktree." }] }),
      { chatScope: "project" },
    ));
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("Full Access");
  });

  it("queues a normal follow-up in the running worktree", async () => {
    const fixture = worktreeFixture("running");
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Then run the Files tests in the same worktree.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.client.queueTurn).toHaveBeenCalledWith(
      fixture.detail.record.chat.id,
      expect.objectContaining({ executionRoot: worktree, parts: [{ type: "text", text: "Then run the Files tests in the same worktree." }] }),
    ));
  });

  it.each(["project_new", null])("sends an ordinary reply after the owner changes project scope to %s", async projectId => {
    const fixture = worktreeFixture();
    const { projectId: originalProjectId, ...unassignedRecord } = fixture.detail.record;
    const chatId = fixture.detail.record.chat.id;
    const baseRevision = fixture.detail.record.chat.revision;
    const baseMessageSeq = fixture.detail.record.chat.messageCount;
    const movedRecord = { ...unassignedRecord,
      chat: { ...unassignedRecord.chat, revision: baseRevision + 1 },
      ...(projectId === null ? {} : { projectId }),
    };
    let persisted = fixture.detail;
    const patch = vi.fn(async (_path: string, _body: unknown) => {
      persisted = { ...persisted, record: movedRecord };
      return movedRecord;
    });
    const { snapshot: accepted } = createCanonicalChatFixture("accepted");
    const [message] = accepted.messages;
    const [turn] = accepted.turns;
    const [run] = accepted.runs;
    const effectiveRoot = projectId === null ? undefined : { kind: "project", projectId };
    const post = vi.fn(async (_path: string, input: CanonicalCreateChatTurnRequest) => ({
      admission: "accepted",
      record: { ...movedRecord, chat: { ...movedRecord.chat, revision: baseRevision + 2, messageCount: baseMessageSeq + 1 },
        activeRun: accepted.chat.activeRun },
      message: { ...message!, chatId, seq: baseMessageSeq + 1, parts: input.parts },
      turn: { ...turn!, chatId, baseMessageSeq, clientRequestId: input.clientRequestId },
      run: { ...run!, chatId, historyBoundarySeq: baseMessageSeq, executionRoot: effectiveRoot,
        executionRootFingerprint: effectiveRoot ? run!.executionRootFingerprint : undefined },
    }));
    const transport = { get: async () => persisted, patch, post, delete: vi.fn() };
    const { updateProject, getDetail, admitTurn } = createCanonicalChatClient(
      transport as Pick<ApiClient, "get" | "post" | "patch" | "delete">,
      { trackEvent: vi.fn() },
    );
    const client = { ...fixture.client, updateProject, getDetail, admitTurn };
    const open = (scope: string | null) => renderHook(() => useCanonicalChatRouteController({
      client, projectId: scope, active: true, initialChatId: chatId,
    }));
    const original = open(originalProjectId ?? null);
    await waitFor(() => expect(original.result.current.detail?.runs[0]?.executionRoot).toEqual(worktree));
    await act(async () => { expect(await original.result.current.moveProject(projectId)).toEqual(movedRecord); });
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`/api/chats/${chatId}/project?`), { baseRevision, projectId },
    );
    original.unmount();

    const moved = open(projectId);
    await waitFor(() => expect(moved.result.current.detail?.record).toEqual(movedRecord));
    expect(moved.result.current.detail?.runs[0]?.executionRoot).toEqual(worktree);
    const parts = [{ type: "text" as const, text: "Reply in the new scope." }];
    await act(async () => {
      const receipt = await moved.result.current.submitTurn({ parts,
        selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
        interactionMode: "default", permissionMode: "supervised" }, "Follow-up");
      expect(receipt).toMatchObject({ admission: "accepted", message: { id: message!.id, parts },
        turn: { id: turn!.id }, run: { id: run!.id } });
      expect(receipt?.run.executionRoot).toEqual(effectiveRoot);
    });
    expect(post).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`/api/chats/${chatId}/turns?`),
      expect.objectContaining({ baseRevision: baseRevision + 1, parts }),
      expect.anything(),
    );
    // Omitting the historical root selects the current project or owner home at the gateway.
    expect(post.mock.calls[0]![1]).not.toHaveProperty("executionRoot");
  });

  it("does not resurrect an earlier worktree after a deliberate project-root run", async () => {
    const fixture = worktreeFixture();
    fixture.detail.runs.push({ ...fixture.detail.runs[0]!, id: "run_project_root",
      executionRoot: { kind: "project", projectId: "matrix-os" } });
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Continue at the selected project root.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.client.admitTurn).toHaveBeenCalledOnce());
    expect(vi.mocked(fixture.client.admitTurn).mock.calls[0]![1]).not.toHaveProperty("executionRoot");
  });

  it.each([404, 503])("keeps the worktree draft when the server rejects it with %i", async httpStatus => {
    const fixture = worktreeFixture();
    vi.mocked(fixture.client.admitTurn).mockRejectedValue(new AppError("server", { httpStatus }));
    openWorkspace(fixture);
    const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
    await setSharedComposerText(editor, "Do not fall back to the project checkout.");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    expect(fixture.client.admitTurn).toHaveBeenCalledOnce();
    expect(vi.mocked(fixture.client.admitTurn).mock.calls[0]![1].executionRoot).toEqual(worktree);
    expect(editor.textContent).toBe("Do not fall back to the project checkout.");
    if (httpStatus === 503) {
      const request = vi.mocked(fixture.client.admitTurn).mock.calls[0]![1];
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(fixture.client.admitTurn).toHaveBeenCalledTimes(2));
      expect(vi.mocked(fixture.client.admitTurn).mock.calls[1]![1]).toEqual(request);
      expect(editor.textContent).toBe("Do not fall back to the project checkout.");
    }
  });

  it("never dispatches with the previous Chat's root while navigation is loading", async () => {
    const fixture = worktreeFixture();
    const { result } = renderHook(() => useCanonicalChatRouteController({ client: fixture.client,
      projectId: "matrix-os", active: true, initialChatId: fixture.detail.record.chat.id }));
    await waitFor(() => expect(result.current.detail?.record.chat.id).toBe(fixture.detail.record.chat.id));
    const staleSubmit = result.current.submitTurn;
    let finishLoad!: (detail: CanonicalChatDetailResponse) => void;
    vi.mocked(fixture.client.getDetail).mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    act(() => result.current.selectChat("chat_other"));
    const input = { parts: [{ type: "text", text: "Continue only the selected Chat." }] as const,
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default" as const, permissionMode: "full_access" as const };
    await act(async () => { await staleSubmit({ ...input, parts: [...input.parts] }, "Follow-up"); });
    expect(fixture.client.admitTurn).not.toHaveBeenCalled();
    const next: CanonicalChatDetailResponse = { ...fixture.detail,
      record: { ...fixture.detail.record, chat: { ...fixture.detail.record.chat, id: "chat_other" } },
      runs: [{ ...fixture.detail.runs[0]!, chatId: "chat_other",
        executionRoot: { ...worktree, worktreeId: "wt_00000000000b" } }] };
    await act(async () => finishLoad(next));
    await act(async () => { await result.current.submitTurn({ ...input, parts: [...input.parts] }, "Follow-up"); });
    expect(fixture.client.admitTurn).toHaveBeenCalledWith("chat_other",
      expect.objectContaining({ executionRoot: next.runs[0]!.executionRoot, permissionMode: "full_access" }),
      { chatScope: "project" });
  });

  it("resets the inherited worktree when starting a new Chat", async () => {
    const fixture = worktreeFixture();
    const { result } = renderHook(() => useCanonicalChatRouteController({ client: fixture.client,
      projectId: "matrix-os", active: true, initialChatId: fixture.detail.record.chat.id }));
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    vi.mocked(fixture.client.create).mockResolvedValue({ ...fixture.detail.record,
      chat: { ...fixture.detail.record.chat, id: "chat_new" } });
    act(() => result.current.selectChat(null));
    await act(async () => { await result.current.submitTurn({ parts: [{ type: "text", text: "A fresh Chat." }],
      selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
      interactionMode: "default", permissionMode: "full_access" }, "New Chat"); });
    expect(fixture.client.create).toHaveBeenCalledOnce();
    expect(fixture.client.admitTurn).toHaveBeenCalledWith("chat_new",
      expect.objectContaining({ permissionMode: "full_access" }), { chatScope: "project" });
    expect(vi.mocked(fixture.client.admitTurn).mock.calls[0]![1]).not.toHaveProperty("executionRoot");
  });
});
