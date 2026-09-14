// @vitest-environment gateway-renderer
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import { hermesStartupStreamHarness } from "../helpers/hermes-startup-stream-harness";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders Hermes Reconnecting from HTTP before success without a failed-run flash or snapshot refresh", async () => {
  const h = await hermesStartupStreamHarness({ timeouts: 1 });
  const client = createCanonicalChatWorkspaceClient();
  const initial = await h.getDetail();
  vi.mocked(client.list).mockResolvedValue({ items: [initial.record] });
  vi.mocked(client.getDetail).mockResolvedValue(initial);
  client.acknowledgeCompletion = async () => (await h.getDetail()).record;
  try {
    render(<CanonicalChatWorkspace client={client} eventSource={h.source} catalog={h.catalog}
      projectId={null} initialChatId={h.chatId} initialView="conversation" active />);
    await act(async () => { await h.source.start(); });
    await screen.findByRole("log");
    await act(async () => { await h.admit(); });
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Reconnecting… 1/5")).toBeTruthy());
    expect(screen.queryByText(/Agent work failed|connection failed/)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(client.getDetail).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.process.requests().filter((request) => request.method === "prompt.submit")).toHaveLength(1));
    await act(async () => {
      h.process.children[1]!.event("message.complete", { text: "Startup recovered once.", status: "complete" });
      await h.orchestrator.drain();
    });
    await waitFor(() => expect(within(screen.getByRole("log")).getByText("Startup recovered once.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(client.getDetail).toHaveBeenCalledTimes(1);
  } finally { cleanup(); await h.close(); }
});
