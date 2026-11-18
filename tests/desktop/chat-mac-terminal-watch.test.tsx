// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React, { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { ChatWorktreeActions } from "@desktop/renderer/src/features/chat/ChatWorktreeActions";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const start = "chat:mac-terminal-watch-start";
const read = "chat:mac-terminal-watch-read";
const stop = "chat:mac-terminal-watch-stop";
const watchId = "32f5b7fd-1d7d-4672-9636-f0033c5e1a68";
const { snapshot } = createCanonicalChatFixture("completed");
const { project, providerBinding, ...chat } = snapshot.chat;
const target = { chatId: chat.id, worktreeId: "wt_00000000000a" };
const ref = { ...target, watchId };
const requestId = expect.stringMatching(/^[a-f0-9-]{36}$/);
const worktree = { kind: "worktree", projectId: project!.projectId, worktreeId: target.worktreeId } as const;
const detail: CanonicalChatDetailResponse = {
  record: { chat, projectId: worktree.projectId, providerBinding },
  runs: [{ ...snapshot.runs[0]!, executionRoot: worktree }],
  messages: snapshot.messages,
  turns: snapshot.turns,
  activities: [],
};

function ready(leaseMs = 60_000) {
  return { status: "ready", watchId, terminalId: "t7", title: "Worktree tests", expiresAt: Date.now() + leaseMs,
    output: "CURRENT_SCREEN" };
}

function bridge(options: Partial<Record<typeof start | typeof read | typeof stop, () => Promise<unknown>>> = {}) {
  const invoke = vi.fn(async (channel: string, _request: unknown) => {
    switch (channel) {
      case "chat:mac-terminal-available": return { available: true };
      case "chat:electron-preview-available": return { available: false };
      case "chat:mac-terminal-background-status": return { active: false };
      case start: return options[start] ? options[start]() : ready();
      case read: return options[read] ? options[read]() : { status: "ready", output: "NEW_SCREEN <script>" };
      case stop: return options[stop] ? options[stop]() : { ok: true };
      default: throw new Error(`Unexpected bridge request: ${channel}`);
    }
  });
  vi.stubGlobal("operator", { invoke });
  return invoke;
}

function Harness({ active = true, onDraft, value = detail }: {
  active?: boolean;
  onDraft?: () => boolean;
  value?: CanonicalChatDetailResponse;
}) {
  return (
    <ChatWorktreeActions active={active} actorId={chat.ownerScope.ownerId} detail={value}
      onDraft={onDraft} onDiscardDraft={() => undefined}>
      {actions => actions.map(action => (
        <button type="button" key={action.label} onClick={() => action.select("@mac")}>{action.label}</button>
      ))}
    </ChatWorktreeActions>
  );
}

function output() {
  return screen.queryByRole("region", { name: "Mac terminal output" });
}

function clickWatch() {
  fireEvent.click(screen.getByRole("button", { name: "Watch an existing Mac terminal" }));
}

async function flush() {
  await act(async () => {});
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watch an existing Mac terminal", () => {
  it("shows only the latest approved screen as local text in the originating Chat", async () => {
    const invoke = bridge();
    const onDraft = vi.fn(() => true);
    render(<StrictMode><Harness onDraft={onDraft} /></StrictMode>);
    await flush();
    expect(output()).toBeNull();

    clickWatch();
    await flush();
    expect(invoke).toHaveBeenCalledWith(start, { ...target, requestId });
    expect(within(output()!).getByText("CURRENT_SCREEN")).toBeTruthy();
    expect(within(output()!).getByText("Worktree tests")).toBeTruthy();
    await advance(2_000);
    expect(invoke.mock.calls.filter(([channel]) => channel === read)).toEqual([[read, ref]]);
    expect(within(output()!).getByText("NEW_SCREEN <script>")).toBeTruthy();
    expect(output()!.querySelector("script")).toBeNull();
    expect(screen.queryByText("CURRENT_SCREEN")).toBeNull();
    expect(onDraft).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([channel]) => channel === "chat:mac-terminal-run")).toBe(false);
  });

  it("shows a cleared screen without ending the watch", async () => {
    const invoke = bridge({ [read]: async () => ({ status: "ready", output: "" }) });
    render(<Harness />);
    await flush();
    clickWatch();
    await flush();
    await advance(2_000);
    expect(within(output()!).getByText("The terminal screen is empty.")).toBeTruthy();
    expect(screen.queryByText("CURRENT_SCREEN")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(stop, ref);
  });

  it("clears the screen and ignores a pending read immediately on Stop", async () => {
    const pendingRead = Promise.withResolvers<unknown>();
    const invoke = bridge({ [read]: () => pendingRead.promise });
    render(<Harness />);
    await flush();
    clickWatch();
    await flush();
    await advance(2_000);
    expect(invoke.mock.calls.filter(([channel]) => channel === read)).toEqual([[read, ref]]);

    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    expect(output()).toBeNull();
    await act(async () => { pendingRead.resolve({ status: "ready", output: "LATE_SCREEN" }); });
    await advance(4_000);
    expect(output()).toBeNull();
    expect(invoke.mock.calls.filter(([channel]) => channel === read)).toEqual([[read, ref]]);
    expect(invoke).toHaveBeenCalledWith(stop, ref);
    expect(screen.getByText("Mac terminal watch stopped.")).toBeTruthy();
  });

  it("reports when the native watch had already ended by the time Stop was pressed", async () => {
    bridge({ [stop]: async () => ({ ok: false }) });
    render(<Harness />);
    await flush();
    clickWatch();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    await flush();

    expect(output()).toBeNull();
    expect(screen.getByText("Mac terminal watch already ended.")).toBeTruthy();
  });

  it("discards a Stop reply from an earlier visit to the same Chat", async () => {
    const pendingStop = Promise.withResolvers<unknown>();
    bridge({ [stop]: () => pendingStop.promise });
    const view = render(<Harness />);
    await flush();
    clickWatch();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));

    view.rerender(<Harness active={false} />);
    view.rerender(<Harness />);
    await act(async () => { pendingStop.resolve({ ok: true }); });

    expect(output()).toBeNull();
    expect(screen.queryByText("Mac terminal watch stopped.")).toBeNull();
  });

  it("cancels before Start replies when the original worktree changes and discards a late grant", async () => {
    const pendingStart = Promise.withResolvers<unknown>();
    const invoke = bridge({ [start]: () => pendingStart.promise });
    const view = render(<Harness />);
    await flush();
    clickWatch();
    const changed = { ...detail, runs: [{ ...detail.runs[0]!,
      executionRoot: { ...worktree, worktreeId: "wt_00000000000b" },
    }] };
    view.rerender(<Harness value={changed} />);
    const originalRequest = invoke.mock.calls.find(([channel]) => channel === start)?.[1];
    expect(originalRequest).toEqual({ ...target, requestId });
    expect(invoke).toHaveBeenCalledWith(stop, originalRequest);
    await act(async () => { pendingStart.resolve(ready()); });

    expect(invoke).toHaveBeenCalledWith(stop, ref);
    expect(output()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(read, expect.anything());
  });

  it("clears an ended stream and needs a new approval after the Chat reopens", async () => {
    const invoke = bridge({ [read]: async () => ({ status: "ended" }) });
    const view = render(<Harness />);
    await flush();
    clickWatch();
    await flush();
    await advance(2_000);
    expect(output()).toBeNull();
    expect(screen.getByText("Mac terminal watch ended. Choose a terminal to watch again.")).toBeTruthy();

    view.rerender(<Harness active={false} />);
    view.rerender(<Harness />);
    await advance(4_000);
    expect(output()).toBeNull();
    expect(invoke.mock.calls.filter(([channel]) => channel === start)).toEqual([[start, { ...target, requestId }]]);
  });

  it("stops on Chat close and clears an expired screen even if its next poll has not settled", async () => {
    const pendingRead = Promise.withResolvers<unknown>();
    const invoke = bridge({ [start]: async () => ready(3_000), [read]: () => pendingRead.promise });
    const view = render(<Harness />);
    await flush();
    clickWatch();
    await flush();
    expect(output()).toBeTruthy();
    await advance(3_000);
    expect(output()).toBeNull();
    expect(invoke).toHaveBeenCalledWith(stop, ref);

    clickWatch();
    await flush();
    view.unmount();
    await act(async () => { pendingRead.resolve({ status: "ready", output: "LATE_SCREEN" }); });
    expect(invoke.mock.calls.filter(([channel]) => channel === stop)).toEqual([[stop, ref], [stop, ref]]);
  });
});
