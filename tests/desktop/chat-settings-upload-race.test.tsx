// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(["send", "queue", "edit"] as const)("preserves the draft and attachment without %s admission when Settings change during upload", async (mode) => {
  let resolveUpload!: (value: unknown) => void;
  const api = { baseUrl: "https://matrix.test", putBytes: vi.fn(() => new Promise((resolve) => { resolveUpload = resolve; })) } as never;
  const client = createCanonicalChatWorkspaceClient();
  const fixture = createCanonicalChatFixture(mode === "send" ? "completed" : "running").snapshot;
  const record = { chat: fixture.chat, projectId: "matrix-os", providerBinding: fixture.chat.providerBinding, activeRun: fixture.chat.activeRun };
  const queued = { id: "queued_test", chatId: fixture.chat.id, clientRequestId: "request_test", position: 1,
    parts: [{ type: "text" as const, text: "Existing queued draft" }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    interactionMode: "default", permissionMode: "supervised", executionRoot: { kind: "project" as const, projectId: "matrix-os" },
    createdAt: "2026-08-31T02:00:00.000Z", updatedAt: "2026-08-31T02:00:00.000Z" };
  vi.mocked(client.getDetail).mockResolvedValue({ record, messages: fixture.messages, turns: fixture.turns, runs: fixture.runs, activities: fixture.activities,
    queuedTurns: mode === "edit" ? [queued] : [] });
  render(<CanonicalChatWorkspace api={api} client={client} projectId="matrix-os" active initialChatId={fixture.chat.id} catalog={providerCatalog} />);
  const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
  if (mode === "edit") {
    fireEvent.pointerDown(await screen.findByRole("button", { name: "More actions for Existing queued draft" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit Existing queued draft" }));
  }
  await setSharedComposerText(editor, "Synthetic upload draft");
  const file = new File(["synthetic"], "notes.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.putBytes).toHaveBeenCalledTimes(1));
  act(() => useConnection.setState({ providerCatalogGeneration: 1 }));
  await act(async () => {
    const path = decodeURIComponent((vi.mocked(api.putBytes).mock.calls[0]![0] as string).split("path=")[1]!);
    resolveUpload({ ok: true, path, size: file.size });
  });
  expect(client.admitTurn).not.toHaveBeenCalled();
  expect(client.queueTurn).not.toHaveBeenCalled();
  expect(client.updateQueuedTurn).not.toHaveBeenCalled();
  expect(editor.textContent).toBe("Synthetic upload draft");
  expect(screen.getByText("notes.txt")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
});
