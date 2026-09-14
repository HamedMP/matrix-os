// @vitest-environment gateway-renderer
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatEventSource } from "../../packages/ui/src/canonical-chat-event-source";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { createCodexStartupStreamHarness } from "../helpers/codex-startup-stream-harness";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders live Codex Reconnecting before prompt admission and recovers without reload", async () => {
  const h = await createCodexStartupStreamHarness();
  const source = createCanonicalChatEventSource({ openStream: h.openStream });
  const client = createCanonicalChatWorkspaceClient();
  const initial = await h.getDetail();
  vi.mocked(client.list).mockResolvedValue({ items: [initial.record] });
  vi.mocked(client.getDetail).mockResolvedValue(initial);
  client.acknowledgeCompletion = async () => (await h.getDetail()).record;
  try {
    render(<CanonicalChatWorkspace client={client} eventSource={source} catalog={h.catalog}
      projectId={null} initialChatId={h.chatId} initialView="conversation" active />);
    await act(async () => { await source.start(); });
    await waitFor(() => expect(h.frames.at(-1)?.type).toBe("chat.replay.end"));
    await screen.findByRole("log");
    await act(async () => { await h.admit(); });
    const log = within(screen.getByRole("log"));
    await waitFor(() => expect(log.getByText("Reconnecting… 1/5")).toBeTruthy(), { timeout: 4_000 });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(log.queryByRole("button", { name: /retry/i })).toBeNull();
    expect((await h.getRunner()!.requests()).some((request) => request.method === "turn/start")).toBe(false);
    await act(async () => { await h.release(); });
    await waitFor(() => expect(log.getByText("Started exactly once.")).toBeTruthy(), { timeout: 4_000 });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(log.getAllByText("Started exactly once.")).toHaveLength(1);
    expect(client.getDetail).toHaveBeenCalledTimes(1);
    expect(h.openStream).toHaveBeenCalledTimes(1);
  } finally { cleanup(); source.dispose(); await h.close(); }
}, 15_000);
