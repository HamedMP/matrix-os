// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatAgentClient } from "@matrix-os/ui";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

beforeEach(() => {
  globalThis.ResizeObserver = class implements ResizeObserver { observe() {} unobserve() {} disconnect() {} };
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  useCodingAgentWorkspace.setState({ status: "ready" });
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(cleanup);

it.each([
  { sizes: [10 * 1024 * 1024], valid: true },
  { sizes: [10 * 1024 * 1024, 10 * 1024 * 1024], valid: true },
  { sizes: [10 * 1024 * 1024, 10 * 1024 * 1024, 1], valid: false },
])("checks the Bot's complete file selection before upload: $sizes", async ({ sizes, valid }) => {
  const { client, putBytes } = fixture("completed");
  fireEvent.click(await screen.findByRole("button", { name: "Attach files" }));
  const editor = screen.getByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Keep capacity draft");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: sizes.map((size, index) => new File([new Uint8Array(size)], `input-${index}.bin`, { type: "application/octet-stream" })) } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  if (valid) {
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledOnce());
    expect(putBytes).toHaveBeenCalledTimes(sizes.length);
  } else {
    expect(await screen.findByText(/Attachments must total 20 MiB/)).toBeTruthy();
    expect(putBytes).not.toHaveBeenCalled(); expect(client.admitTurn).not.toHaveBeenCalled();
    expect(editor.textContent).toBe("Keep capacity draft");
    expect(screen.getByText("input-0.bin")).toBeTruthy();
  }
});

function fixture(status: "completed" | "running", vision = true) {
  const { snapshot, providerCatalog } = createCanonicalChatFixture(status);
  const record = { chat: snapshot.chat, projectId: "matrix-os", providerBinding: snapshot.chat.providerBinding, activeRun: snapshot.chat.activeRun };
  const client = createCanonicalChatWorkspaceClient();
  vi.mocked(client.list).mockResolvedValue({ items: [record] });
  vi.mocked(client.getDetail).mockResolvedValue({ record, messages: snapshot.messages, turns: snapshot.turns, runs: snapshot.runs, activities: snapshot.activities });
  vi.mocked(client.admitTurn).mockResolvedValue({ record, message: snapshot.messages[0]!, turn: snapshot.turns[0]!, run: snapshot.runs[0]!, admission: "accepted" });
  vi.mocked(client.queueTurn).mockImplementation(async (chatId, input) => ({ queueDepth: 1, queuedTurn: {
    id: "queued_attachment01", chatId, clientRequestId: input.clientRequestId, position: 1, parts: input.parts, selection: input.selection,
    interactionMode: input.interactionMode, permissionMode: input.permissionMode, createdAt: snapshot.chat.updatedAt, updatedAt: snapshot.chat.updatedAt,
  } }));
  const catalog = vision ? { ...providerCatalog, instances: [] } : { ...providerCatalog, instances: providerCatalog.instances.map(instance => ({ ...instance,
    id: "matrix_pi_default", driverKind: "matrix_pi" as const, models: instance.models.map(model => ({ ...model, id: "text-only", supportsVision: false })) })) };
  const agent = { id: "bot_research1", name: "Research Rabbit", revision: 1, instructions: "Read submitted inputs.", description: "", archived: false,
    createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", recipeRef: { recipeId: "research", version: "1" },
    selection: vision ? { instanceId: "matrix_bot_default", model: "auto" } : { instanceId: "matrix_pi_default", model: "text-only" } };
  client.agents = { list: vi.fn(async () => ({ enabled: true, agents: [agent] })), bots: {
    directBot: vi.fn(async () => agent.id), interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: agent.id, revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })),
  } } as unknown as ChatAgentClient;
  const putBytes = vi.fn(async (url: string, file: File) => ({ ok: true, path: decodeURIComponent(url.split("path=")[1] ?? ""), size: file.size }));
  const props = { api: { putBytes, get: vi.fn(async () => catalog) } as never, client, initialChatId: snapshot.chat.id,
    initialView: "conversation" as const, active: true, catalog };
  const view = render(<CanonicalChatWorkspace {...props}/>);
  return { client, putBytes, props, view };
}

it.each(["completed", "running"] as const)("clears stale capacity feedback when the extra Bot attachment is removed: %s", async status => {
  const { client, putBytes } = fixture(status);
  await screen.findByRole("button", { name: "Attach files" });
  const editor = screen.getByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Keep my corrected capacity draft");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [
    new File([new Uint8Array(10 * 1024 * 1024)], "first.bin"),
    new File([new Uint8Array(10 * 1024 * 1024)], "second.bin"), new File(["x"], "extra.txt"),
  ] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText(/Attachments must total 20 MiB/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove extra.txt" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText("first.bin")).toBeTruthy(); expect(screen.getByText("second.bin")).toBeTruthy();
  expect(editor.textContent).toBe("Keep my corrected capacity draft");
  expect(putBytes).not.toHaveBeenCalled(); expect(client.admitTurn).not.toHaveBeenCalled(); expect(client.queueTurn).not.toHaveBeenCalled();
});

it("does not carry a rejected Bot upload error into a new conversation", async () => {
  const { client, putBytes, view, props } = fixture("completed", false);
  await screen.findByRole("button", { name: "Attach files" });
  await setSharedComposerText(screen.getByRole("textbox", { name: "Reply to chat" }), "Keep this image draft");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pixels"], "image.png", { type: "image/png" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toContain("does not support images");
  view.rerender(<CanonicalChatWorkspace {...props} initialChatId={undefined} initialView="draft"/>);
  await screen.findByRole("textbox", { name: "Start a chat" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(putBytes).not.toHaveBeenCalled(); expect(client.admitTurn).not.toHaveBeenCalled();
});

it.each(["completed", "running"] as const)("uploads native image and file inputs through the actual Automatic Bot %s composer", async status => {
  const { client, putBytes } = fixture(status);
  fireEvent.click(await screen.findByRole("button", { name: "Attach files" }));
  const editor = screen.getByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Read these submitted inputs");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pixels"], "image.png", { type: "image/png" }), new File(["marker"], "marker.txt", { type: "text/plain" })] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const transport = status === "running" ? client.queueTurn : client.admitTurn;
  await waitFor(() => expect(transport).toHaveBeenCalled());
  expect(putBytes).toHaveBeenCalledTimes(2);
  expect(vi.mocked(transport).mock.calls[0]![1]).toMatchObject({ selection: { instanceId: "matrix_bot_default", model: "auto" },
    parts: expect.arrayContaining([expect.objectContaining({ type: "attachment_reference", kind: "image", label: "image.png", ownerReference: expect.stringContaining("temporary/desktop-chat/") }),
      expect.objectContaining({ type: "attachment_reference", kind: "file", label: "marker.txt" })]) });
});

it("retains a Bot draft and image when its actual saved coordinator is text-only", async () => {
  const { client, putBytes } = fixture("completed", false);
  await screen.findByRole("button", { name: "Attach files" });
  const editor = screen.getByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Keep this draft");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["pixels"], "image.png", { type: "image/png" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toContain("does not support images");
  expect(editor.textContent).toBe("Keep this draft");
  expect(screen.getByText("image.png")).toBeTruthy();
  expect(putBytes).not.toHaveBeenCalled(); expect(client.admitTurn).not.toHaveBeenCalled();
});

it("clears the signed-in Bot composer text and attachment after Queue acknowledges the upload", async () => {
  useConnection.setState({ status: "signed-in", userId: "owner_queue_upload", handle: "queue-owner" });
  const { client } = fixture("running");
  await screen.findByRole("button", { name: "Attach files" });
  const editor = screen.getByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(editor, "Queue this uploaded marker");
  fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [new File(["marker"], "queued-marker.txt", { type: "text/plain" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.queueTurn).toHaveBeenCalledOnce());
  await waitFor(() => expect(editor.textContent).toBe(""));
  expect(screen.queryByRole("button", { name: "Remove queued-marker.txt" })).toBeNull();
});
