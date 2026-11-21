// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { ChatMacTerminalProbe } from "@desktop/renderer/src/features/chat/ChatMacTerminalProbe";
import { MAC_TERMINAL_PROBE_MAX_AGE_MS, MAC_TERMINAL_PROBE_PREFIX } from "@desktop/shared/mac-terminal-probe";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const { snapshot } = createCanonicalChatFixture("completed");
const { project, providerBinding, ...chat } = snapshot.chat;
const worktree = { kind: "worktree", projectId: project!.projectId, worktreeId: "wt_00000000000a" } as const;
const targetId = "32f5b7fd-1d7d-4672-9636-f0033c5e1a68";
const marker = MAC_TERMINAL_PROBE_PREFIX + JSON.stringify({ targetId, action: "uname" });
const props = { active: true, actorId: chat.ownerScope.ownerId };
const ready = () => ({ status: "ready", targetId, terminalId: "t7", expiresAt: Date.now() + 60_000 });

function detail(): CanonicalChatDetailResponse {
  const run = { ...snapshot.runs[0]!, executionRoot: worktree, completedAt: new Date().toISOString() };
  return {
    record: { chat, projectId: project?.projectId, providerBinding },
    runs: [run],
    messages: [...snapshot.messages, {
      id: "msg_mac_terminal_check",
      chatId: chat.id,
      role: "assistant",
      state: "committed",
      seq: 8,
      runId: run.id,
      turnId: run.turnId,
      createdAt: run.completedAt,
      parts: [{ type: "text", text: marker }],
    }],
    turns: snapshot.turns,
    activities: [],
  };
}

function bridge(
  prepare: () => Promise<unknown> = async () => ready(),
  run: () => Promise<unknown> = async () => ({ status: "returned" }),
) {
  const invoke = vi.fn(async (channel: string, _args: unknown) => {
    switch (channel) {
      case "chat:mac-terminal-available": return { available: true };
      case "chat:mac-terminal-prepare": return prepare();
      case "chat:mac-terminal-run": return run();
      case "chat:mac-terminal-cancel": return { ok: true };
      default: throw new Error("Unexpected bridge request");
    }
  });
  vi.stubGlobal("operator", { invoke });
  return invoke;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Mac terminal check", () => {
  it("routes an already committed matching marker to Main for grant verification once under StrictMode", async () => {
    const invoke = bridge();
    const view = render(<StrictMode><ChatMacTerminalProbe {...props} detail={detail()} /></StrictMode>);
    expect(await screen.findByText("Mac terminal result returned to this Chat.")).toBeTruthy();
    view.rerender(<StrictMode><ChatMacTerminalProbe {...props} detail={detail()} /></StrictMode>);
    expect(invoke.mock.calls.filter(([channel]) => channel === "chat:mac-terminal-run")).toEqual([
      ["chat:mac-terminal-run", { chatId: chat.id, runId: snapshot.runs[0]!.id }],
    ]);
    expect(invoke.mock.calls.some(([channel]) => channel === "chat:mac-terminal-prepare")).toBe(false);
  });

  it("keeps the successful status when the returned result starts a new Chat turn", async () => {
    let returnResult!: (reply: { status: "returned" }) => void;
    const invoke = bridge(undefined, () => new Promise(resolve => { returnResult = resolve; }));
    const first = detail();
    const view = render(<ChatMacTerminalProbe {...props} detail={first} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat:mac-terminal-run", {
      chatId: chat.id,
      runId: first.runs[0]!.id,
    }));
    const followup = { ...first.runs[0]!, id: "run_return", status: "running" as const };
    view.rerender(<ChatMacTerminalProbe {...props} detail={{
      ...first,
      record: { ...first.record, activeRun: followup },
    }} />);
    await act(async () => { returnResult({ status: "returned" }); });
    expect(screen.getByText("Mac terminal result returned to this Chat.")).toBeTruthy();
  });

  it.each(["owner", "incomplete", "expired", "non-agent", "other-worktree"] as const)(
    "does not route a marker that fails the visible Chat scope (%s)", async reason => {
      const invoke = bridge();
      const chatDetail = detail();
      const run = chatDetail.runs[0]!;
      if (reason === "incomplete") run.status = "running";
      if (reason === "expired") run.completedAt = new Date(Date.now() - MAC_TERMINAL_PROBE_MAX_AGE_MS).toISOString();
      if (reason === "non-agent") chatDetail.messages.at(-1)!.role = "user";
      if (reason === "other-worktree") chatDetail.runs.push({ ...run, id: "run_later", status: "failed",
        executionRoot: { ...worktree, worktreeId: "wt_00000000000b" } });
      render(<ChatMacTerminalProbe {...props} actorId={reason === "owner" ? "user_other" : props.actorId}
        detail={chatDetail} onDraft={vi.fn()} />);
      if (reason !== "owner") await screen.findByRole("button", { name: "Request Mac terminal check" });
      expect(invoke.mock.calls.some(([channel]) => channel === "chat:mac-terminal-run")).toBe(false);
    },
  );

  it("cancels a reservation if the Chat stops accepting its draft while native approval is pending", async () => {
    let finishApproval!: (reply: ReturnType<typeof ready>) => void;
    const invoke = bridge(() => new Promise(resolve => { finishApproval = resolve; }));
    const onDraft = vi.fn(() => true);
    const chatDetail = { ...detail(), messages: snapshot.messages };
    const view = render(<ChatMacTerminalProbe {...props} detail={chatDetail} onDraft={onDraft} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request Mac terminal check" }));
    view.rerender(<ChatMacTerminalProbe {...props} detail={chatDetail} />);
    await act(async () => { finishApproval(ready()); });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat:mac-terminal-cancel", { chatId: chat.id }));
    expect(onDraft).not.toHaveBeenCalled();
  });
});
