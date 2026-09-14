// @vitest-environment gateway-renderer
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatEventSource } from "../../packages/ui/src/canonical-chat-event-source";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { createClaudeSteerStreamHarness } from "../helpers/claude-steer-stream-harness";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["assistant", "result"])("renders the %s quota reset safely from live SSE without retry or reload", async (envelope) => {
  const h = await createClaudeSteerStreamHarness();
  const source = createCanonicalChatEventSource({ openStream: h.openStream });
  const client = createCanonicalChatWorkspaceClient();
  const initial = await h.getDetail();
  vi.mocked(client.list).mockResolvedValue({ items: [initial.record] });
  vi.mocked(client.getDetail).mockResolvedValue(initial);
  client.acknowledgeCompletion = async (chatId, runId) => h.repository.acknowledgeCompletion(h.owner, chatId, runId);
  try {
    render(<CanonicalChatWorkspace client={client} eventSource={source} catalog={h.catalog}
      projectId={null} initialChatId={h.chatId} initialView="conversation" active />);
    await act(async () => { await source.start(); });
    await waitFor(() => expect(h.frames.at(-1)?.type).toBe("chat.replay.end"));
    await screen.findByRole("log");
    await act(async () => { await h.admit(); });
    await waitFor(() => expect(h.children).toHaveLength(1));
    // Only the clock and external native process are controlled.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-10T08:00:00Z"));
    await act(async () => {
      const text = "You've hit your weekly limit · resets Sep 14, 1pm (UTC)";
      h.children[0]!.line(envelope === "assistant"
        ? { type: "assistant", error: "rate_limit", isApiErrorMessage: true,
            message: { role: "assistant", content: [{ type: "text", text }] } }
        : { type: "result", is_error: true, result: text });
      clock.mockRestore();
      h.children[0]!.exit(1);
      await h.orchestrator.drain();
    });
    const log = within(screen.getByRole("log"));
    const message = "Your usage limit has been reached. Try again after 2026-09-14 13:00 UTC.";
    await waitFor(() => expect(log.getAllByText(message)).toHaveLength(1));
    expect(log.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("log").textContent).not.toMatch(/Check its connection|Reconnecting|You've hit/);
    expect(client.getDetail).toHaveBeenCalledTimes(1);
    expect(h.openStream).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  } finally {
    cleanup(); source.dispose(); await h.close();
  }
}, 20_000);
