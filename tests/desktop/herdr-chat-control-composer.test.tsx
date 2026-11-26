// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { canonicalChatInputParts } from "@desktop/renderer/src/features/chat/canonical-chat-submission";
import { createApiClient } from "@desktop/renderer/src/lib/api";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { canonicalChatRecord as record, createCanonicalChatWorkspaceClient, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";
import { mockSharedComposerPopoverLayout, setSharedComposerText } from "./shared-chat-composer-test-utils";

const root = { kind: "worktree", projectId: "matrix-os", worktreeId: "wt_00000000000a" } as const;
const tabId = "tt_" + "1".repeat(32);
const revision = "b".repeat(64);
let restoreLayout: () => void;
beforeEach(() => {
  restoreLayout = mockSharedComposerPopoverLayout();
  useConnection.setState({ status: "signed-in", userId: snapshot.chat.ownerScope.ownerId, runtimeSlot: "pr-55", authGeneration: 12 });
  window.operator = { invoke: vi.fn(async () => ({ available: false })), on: vi.fn(() => () => undefined) };
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); restoreLayout(); vi.unstubAllGlobals(); useConnection.setState(useConnection.getInitialState(), true); });

function workspace(mode = "full_access", variant: "private" | "shared" | "busy" | "new" = "private") {
  const client = createCanonicalChatWorkspaceClient();
  const run = { ...snapshot.runs[0]!, executionRoot: root, permissionMode: mode };
  const chatRecord: CanonicalChatDetailResponse["record"] = {
    ...record,
    chat: { ...record.chat, collaboration: variant === "shared" ? { mode: "shared", membership: { role: "owner", memberCount: 2 } } : { mode: "private" } },
    ...(variant === "busy" ? { activeRun: { runId: run.id, turnId: run.turnId, status: "running" } as const } : {}),
  };
  vi.mocked(client.getDetail).mockResolvedValue({ record: chatRecord, messages: snapshot.messages, turns: snapshot.turns, runs: [run], activities: [] });
  vi.mocked(client.admitTurn).mockImplementation(async (_id, input) => ({
    record, message: snapshot.messages[0]!, turn: { ...snapshot.turns[0]!, clientRequestId: input.clientRequestId }, run, admission: "accepted",
  }));
  const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(new URL(url).pathname === "/api/terminal/herdr"
    ? { available: true, status: "ready", sessions: [{ id: "t7", title: "Build", tabId, revision, status: "idle" }] }
    : {}), { headers: { "Content-Type": "application/json" } }));
  const api = createApiClient({ baseUrl: "https://example.test", getRuntimeSlot: () => "pr-55", fetchFn });
  const eventSource = { subscribe: vi.fn(() => ({ dispose: vi.fn() })), connectionState: () => "open" };
  const view = render(<CanonicalChatWorkspace client={client} api={api} eventSource={eventSource} active
    catalog={providerCatalog} initialChatId={variant === "new" ? undefined : snapshot.chat.id} projectId="matrix-os" initialView={variant === "new" ? "draft" : "conversation"} />);
  return { client, fetchFn, view };
}

it("admits only the owner's selected tab from the current Computer, bound to this message and worktree", async () => {
  const { client, fetchFn } = workspace();
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Check the build @herdr");
  fireEvent.click(await screen.findByRole("option", { name: "Control a Herdr terminal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Build (t7)" }));
  expect(fetchFn.mock.calls.map(([url]) => url).filter(url => new URL(url).pathname === "/api/terminal/herdr")).toEqual([
    "https://example.test/api/terminal/herdr?view=chat-control&runtime=pr-55",
  ]);
  const inventoryRequest = fetchFn.mock.calls.find(([url]) => new URL(url).pathname === "/api/terminal/herdr");
  expect(new Headers(inventoryRequest?.[1]?.headers).get("X-Matrix-Session")).toBe('[12,"pr-55"]');
  expect(client.admitTurn).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(snapshot.chat.id, expect.objectContaining({
    executionRoot: root, permissionMode: "full_access", parts: [
      { type: "text", text: "Check the build" },
      { type: "invocation_reference", invocation: { kind: "command", descriptorId: "herdr-terminal-control", invocation: "/herdr-terminal-control" } },
      { type: "resource_reference", resource: { kind: "terminal_session", id: HERDR_TERMINAL_WORKSPACE_ID + ":" + tabId, label: "Build", revision } },
    ],
  }), { chatScope: "project" }));
  await waitFor(() => expect(screen.queryByText(/Terminal control for this message/)).toBeNull());
  expect(client.queueTurn).not.toHaveBeenCalled();
});

it("keeps control and its session inventory out of a supervised Chat", async () => {
  const { fetchFn } = workspace("supervised");
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "@herdr");
  expect(screen.queryByRole("option", { name: "Control a Herdr terminal" })).toBeNull();
  expect(fetchFn.mock.calls.some(([url]) => new URL(url).pathname === "/api/terminal/herdr")).toBe(false);
});

it("drops the selected tab when the signed-in owner changes, even if the previous owner returns", async () => {
  const { client } = workspace();
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Inspect output @herdr");
  fireEvent.click(await screen.findByRole("option", { name: "Control a Herdr terminal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Build (t7)" }));
  expect(screen.getByText(/Terminal control for this message/)).toBeTruthy();
  await act(async () => useConnection.setState({ userId: "other_owner" }));
  await waitFor(() => expect(screen.queryByText(/Terminal control for this message/)).toBeNull());
  await act(async () => useConnection.setState({ userId: snapshot.chat.ownerScope.ownerId }));
  await setSharedComposerText(await screen.findByRole("textbox", { name: "Reply to chat" }), "Ordinary reply");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(snapshot.chat.id,
    expect.objectContaining({ parts: [{ type: "text", text: "Ordinary reply" }] }), { chatScope: "project" }));
});

it("a clipboard or saved draft with copied references cannot grant terminal control", () => {
  const ref = { kind: "terminal_session", id: HERDR_TERMINAL_WORKSPACE_ID + ":" + tabId, label: "Build", revision } as const;
  const command = { kind: "command", descriptorId: "herdr-terminal-control", invocation: "/herdr-terminal-control" } as const;
  const parts = canonicalChatInputParts({ text: "Read this", agentPrompt: "Read this", invocations: [command], resources: [ref] });
  expect(parts).toEqual([{ type: "text", text: "Read this" }, { type: "resource_reference", resource: ref }]);
});

it.each(["shared", "busy", "new"] as const)("does not offer control for a %s Chat", async (variant) => {
  const { client, fetchFn } = workspace("full_access", variant);
  if (variant === "shared") {
    await screen.findByText(/Shared Chat is unavailable/);
  } else {
    const editor = await screen.findByRole("textbox", { name: variant === "new" ? "Start a chat" : "Reply to chat" });
    await setSharedComposerText(editor, "@herdr");
  }
  expect(screen.queryByRole("option", { name: "Control a Herdr terminal" })).toBeNull();
  expect(fetchFn.mock.calls.some(([url]) => new URL(url).pathname === "/api/terminal/herdr")).toBe(false);
  expect(client.queueTurn).not.toHaveBeenCalled();
});
