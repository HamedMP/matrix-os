// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ManagedTerminalChatInput } from "../../shell/src/components/chat/ManagedTerminalChatInput";
import { useChatComposerDraft } from "../../shell/src/components/chat/useChatComposerDraft";
import { managedTerminalChatTurn } from "../../shell/src/hooks/managed-terminal-chat-turn";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const workspaceId = "tws_6d6774" + "a".repeat(26);
const source = { chatId: "chat_preview", projectId: "matrix-os", worktreeId: "wt_00000000000a" };
const tabId = "tt_" + "1".repeat(32);
const revision = "a".repeat(64);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ submit }: { submit: ReturnType<typeof vi.fn> }) {
  const composer = useChatComposerDraft(source.chatId, "owner");
  return <ManagedTerminalChatInput composer={composer} scope={source.chatId} managedTerminalScope={source}
    isCurrentAuthority={() => true} matrixGatewayUrl="/vm/source" permissionMode="full_access" connected busy={false}
    attachmentsEnabled={false} onSubmit={submit} />;
}

it("uses the authenticated Web Chat slash action to select a managed Computer without contacting a linked desktop", async () => {
  const request = vi.fn(async (path: string) => {
    if (path === "/vm/source/api/terminal/herdr/managed") {
      return Response.json({ computers: [{ machineId: "dest", name: "Build Preview", runtimeSlot: "pr-57", workspaceId }], partial: false });
    }
    if (path === "/vm/source/api/terminal/herdr/managed?machine=dest") {
      return Response.json({ available: true, status: "ready", sessions: [{ id: "t1", title: "Tests", tabId, revision, status: "idle" }] });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", request);
  const submit = vi.fn(() => true);
  render(<Harness submit={submit} />);
  const editor = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(editor, { target: { value: "/terminal-control" } });
  fireEvent.click(await screen.findByRole("option", { name: /\/terminal-control/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Build Preview" }));
  fireEvent.click(await screen.findByRole("button", { name: "Tests (t1)" }));
  expect(submit).not.toHaveBeenCalled();
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "/vm/source/api/terminal/herdr/managed", "/vm/source/api/terminal/herdr/managed?machine=dest",
  ]);
  fireEvent.change(editor, { target: { value: "Run the tests" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(submit).toHaveBeenCalledWith("Run the tests", undefined, expect.objectContaining({
    managedTerminalControl: { ...source, target: { kind: "terminal_session", id: workspaceId + ":" + tabId, revision, label: "Tests" } },
  }));
});

it("pins the actual Web Chat worktree and fences busy, shared, and stale submissions", () => {
  const { snapshot } = createCanonicalChatFixture("completed");
  const detail: CanonicalChatDetailResponse = {
    record: { chat: snapshot.chat, projectId: source.projectId },
    messages: snapshot.messages, turns: snapshot.turns, activities: snapshot.activities,
    runs: [{ ...snapshot.runs[0]!, executionRoot: { kind: "worktree", projectId: source.projectId, worktreeId: source.worktreeId } }],
  };
  const chatId = snapshot.chat.id;
  const target = { kind: "terminal_session", id: workspaceId + ":" + tabId, revision, label: "Tests" } as const;
  const options = { interactionMode: "default", permissionMode: "full_access", managedTerminalControl: { ...source, chatId, target } };
  expect(managedTerminalChatTurn(options, detail, chatId)).toEqual({
    executionRoot: { kind: "worktree", projectId: source.projectId, worktreeId: source.worktreeId },
    parts: [
      { type: "invocation_reference", invocation: { kind: "command", descriptorId: "terminal-control", invocation: "/terminal-control" } },
      { type: "resource_reference", resource: target },
    ],
  });
  expect(managedTerminalChatTurn(options, detail, "another_chat")).toBeNull();
  expect(managedTerminalChatTurn({ ...options, permissionMode: "supervised" }, detail, chatId)).toBeNull();
  expect(managedTerminalChatTurn(options, { ...detail, runs: snapshot.runs }, chatId)).toBeNull();
  const busy = { ...detail, record: { ...detail.record,
    activeRun: { runId: snapshot.runs[0]!.id, turnId: snapshot.runs[0]!.turnId, status: "running" as const } } };
  expect(managedTerminalChatTurn(options, busy, chatId)).toBeNull();
  const shared = { ...detail, record: { ...detail.record, chat: { ...detail.record.chat,
    collaboration: { mode: "shared" as const, membership: { role: "owner" as const, memberCount: 2 } } } } };
  expect(managedTerminalChatTurn(options, shared, chatId)).toBeNull();
});
