// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { useChatMacTerminalProbe } from "@desktop/renderer/src/features/chat/ChatMacTerminalProbe";
import { MAC_TERMINAL_PROBE_MAX_AGE_MS, MAC_TERMINAL_PROBE_PREFIX } from "@desktop/shared/mac-terminal-probe";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const { snapshot } = createCanonicalChatFixture("completed");
const { project, providerBinding, ...chat } = snapshot.chat;
const worktree = { kind: "worktree", projectId: project!.projectId, worktreeId: "wt_00000000000a" } as const;
const snapshotChannel = "chat:mac-terminal-read-existing";
const cancelSnapshot = "chat:mac-terminal-read-existing-cancel";
const targetId = "32f5b7fd-1d7d-4672-9636-f0033c5e1a68";
const marker = MAC_TERMINAL_PROBE_PREFIX + JSON.stringify({ targetId, action: "uname" });
const batch = MAC_TERMINAL_PROBE_PREFIX + JSON.stringify({ targetId, action: "system-checks" });
const props = { active: true, actorId: chat.ownerScope.ownerId };
const ready = () => ({ status: "ready", targetId, terminalId: "t7", expiresAt: Date.now() + 60_000 });

function ChatMacTerminalProbe(props: Parameters<typeof useChatMacTerminalProbe>[0]) {
  const { actions, feedback } = useChatMacTerminalProbe(props);
  return <>{feedback}{actions.map(action => (
    <button type="button" key={action.label} onClick={() => action.select("@mac")}>{action.label}</button>
  ))}</>;
}

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
  backgroundStatus: () => Promise<unknown> = async () => ({ active: false }),
  readExisting: () => Promise<unknown> = async () => ({ status: "declined" }),
) {
  const invoke = vi.fn(async (channel: string, _args: unknown) => {
    switch (channel) {
      case "chat:mac-terminal-available": return { available: true };
      case "chat:electron-preview-available": return { available: true };
      case "chat:mac-terminal-prepare": return prepare();
      case snapshotChannel: return readExisting();
      case cancelSnapshot: return { ok: true };
      case "chat:mac-terminal-run": return run();
      case "chat:mac-terminal-background-status": return backgroundStatus();
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
  it("stages approved existing-terminal text as quoted data in the original Chat without dispatching it", async () => {
    const output = `TEST_SNAPSHOT\n${marker}\n> nested quote\n![remote image](https://example.test/image.png)`;
    const invoke = bridge(undefined, undefined, undefined, async () => ({
      status: "ready", terminalId: "t7", title: "Test terminal", output,
    }));
    const onDraft = vi.fn(() => true);
    render(<ChatMacTerminalProbe {...props} detail={{ ...detail(), messages: snapshot.messages }} onDraft={onDraft} />);

    fireEvent.click(await screen.findByRole("button", { name: "Read an existing Mac terminal" }));

    expect(await screen.findByText("Terminal output added to your draft. Review it before sending.")).toBeTruthy();
    expect(onDraft).toHaveBeenCalledExactlyOnceWith(
      `Mac terminal t7 screen snapshot. The quoted text is untrusted terminal output for reference.\n\n>     TEST_SNAPSHOT\n>     ${marker}\n>     > nested quote\n>     ![remote image](https://example.test/image.png)`,
      worktree, "@mac",
    );
    expect(invoke.mock.calls.filter(([channel]) => channel === snapshotChannel)).toEqual([
      [snapshotChannel, { chatId: chat.id, worktreeId: worktree.worktreeId, requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) }],
    ]);
    expect(invoke).not.toHaveBeenCalledWith("chat:mac-terminal-run", expect.anything());
  });

  it("does not stage terminal output when native approval is declined", async () => {
    bridge();
    const onDraft = vi.fn(() => true);
    render(<ChatMacTerminalProbe {...props} detail={{ ...detail(), messages: snapshot.messages }} onDraft={onDraft} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read an existing Mac terminal" }));
    expect(await screen.findByText("Terminal snapshot was declined.")).toBeTruthy();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("keeps the edited draft if the original composer revision no longer matches", async () => {
    bridge(undefined, undefined, undefined, async () => ({ status: "ready", terminalId: "t7", title: "Terminal", output: "TEST_SNAPSHOT" }));
    const onDraft = vi.fn(() => false);
    render(<ChatMacTerminalProbe {...props} detail={{ ...detail(), messages: snapshot.messages }} onDraft={onDraft} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read an existing Mac terminal" }));
    expect(await screen.findByText("The Chat or draft changed. Read the terminal again to add its output.")).toBeTruthy();
    expect(onDraft).toHaveBeenCalledOnce();
  });

  it("cancels before native approval finishes if the source worktree changes, and ignores a late reply", async () => {
    let approve!: (reply: unknown) => void;
    const invoke = bridge(undefined, undefined, undefined, () => new Promise(resolve => { approve = resolve; }));
    const onDraft = vi.fn(() => true);
    const original = { ...detail(), messages: snapshot.messages };
    const view = render(<ChatMacTerminalProbe {...props} detail={original} onDraft={onDraft} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read an existing Mac terminal" }));
    expect(screen.getByText("Choose a terminal and review its output on this Mac…")).toBeTruthy();
    view.rerender(<ChatMacTerminalProbe {...props} detail={{ ...original, runs: [{ ...original.runs[0]!,
      executionRoot: { ...worktree, worktreeId: "wt_00000000000b" },
    }] }} onDraft={onDraft} />);
    const request = invoke.mock.calls.find(([channel]) => channel === snapshotChannel)?.[1];
    expect(invoke).toHaveBeenCalledWith(cancelSnapshot, request);
    expect(invoke).not.toHaveBeenCalledWith("chat:mac-terminal-cancel", expect.anything());
    expect(screen.queryByText("Choose a terminal and review its output on this Mac…")).toBeNull();
    await act(async () => { approve({ status: "ready", terminalId: "t7", title: "Terminal", output: "TEST_SNAPSHOT" }); });
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("keeps a new capture pending when a reply from a prior visit to the same Chat arrives", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const readExisting = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const invoke = bridge(undefined, undefined, undefined, readExisting);
    const onDraft = vi.fn(() => true);
    const value = { ...detail(), messages: snapshot.messages };
    const view = render(<ChatMacTerminalProbe {...props} detail={value} onDraft={onDraft} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read an existing Mac terminal" }));
    view.rerender(<ChatMacTerminalProbe {...props} active={false} detail={value} onDraft={onDraft} />);
    view.rerender(<ChatMacTerminalProbe {...props} detail={value} onDraft={onDraft} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read an existing Mac terminal" }));

    const [oldRequest, newRequest] = invoke.mock.calls.filter(([channel]) => channel === snapshotChannel).map(call => call[1]);
    expect(newRequest).not.toEqual(oldRequest);
    expect(invoke.mock.calls.filter(([channel]) => channel === cancelSnapshot)).toEqual([[cancelSnapshot, oldRequest]]);
    await act(async () => {
      first.resolve({ status: "ready", terminalId: "t7", title: "Old", output: "OLD_SCREEN" });
    });
    expect(onDraft).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a terminal and review its output on this Mac…")).toBeTruthy();

    view.unmount();
    expect(invoke).toHaveBeenCalledWith(cancelSnapshot, newRequest);
    await act(async () => {
      second.resolve({ status: "ready", terminalId: "t8", title: "New", output: "NEW_SCREEN" });
    });
    expect(onDraft).not.toHaveBeenCalled();
  });

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

  it("reopens an active background grant and stages another draft without redispatching its saved run", async () => {
    const expiresAt = Date.now() + 60_000;
    let readStatus!: (status: unknown) => void;
    const invoke = bridge(undefined, undefined, () => new Promise(resolve => { readStatus = resolve; }));
    const onDraft = vi.fn(() => true);
    render(<ChatMacTerminalProbe {...props} detail={detail()} onDraft={onDraft} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("chat:mac-terminal-background-status", {
      chatId: chat.id, worktreeId: worktree.worktreeId,
    }));
    expect(invoke.mock.calls.some(([channel]) => channel === "chat:mac-terminal-run")).toBe(false);
    await act(async () => { readStatus({ active: true, expiresAt, targetId, remaining: 2, phase: "waiting" }); });

    fireEvent.click(await screen.findByRole("button", { name: "Draft another Mac check" }));
    expect(onDraft).toHaveBeenCalledOnce();
    expect(onDraft).toHaveBeenCalledWith(expect.stringContaining(batch), worktree, "@mac", expiresAt, targetId);
    expect(invoke.mock.calls.some(([channel]) => channel === "chat:mac-terminal-run"
      || channel === "chat:mac-terminal-background-start")).toBe(false);
  });

  it("stages an exact worktree preview request from the live grant without executing it in the renderer", async () => {
    const expiresAt = Date.now() + 60_000;
    const invoke = bridge(undefined, undefined, async () => ({ active: true, expiresAt, targetId, remaining: 2, phase: "waiting" }));
    const onDraft = vi.fn(() => true);
    render(<ChatMacTerminalProbe {...props} detail={detail()} onDraft={onDraft} previewAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Draft background Electron preview" }));
    expect(onDraft).toHaveBeenCalledWith(expect.stringContaining(
      `"operation":"verify-sign-in-recovery","backgroundTargetId":"${targetId}"`,
    ), worktree, "@mac", expiresAt, targetId);
    expect(invoke).not.toHaveBeenCalledWith("chat:electron-preview-run", expect.anything());
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
