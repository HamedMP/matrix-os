// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useProviderPreferences } from "@desktop/renderer/src/features/settings/provider-preferences";
import { useRetainedComposerDrafts } from "@desktop/renderer/src/features/chat/retained-composer-drafts";
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
});
