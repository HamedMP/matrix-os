// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  handler: null as null | ((frame: unknown) => void), event: null as null | ((event: unknown) => void),
  send: vi.fn(), close: vi.fn(), connected: true, epoch: 1, startupError: null as Error | null,
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: harness.connected, connectionEpoch: harness.epoch,
  send: harness.send, subscribe: (handler: (frame: unknown) => void) => { harness.handler = handler; return () => { harness.handler = null; }; },
}) }));
vi.mock("../../shell/src/aoede/media", () => ({ AoedeMedia: class {
  sessionId = harness.sessionId;
  constructor(options: { onEvent: (event: unknown) => void }) { harness.event = options.onEvent; }
  start = async () => { if (harness.startupError) throw harness.startupError; return this.sessionId; };
  started = vi.fn(); close = harness.close;
} }));
import { useAoedeSession } from "../../shell/src/aoede/useAoedeSession";
import { AoedeOverlay } from "../../shell/src/aoede/AoedeOverlay";
import { useVocalStore } from "../../shell/src/stores/vocal";
const card = { id: "task-1", chatId: "chat_1", runId: "run_1", title: "Update note", status: "approval" as const,
  approval: { approvalId: "approval_1", title: "Update note", description: "Add a paragraph", risk: "low" as const, allowedDecisions: ["approve_once" as const, "deny" as const] } };
const decision = { type: "aoede:approval_decide", sessionId: harness.sessionId, chatId: card.chatId, runId: card.runId,
  approvalId: card.approval.approvalId, decision: "approve_once", clientRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
function start() {
  const onUi = vi.fn(() => ({ status: "ok" as const, slug: "notes" }));
  const hook = renderHook(() => useAoedeSession(true, onUi));
  act(() => { hook.result.current.audioRef.current = {} as HTMLAudioElement; hook.result.current.start(); });
  act(() => harness.event?.({ type: "session.started" }));
  return { ...hook, onUi };
}
function emit(frame: unknown) { act(() => harness.handler?.(frame)); }
beforeEach(() => { harness.startupError = null; harness.connected = true; harness.epoch = 1; harness.send.mockClear(); harness.close.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ session: null })))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("Aoede invoking-shell authority", () => {
  it("ignores another session and duplicate UI execution, then stops on supersession", () => {
    const hook = start();
    const frame = { type: "aoede:ui", sessionId: harness.sessionId, correlationId: decision.clientRequestId, phase: "execute", action: "open_app", target: "notes" };
    emit({ ...frame, sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect(hook.onUi).not.toHaveBeenCalled();
    emit(frame); emit(frame);
    expect(hook.onUi).toHaveBeenCalledOnce();
    emit({ type: "aoede:state", sessionId: harness.sessionId, state: "superseded" });
    emit({ ...frame, correlationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    expect(harness.close).toHaveBeenCalledOnce();
    expect(hook.onUi).toHaveBeenCalledOnce();
  });
  it("submits a sole low-risk voice decision through canonical authenticated HTTP only", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === "POST"
      ? { approvalId: card.approval.approvalId, decision: "approve", submission: "accepted" } : { session: null })));
    vi.stubGlobal("fetch", fetchFn);
    start(); emit({ type: "aoede:card", sessionId: harness.sessionId, card });
    await act(async () => { harness.handler?.(decision); });
    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({ type: "aoede:approval_result", accepted: true }));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, request] = fetchFn.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/chats/chat_1/runs/run_1/approvals/approval_1");
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({ clientRequestId: `req_${decision.clientRequestId}`, decision: "approve" });
    emit(decision); expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each(["high", "medium"])("refuses %s-risk spoken approval without any HTTP submission", (risk) => {
    const fetchFn = vi.mocked(fetch);
    start(); emit({ type: "aoede:card", sessionId: harness.sessionId, card: { ...card, approval: { ...card.approval, risk } } }); emit(decision);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({ type: "aoede:approval_result", accepted: false }));
  });
  it("refuses spoken approval when two questions are currently presented", () => {
    const fetchFn = vi.mocked(fetch);
    start(); emit({ type: "aoede:card", sessionId: harness.sessionId, card });
    emit({ type: "aoede:card", sessionId: harness.sessionId, card: { ...card, id: "task-2" } }); emit(decision);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("allows a deliberate high-risk click denial but never grants session-wide permission", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === "POST"
      ? { approvalId: card.approval.approvalId, decision: "decline", submission: "accepted" } : { session: null })));
    vi.stubGlobal("fetch", fetchFn);
    const hook = start();
    const dangerous = { ...card, approval: { ...card.approval, risk: "high" as const } };
    emit({ type: "aoede:card", sessionId: harness.sessionId, card: dangerous });
    await act(async () => {
      await hook.result.current.approval(dangerous, "deny", decision.clientRequestId);
      await hook.result.current.approval(dangerous, "deny", decision.clientRequestId);
    });
    const posts = fetchFn.mock.calls.filter(([, init]) => init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1].body))).toEqual({ clientRequestId: `req_${decision.clientRequestId}`, decision: "decline" });
  });
  it("releases media on socket loss and does not automatically mint on reconnection", () => {
    const hook = start(); harness.connected = false; hook.rerender();
    expect(harness.close).toHaveBeenCalledOnce();
    harness.connected = true; harness.epoch += 1; hook.rerender();
    expect(hook.result.current.status).toBe("interrupted");
    expect(harness.send.mock.calls.filter(([frame]) => frame.type === "aoede:ready")).toHaveLength(1);
  });
  it("preserves repeated caption fragments without using them as action authority", () => {
    const hook = start();
    act(() => {
      harness.event?.({ type: "session.output_transcript.delta", delta: "ha ", start_ms: 1000, end_ms: 1100 });
      harness.event?.({ type: "session.output_transcript.delta", delta: "ha", start_ms: 1100, end_ms: 1200 });
    });
    expect(hook.result.current.captions[0].text).toBe("ha ha");
    expect(hook.onUi).not.toHaveBeenCalled();
  });
  it("keeps long captions and earlier turns available without silent truncation", () => {
    const hook = start();
    act(() => {
      for (let index = 0; index < 12; index += 1) harness.event?.({
        type: "session.output_transcript.delta", delta: "word ".repeat(500), start_ms: index * 5000, end_ms: index * 5000 + 100,
      });
    });
    expect(hook.result.current.captions).toHaveLength(12);
    expect(hook.result.current.captions.map((c) => c.text).join("")).toBe("word ".repeat(6000));
  });
  it("ends explicitly at the bounded caption limit without dropping received text", () => {
    const hook = start();
    act(() => { for (let i = 0; i < 5; i += 1) harness.event?.({ type: "session.output_transcript.delta", delta: "a".repeat(30000), start_ms: i, end_ms: i + 1 }); });
    expect(hook.result.current.status).toBe("caption_limit");
    expect(hook.result.current.captions.map((c) => c.text).join("")).toHaveLength(150000);
    expect(harness.close).toHaveBeenCalledOnce();
  });
  it("explains microphone denial with actionable permission guidance and a retry", async () => {
    harness.startupError = new DOMException("Denied", "NotAllowedError");
    render(React.createElement(AoedeOverlay, { active: true, onUi: () => ({ status: "failed" }) }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start fresh session" })); });
    expect(screen.getByText("Microphone access is blocked")).toBeTruthy();
    expect(screen.getByText(/browser’s site permissions/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start fresh session" }).hasAttribute("disabled")).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });
  it("ends capture without dismissing and retains every caption in conversation details", async () => {
    render(React.createElement(AoedeOverlay, { active: true, onUi: () => ({ status: "failed" }) }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start fresh session" })); });
    act(() => {
      harness.event?.({ type: "session.started" });
      harness.event?.({ type: "session.input_transcript.delta", delta: "Earlier words", start_ms: 1, end_ms: 2 });
      harness.event?.({ type: "session.output_transcript.delta", delta: "Latest words", start_ms: 3, end_ms: 4 });
    });
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(harness.close).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByText("Conversation & privacy"));
    expect(screen.getByRole("region", { name: "Full conversation captions" }).textContent).toContain("Earlier words");
    expect(screen.getByRole("region", { name: "Voice captions" }).textContent).toContain("Latest words");
  });
  it("unlocks a failed approval and retries the same idempotent request", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === "POST"
      ? { approvalId: card.approval.approvalId, decision: "approve", submission: "accepted" } : { session: null })));
    vi.stubGlobal("fetch", fetchFn);
    const hook = start(); emit({ type: "aoede:card", sessionId: harness.sessionId, card });
    fetchFn.mockRejectedValueOnce(new Error("Network unavailable"));
    await act(async () => { await hook.result.current.approval(card, "approve_once", decision.clientRequestId); });
    expect(hook.result.current.deciding).toEqual([]);
    expect(hook.result.current.actionError).toBe(true);
    await act(async () => { await hook.result.current.approval(card, "deny"); });
    expect(fetchFn.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    const retryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await act(async () => { await hook.result.current.approval(card, "approve_once", retryId); });
    const posts = fetchFn.mock.calls.filter(([, init]) => init.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0][1].body).toBe(posts[1][1].body);
    expect(hook.result.current.actionError).toBe(false);
    expect(harness.send).toHaveBeenCalledWith(expect.objectContaining({ type: "aoede:approval_result", clientRequestId: retryId, accepted: true }));
  });
  it("does not let an old recovery probe overwrite an explicitly ended fresh session", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const hook = start(); act(() => hook.result.current.stop("closed"));
    await act(async () => { resolve(new Response(JSON.stringify({ session: { state: "interrupted" } }))); });
    expect(hook.result.current.status).toBe("closed");
  });
  it("keeps cancellation separate from dismissing the conversation", () => {
    const hook = start(); emit({ type: "aoede:card", sessionId: harness.sessionId, card: { ...card, status: "running" } });
    act(() => hook.result.current.cancel({ ...card, status: "running" }));
    expect(harness.send).toHaveBeenCalledWith({ type: "aoede:cancel", sessionId: harness.sessionId, cardId: card.id });
    expect(harness.close).not.toHaveBeenCalled();
    act(() => hook.result.current.stop("closed"));
    expect(harness.send.mock.calls.filter(([frame]) => frame.type === "aoede:cancel")).toHaveLength(1);
  });
  it("Escape stops voice, closes the visibility store, and returns keyboard focus", async () => {
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    useVocalStore.getState().setActive(true);
    function Host() { const active = useVocalStore((s) => s.active); return React.createElement(AoedeOverlay, { active, onUi: () => ({ status: "failed" }) }); }
    render(React.createElement(Host));
    expect(screen.getByRole("dialog").className).toContain("aoede-live");
    expect(screen.getByRole("button", { name: "Close Aoede" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Voice tasks" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start fresh session" }));
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
    expect(harness.close).toHaveBeenCalledOnce();
    expect(useVocalStore.getState().active).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });
});
