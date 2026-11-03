// @vitest-environment jsdom
import { act, renderHook, waitFor, render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { AppError } from "@desktop/shared/app-error";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import type { CanonicalChatInvalidation } from "@desktop/renderer/src/lib/canonical-chat-client";
import { createCanonicalChatWorkspaceClient, canonicalChatRecord, snapshot } from "./canonical-chat-workspace-test-utils";
import { providerCatalog } from "./canonical-chat-workspace-test-utils";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";

const input = { parts: [{ type: "text" as const, text: "continue once" }],
  selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "supervised" };

function committed(request: CanonicalCreateChatTurnRequest): CanonicalChatDetailResponse {
  const turn = { ...snapshot.turns[0]!, id: "cturn_receipt", chatId: snapshot.chat.id,
    clientRequestId: request.clientRequestId, inputMessageId: "msg_receipt", baseMessageSeq: canonicalChatRecord.chat.messageCount };
  const message = { ...snapshot.messages[0]!, id: "msg_receipt", chatId: snapshot.chat.id, turnId: turn.id,
    parts: request.parts, seq: canonicalChatRecord.chat.messageCount + 1 };
  const run = { ...snapshot.runs[0]!, id: "run_receipt", chatId: snapshot.chat.id, turnId: turn.id };
  return { record: { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, revision: canonicalChatRecord.chat.revision + 2 } },
    messages: [...snapshot.messages, message], turns: [...snapshot.turns, turn], runs: [...snapshot.runs, run], activities: snapshot.activities };
}

describe("canonical send admission receipts", () => {
  it("confirms a committed turn after a transport timeout without another POST", async () => {
    const client = createCanonicalChatWorkspaceClient();
    let fresh = await client.getDetail(snapshot.chat.id);
    vi.mocked(client.getDetail).mockImplementation(async () => fresh);
    vi.mocked(client.admitTurn).mockImplementation(async (_chatId, request) => {
      fresh = committed(request);
      throw new AppError("timeout");
    });
    const accepted = vi.fn();
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: "matrix-os", active: true, initialChatId: snapshot.chat.id }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    let result: unknown;
    await act(async () => { result = await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    expect(result).toMatchObject({ turn: { id: "cturn_receipt" }, admission: "already_accepted" });
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error).toBeNull();
    expect(client.admitTurn).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 408])("reuses the exact request on an explicit retry while admission remains unknown (%s)", async httpStatus => {
    const client = createCanonicalChatWorkspaceClient();
    vi.mocked(client.admitTurn).mockRejectedValue(httpStatus ? new AppError("server", { httpStatus }) : new AppError("timeout"));
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: "matrix-os", active: true, initialChatId: snapshot.chat.id }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "continue"); });
    expect(hook.result.current.error).not.toContain("could not be sent");
    await act(async () => { await hook.result.current.submitTurn(input, "continue"); });
    const calls = vi.mocked(client.admitTurn).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toEqual(calls[0]![1]);
  });

  it.each([false, true])("settles a late completed receipt once through refresh after timeout (retried=%s)", async retried => {
    const client = createCanonicalChatWorkspaceClient();
    let fresh = await client.getDetail(snapshot.chat.id);
    vi.mocked(client.getDetail).mockImplementation(async () => fresh);
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("timeout"));
    let notify!: (event: CanonicalChatInvalidation) => void;
    const eventSource = { subscribe: (listener: typeof notify) => { notify = listener; return { dispose() {} }; } };
    const accepted = vi.fn();
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: "matrix-os", active: true, initialChatId: snapshot.chat.id, eventSource }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    if (retried) await act(async () => { await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    fresh = committed(vi.mocked(client.admitTurn).mock.calls[0]![1]);
    act(() => { notify({ type: "chat.full_refresh" }); });
    await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
    act(() => { notify({ type: "chat.full_refresh" }); });
    await waitFor(() => expect(hook.result.current.error).toBeNull());
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(client.admitTurn).toHaveBeenCalledTimes(retried ? 2 : 1);
  });

  it("ignores late admission after the auth/runtime generation changes with the same client", async () => {
    const client = createCanonicalChatWorkspaceClient();
    let fail!: (error: Error) => void;
    vi.mocked(client.admitTurn).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const accepted = vi.fn();
    const hook = renderHook(({ identity }) => useCanonicalChatRouteController({ client, admissionIdentity: identity,
      projectId: "matrix-os", active: true, initialChatId: snapshot.chat.id }), { initialProps: { identity: "runtime:auth1" } });
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    let pending!: Promise<unknown>;
    act(() => { pending = hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(1));
    hook.rerender({ identity: "runtime:auth2" });
    await act(async () => { fail(new AppError("timeout")); await pending; });
    expect(accepted).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.detail?.record.chat.revision).toBe(canonicalChatRecord.chat.revision);
  });

  it("rebinds receipt authority on an explicit retry after deactivation and reactivation", async () => {
    const client = createCanonicalChatWorkspaceClient();
    let fresh = await client.getDetail(snapshot.chat.id);
    vi.mocked(client.getDetail).mockImplementation(async () => fresh);
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("timeout"));
    let notify!: (event: CanonicalChatInvalidation) => void;
    const eventSource = { subscribe: (listener: typeof notify) => { notify = listener; return { dispose() {} }; } };
    const accepted = vi.fn();
    const hook = renderHook(({ active }) => useCanonicalChatRouteController({ client, projectId: "matrix-os", active,
      initialChatId: snapshot.chat.id, eventSource }), { initialProps: { active: true } });
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    hook.rerender({ active: false }); hook.rerender({ active: true });
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    const calls = vi.mocked(client.admitTurn).mock.calls;
    expect(calls[1]![1]).toEqual(calls[0]![1]);
    fresh = committed(calls[0]![1]);
    act(() => { notify({ type: "chat.full_refresh" }); });
    await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
    expect(hook.result.current.error).toBeNull();
    expect(client.admitTurn).toHaveBeenCalledTimes(2);
  });

  it("passively confirms an unknown send on reopening the same mounted runtime without another send", async () => {
    const client = createCanonicalChatWorkspaceClient();
    let fresh = await client.getDetail(snapshot.chat.id);
    vi.mocked(client.getDetail).mockImplementation(async () => fresh);
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("timeout"));
    const accepted = vi.fn();
    const hook = renderHook(({ active }) => useCanonicalChatRouteController({ client, admissionIdentity: "runtime:auth1",
      projectId: "matrix-os", active, initialChatId: snapshot.chat.id }), { initialProps: { active: true } });
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    hook.rerender({ active: false });
    fresh = committed(vi.mocked(client.admitTurn).mock.calls[0]![1]);
    expect(accepted).not.toHaveBeenCalled();
    hook.rerender({ active: true });
    await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
    expect(hook.result.current.error).toBeNull();
    expect(client.admitTurn).toHaveBeenCalledTimes(1);
    expect(client.create).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("keeps a different route selected when reopening after a hidden chat change", async () => {
    const client = createCanonicalChatWorkspaceClient();
    let original = await client.getDetail(snapshot.chat.id);
    const otherId = "chat_other_route";
    const other = { ...original, record: { ...original.record, chat: { ...original.record.chat, id: otherId } },
      messages: [], turns: [], runs: [], activities: [] };
    vi.mocked(client.list).mockResolvedValue({ items: [canonicalChatRecord, other.record] });
    vi.mocked(client.getDetail).mockImplementation(async id => id === otherId ? other : original);
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("timeout"));
    const accepted = vi.fn();
    const hook = renderHook(({ active, chatId }) => useCanonicalChatRouteController({ client,
      admissionIdentity: "runtime:auth1", projectId: "matrix-os", active, initialChatId: chatId }),
      { initialProps: { active: true, chatId: snapshot.chat.id } });
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    hook.rerender({ active: false, chatId: snapshot.chat.id });
    hook.rerender({ active: false, chatId: otherId });
    original = committed(vi.mocked(client.admitTurn).mock.calls[0]![1]);
    hook.rerender({ active: true, chatId: otherId });
    await waitFor(() => expect(hook.result.current.detail?.record.chat.id).toBe(otherId));
    expect(hook.result.current.activeChatId).toBe(otherId);
    expect(client.admitTurn).toHaveBeenCalledTimes(1);
    expect(client.create).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("preserves local format validation before creating or sending anything", async () => {
    const client = createCanonicalChatWorkspaceClient();
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: "matrix-os", active: true, initialChatId: snapshot.chat.id }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn({ ...input, parts: [] }, "invalid"); });
    expect(hook.result.current.error).toContain("do not match the supported format");
    expect(client.admitTurn).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });

  it("acknowledges a known accepted original draft while its tab is hidden on the same runtime", async () => {
    const client = createCanonicalChatWorkspaceClient();
    let deliver!: (value: Awaited<ReturnType<typeof client.admitTurn>>) => void;
    vi.mocked(client.admitTurn).mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const accepted = vi.fn();
    const hook = renderHook(({ active }) => useCanonicalChatRouteController({ client, projectId: "matrix-os", active,
      initialChatId: snapshot.chat.id }), { initialProps: { active: true } });
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    let pending!: Promise<unknown>;
    act(() => { pending = hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(1));
    const receipt = committed(vi.mocked(client.admitTurn).mock.calls[0]![1]);
    hook.rerender({ active: false });
    await act(async () => { deliver({ record: receipt.record, message: receipt.messages.at(-1)!,
      turn: receipt.turns.at(-1)!, run: receipt.runs.at(-1)!, admission: "accepted" }); await pending; });
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error).toBeNull();
  });

  it("retains the created chat and exact first-turn body during an explicit new-chat retry", async () => {
    const client = createCanonicalChatWorkspaceClient();
    vi.mocked(client.list).mockResolvedValue({ items: [] });
    vi.mocked(client.create).mockResolvedValue(canonicalChatRecord);
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("timeout"));
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: "matrix-os", active: true, autoSelectFirst: false }));
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    await act(async () => { await hook.result.current.submitTurn(input, "new chat"); });
    await act(async () => { await hook.result.current.submitTurn(input, "new chat"); });
    expect(client.create).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(client.admitTurn).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toEqual(calls[0]![1]);
  });

  it("keeps definitive HTTP rejection feedback and does not acknowledge it", async () => {
    const client = createCanonicalChatWorkspaceClient();
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("unauthorized", { httpStatus: 403 }));
    const accepted = vi.fn();
    const hook = renderHook(() => useCanonicalChatRouteController({ client, projectId: "matrix-os", active: true, initialChatId: snapshot.chat.id }));
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "continue", "matrix-os", accepted); });
    expect(hook.result.current.error).toContain("Your session has expired");
    expect(accepted).not.toHaveBeenCalled();
    expect(client.admitTurn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not clear a newer definitive error when an older unknown attempt is confirmed (reopen=%s)", async reopen => {
    const client = createCanonicalChatWorkspaceClient();
    let fresh = await client.getDetail(snapshot.chat.id);
    vi.mocked(client.getDetail).mockImplementation(async () => fresh);
    vi.mocked(client.admitTurn).mockRejectedValueOnce(new AppError("timeout"))
      .mockRejectedValueOnce(new AppError("unauthorized", { httpStatus: 403 }));
    let notify!: (event: CanonicalChatInvalidation) => void;
    const eventSource = { subscribe: (listener: typeof notify) => { notify = listener; return { dispose() {} }; } };
    const accepted = vi.fn();
    const hook = renderHook(({ active }) => useCanonicalChatRouteController({ client, projectId: "matrix-os", active, initialChatId: snapshot.chat.id, eventSource }), { initialProps: { active: true } });
    await waitFor(() => expect(hook.result.current.detail).not.toBeNull());
    await act(async () => { await hook.result.current.submitTurn(input, "first", "matrix-os", accepted); });
    await act(async () => { await hook.result.current.submitTurn({ ...input, parts: [{ type: "text", text: "new draft" }] }, "second"); });
    if (reopen) hook.rerender({ active: false });
    fresh = committed(vi.mocked(client.admitTurn).mock.calls[0]![1]);
    if (reopen) hook.rerender({ active: true });
    else act(() => { notify({ type: "chat.full_refresh" }); });
    await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
    expect(hook.result.current.error).toContain("Your session has expired");
    expect(client.admitTurn).toHaveBeenCalledTimes(2);
  });

  it("retains an unchanged new-chat request after more than thirty minutes of unknown admission", async () => {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
    const client = createCanonicalChatWorkspaceClient();
    vi.mocked(client.list).mockResolvedValue({ items: [] });
    vi.mocked(client.create).mockResolvedValue(canonicalChatRecord);
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("timeout"));
    const now = Date.now();
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialView="conversation"
        active catalog={providerCatalog} />);
      const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
      await setSharedComposerText(editor, "continue once");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByText("Message status is unconfirmed. You can retry safely.");
      clock = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(client.admitTurn).toHaveBeenCalledTimes(2));
      await screen.findByText("Message status is unconfirmed. You can retry safely.");
      expect(client.create).toHaveBeenCalledTimes(1);
      const calls = vi.mocked(client.admitTurn).mock.calls;
      expect(calls[1]![1]).toEqual(calls[0]![1]);
      expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe("continue once");
    } finally { clock?.mockRestore(); cleanup(); }
  });

  it("does not clear an edited Electron draft when its original timed-out message is later confirmed", async () => {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
    const client = createCanonicalChatWorkspaceClient();
    let fresh = await client.getDetail(snapshot.chat.id);
    vi.mocked(client.getDetail).mockImplementation(async () => fresh);
    vi.mocked(client.admitTurn).mockRejectedValue(new AppError("timeout"));
    const listeners: Array<(event: CanonicalChatInvalidation) => void> = [];
    const eventSource = { subscribe: (listener: (event: CanonicalChatInvalidation) => void) => {
      if (listeners.length >= 16) throw new Error("Test listener capacity exceeded");
      listeners.push(listener); return { dispose() { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } };
    } };
    const notify = (event: CanonicalChatInvalidation) => { for (const listener of [...listeners]) listener(event); };
    try {
      const view = render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
        initialView="conversation" active catalog={providerCatalog} eventSource={eventSource} />);
      const editor = await screen.findByRole("textbox", { name: "Reply to chat" });
      await setSharedComposerText(editor, "continue once");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByText("Message status is unconfirmed. You can retry safely.");
      await setSharedComposerText(editor, "my newer unsent draft");
      view.rerender(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
        initialView="conversation" active={false} catalog={providerCatalog} eventSource={eventSource} />);
      fresh = committed(vi.mocked(client.admitTurn).mock.calls[0]![1]);
      view.rerender(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
        initialView="conversation" active catalog={providerCatalog} eventSource={eventSource} />);
      await waitFor(() => expect(screen.queryByText("Message status is unconfirmed. You can retry safely.")).toBeNull());
      expect(screen.getByRole("textbox", { name: "Reply to chat" }).textContent).toBe("my newer unsent draft");
      expect(client.admitTurn).toHaveBeenCalledTimes(1);
    } finally { cleanup(); }
  });
});
