// @vitest-environment gateway-renderer
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatEventSource } from "../../packages/ui/src/canonical-chat-event-source";
import { createCanonicalChatWorkspaceClient } from "./canonical-chat-workspace-test-utils";
import {
  AFTER_STEER,
  BEFORE_STEER,
  FINAL_TEXT,
  STEER_REQUEST,
  contentFrames,
  createClaudeSteerStreamHarness,
} from "../helpers/claude-steer-stream-harness";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  useBoard.setState(useBoard.getInitialState(), true);
  useConnection.setState(useConnection.getInitialState(), true);
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders real Claude post-Steer HTTP events in the Electron transcript before completion without reloading", async () => {
  const h = await createClaudeSteerStreamHarness();
  const source = createCanonicalChatEventSource({ openStream: h.openStream });
  const client = createCanonicalChatWorkspaceClient();
  const initial = await h.getDetail();
  // A frozen initial snapshot makes HTTP content delivery necessary for progress.
  vi.mocked(client.list).mockResolvedValue({ items: [initial.record] });
  vi.mocked(client.getDetail).mockResolvedValue(initial);
  // Completion acknowledgement is not part of this streaming seam. Avoid its
  // separate user-state invalidation triggering an unrelated detail refresh.
  client.acknowledgeCompletion = async () => (await h.getDetail()).record;
  try {
    render(<CanonicalChatWorkspace client={client} eventSource={source} catalog={h.catalog}
      projectId={null} initialChatId={h.chatId} initialView="conversation" active />);
    await act(async () => { await source.start(); });
    await waitFor(() => expect(h.frames.at(-1)?.type).toBe("chat.replay.end"));
    await screen.findByRole("log");
    let admitted!: Awaited<ReturnType<typeof h.admit>>;
    await act(async () => { admitted = await h.admit(); });
    await waitFor(() => expect(h.children).toHaveLength(1));
    await act(async () => h.children[0]!.text(BEFORE_STEER));
    await waitFor(() => expect(within(screen.getByRole("log")).getByText(BEFORE_STEER)).toBeTruthy());
    expect(h.children[0]!.exited).toBe(false);

    // This is an ingestion test: exercise public Steer, not a fabricated UI button.
    await act(async () => {
      expect(await h.steer(admitted.run.id, admitted.turn.id)).toMatchObject({ steering: "accepted" });
    });
    await waitFor(() => expect(h.children).toHaveLength(2));
    const resumed = h.children[1]!;
    await act(async () => { resumed.text(AFTER_STEER, true); resumed.tool(); });
    await waitFor(() => {
      const log = within(screen.getByRole("log"));
      expect(log.getByText(AFTER_STEER)).toBeTruthy();
      expect(log.getByText("src/streaming.ts")).toBeTruthy();
    });
    const log = within(screen.getByRole("log"));
    expect(log.getByText(STEER_REQUEST)).toBeTruthy();
    expect(log.queryByText(FINAL_TEXT)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(resumed.resultReleased).toBe(false);
    expect(resumed.exited).toBe(false);
    expect(client.getDetail).toHaveBeenCalledTimes(1);
    expect(h.openStream).toHaveBeenCalledTimes(1);
    expect(log.getAllByText(AFTER_STEER)).toHaveLength(1);
    const transcript = screen.getByRole("log").textContent!;
    expect(transcript.indexOf(BEFORE_STEER)).toBeLessThan(transcript.indexOf(STEER_REQUEST));
    expect(transcript.indexOf(STEER_REQUEST)).toBeLessThan(transcript.indexOf(AFTER_STEER));

    await act(async () => { resumed.finish(); await h.orchestrator.drain(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    // Completed intermediate work is intentionally collapsed into its receipt.
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain(FINAL_TEXT));
    expect(screen.getByRole("log").textContent!.split(FINAL_TEXT)).toHaveLength(2);
    const persisted = await h.getDetail();
    expect(persisted.messages.flatMap((message) => message.parts)
      .some((part) => part.type === "text" && part.text === FINAL_TEXT)).toBe(true);
    expect(contentFrames(h.frames).some((frame) => (
      frame.content.messages?.some((message) => message.parts
        .some((part) => part.type === "text" && part.text === FINAL_TEXT))
    ))).toBe(true);
    expect(client.getDetail).toHaveBeenCalledTimes(1);
  } finally {
    cleanup(); source.dispose(); await h.close();
  }
}, 20_000);
