import { describe, expect, it, vi } from "vitest";
import { createAoedeController } from "../../packages/ui/src/aoede/controller.js";
import { createAoedeApi, AoedeRequestError, type AoedeApi } from "../../packages/ui/src/aoede/client.js";
import type { AoedeBootstrapResponse } from "../../packages/contracts/src/aoede.js";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat.js";
import type { VoiceSessionClient } from "../../packages/ui/src/voice-session/client-types.js";

const binding: AoedeBootstrapResponse = { chatId: "chat_aoede", scope: { kind: "workspace", id: "main", label: "Workspace" }, selection: { instanceId: "pi_main", model: "test:model" }, capability: { contractVersion: 1, surface: "web_canvas", status: "available", transportModes: ["relayed_websocket"], turnModes: ["hands_free", "push_to_talk"], supportsInterruption: true, resume: "delivery_aware", sessionOnly: "unsupported", actionMode: "canonical_actions", actionCancellation: "run", supportsInputSelection: false, supportsOutputSelection: false } };
const detail: CanonicalChatDetailResponse = { record: { chat: { id: "chat_aoede", revision: 0, ownerScope: { type: "personal", ownerId: "owner_test" }, title: "Aoede", lifecycle: "active", attention: "none", messageCount: 0, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" } }, messages: [], turns: [], runs: [], activities: [] };
function harness(bootstrap = vi.fn(async () => binding), initialDetail = detail, extra: Partial<import("../../packages/ui/src/aoede/controller.js").AoedeOwnerOptions> = {}) {
  const source = { subscribe: vi.fn((_listener: (event: import("../../packages/ui/src/canonical-chat-event-source.js").CanonicalChatInvalidation) => void) => ({ dispose: vi.fn() })), start: vi.fn(async () => {}), dispose: vi.fn() };
  const detailFn = vi.fn(async () => initialDetail);
  const cancelRun = vi.fn(async () => ({})); const submitInput = vi.fn(async () => ({})); const submitApproval = vi.fn(async () => ({}));
  const providers = vi.fn(async () => catalog); const updateSelection = vi.fn(async () => detail.record); const cancelAction = vi.fn(async () => ({ operation: operationView, cancellation: "cancelled" as const }));
  const api = { bootstrap, detail: detailFn, events: () => source, cancelRun, submitInput, submitApproval, providers, updateSelection, cancelAction } as unknown as AoedeApi;
  let mediaListener: (() => void) | undefined;
  const media = { subscribe: vi.fn((listener: () => void) => { mediaListener = listener; return () => {}; }),
    getSnapshot: vi.fn(() => ({ phase: "idle" as const, voice: null, error: null, notice: null, chatId: null, sessionId: null, reconnectStatus: null })),
    startVoice: vi.fn(async () => {}), end: vi.fn(async () => {}), dispose: vi.fn(), controller: () => null, retry: vi.fn(),
    listDevices: vi.fn(async () => devices), setInputDevice: vi.fn(async () => true), setOutputDevice: vi.fn(async () => "applied" as const) } as unknown as VoiceSessionClient;
  const factory = vi.fn(() => media);
  const controller = createAoedeController({ identityKey: "owner/runtime", baseUrl: "https://runtime.test", surface: "web_canvas", ...extra }, { api, voiceFactory: factory });
  return { controller, api, media, factory, bootstrap, source, detailFn, cancelRun, submitInput, submitApproval, providers, updateSelection, cancelAction, notifyMedia: () => mediaListener?.() };
}
const catalog = createCanonicalProviderCatalogFixture();
const devices = [{ deviceId: "mic_usb", kind: "audioinput" as const, label: "USB Mic" }, { deviceId: "spk_hdmi", kind: "audiooutput" as const, label: "HDMI" }];
const operationView = { id: "action_timer", chatId: "chat_aoede", runId: "run_op", toolId: "tool_timer", schemaRevision: "s1", policyRevision: "p1", state: "authorized" as const, argumentDigest: "a".repeat(64), cancellationRequested: false, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function runningDetail(): CanonicalChatDetailResponse {
  const fixture = createCanonicalChatFixture("running").snapshot;
  const run = { ...fixture.runs[0]!, chatId: binding.chatId, capabilitySnapshot: { ...fixture.runs[0]!.capabilitySnapshot, cancellation: "run" as const } };
  return { ...detail, record: { ...detail.record, activeRun: { runId: run.id, turnId: run.turnId, status: "running" } }, runs: [run],
    turns: fixture.turns.map(item => ({ ...item, chatId: binding.chatId })), messages: fixture.messages.map(item => ({ ...item, chatId: binding.chatId })), activities: [] };
}
it("canonical whole-run cancellation is separate from Stop speaking and media End", async () => {
  const initial = runningDetail(); const h = harness(undefined, initial); await h.controller.open();
  expect(h.controller.getSnapshot().canonical.canCancel).toBe(true); await h.controller.cancelGeneration();
  expect(h.cancelRun).toHaveBeenCalledWith(binding.chatId, initial.runs[0].id, expect.objectContaining({ clientRequestId: expect.stringMatching(/^req_/) }));
  expect(h.media.end).not.toHaveBeenCalled(); h.controller.stopSpeaking(); expect(h.cancelRun).toHaveBeenCalledTimes(1); await h.controller.end(); expect(h.cancelRun).toHaveBeenCalledTimes(1); h.controller.dispose();
});
it("approval argument mutation fences stale cards and conflict refreshes canonical state", async () => {
  const initial = runningDetail(); const runId = initial.runs[0].id;
  const activity = { id: "activity_approval", chatId: binding.chatId, runId, occurredAt: detail.record.chat.createdAt, type: "approval.requested" as const, approvalId: "approval_timer", title: "Create timer", safeDescription: "Create a timer app", risk: "low" as const, allowedDecisions: ["approve" as const, "decline" as const], argumentDigest: "a".repeat(64) };
  initial.activities = [activity]; const h = harness(undefined, initial); await h.controller.open(); const stale = h.controller.getSnapshot().canonical.approvals[0];
  h.detailFn.mockResolvedValue({ ...initial, record: { ...initial.record, chat: { ...initial.record.chat, revision: 1 } }, activities: [{ ...activity, argumentDigest: "b".repeat(64) }] }); await h.controller.refresh();
  expect(await h.controller.submitApproval(stale, "approve")).toBe(false); expect(h.submitApproval).not.toHaveBeenCalled();
  const live = h.controller.getSnapshot().canonical.approvals[0]; await h.controller.submitApproval(live, "approve");
  expect(h.submitApproval).toHaveBeenCalledWith(binding.chatId, runId, "approval_timer", expect.objectContaining({ argumentDigest: "b".repeat(64), decision: "approve" }));
  h.submitApproval.mockRejectedValueOnce(new AoedeRequestError(409)); const before = h.detailFn.mock.calls.length; await h.controller.submitApproval(live, "decline"); expect(h.detailFn.mock.calls.length).toBeGreaterThan(before); h.controller.dispose();
});
it("clarification submits the exact canonical run/request and fences changed questions", async () => {
  const initial = runningDetail(); const runId = initial.runs[0].id;
  initial.activities = [{ id: "activity_input", chatId: binding.chatId, runId, occurredAt: detail.record.chat.createdAt, type: "input.requested", requestId: "input_name", title: "Name the app", questions: [{ questionId: "q_name", question: "App name", multiSelect: false, allowOther: true }] }];
  const h = harness(undefined, initial); await h.controller.open(); const view = h.controller.getSnapshot().canonical.inputs[0];
  const answer = { structuredAnswers: { q_name: ["Timer"] } }; expect(await h.controller.submitInput(view, answer)).toBe(true);
  expect(h.submitInput).toHaveBeenCalledWith(binding.chatId, runId, "input_name", expect.objectContaining(answer));
  expect(await h.controller.submitInput({ ...view, id: "different" }, answer)).toBe(false); expect(h.submitInput).toHaveBeenCalledTimes(1); h.controller.dispose();
});
it("API uses strict bootstrap, negotiated detail and SSE URLs, bounded timeout and captured runtime", async () => {
  const fetcher = vi.fn(async (url: string, _init: RequestInit) => new Response(JSON.stringify(url.includes("bootstrap") ? binding : detail), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  const options = { baseUrl: "https://old.test", fetcher }; const api = createAoedeApi(options); options.baseUrl = "https://new.test";
  await api.bootstrap({ clientRequestId: "req_boot", intent: "continue", surface: "web_canvas" }); await api.detail(binding.chatId);
  const calls = vi.mocked(fetcher).mock.calls; expect(String(calls[0][0])).toBe("https://old.test/api/aoede/bootstrap");
  expect(calls[0][1]?.signal).toBeInstanceOf(AbortSignal); expect(JSON.parse(calls[0][1]?.body as string)).toEqual({ clientRequestId: "req_boot", intent: "continue", surface: "web_canvas" });
  expect(String(calls[1][0])).toContain("limit=200&messageVersion=2&inputVersion=1");
  const events = api.events(); await events.start(); expect(String(vi.mocked(fetcher).mock.calls[2][0])).toContain("/api/chats/events?messageVersion=2&inputVersion=1"); events.dispose();
  await expect(api.bootstrap({ clientRequestId: "req_bad", intent: "continue", surface: "web_canvas", chatId: "chat_wrong" } as never)).rejects.toThrow();
});
it.each(["bootstrap", "providers", "selection"] as const)("allows slow %s discovery but bounds it at 30 seconds", async operation => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  let respond = true;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    if (respond) setTimeout(() => resolve(new Response(JSON.stringify(
      operation === "bootstrap" ? binding : operation === "providers" ? catalog : detail.record,
    ))), 12_000);
  })) as unknown as typeof fetch;
  const api = createAoedeApi({ baseUrl: "https://runtime.test", fetcher });
  const invoke = () => operation === "bootstrap"
    ? api.bootstrap({ clientRequestId: "req_slow", intent: "continue", surface: "web_canvas" })
    : operation === "providers" ? api.providers()
      : api.updateSelection(binding.chatId, { baseRevision: 0, selection: binding.selection });
  try {
    const slow = invoke();
    const success = slow.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await success).toEqual({ value: operation === "bootstrap" ? binding : operation === "providers" ? catalog : detail.record });
    respond = false;
    const stuck = invoke();
    const failure = expect(stuck).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.mocked(fetcher).mock.calls[1][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});
it("keeps ordinary detail requests bounded at ten seconds", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const api = createAoedeApi({ baseUrl: "https://runtime.test", fetcher: vi.fn(async () => new Response(JSON.stringify(detail))) });
  try { await api.detail(binding.chatId); expect(timeout).toHaveBeenCalledWith(10_000); }
  finally { timeout.mockRestore(); }
});
it("retries a single readiness timeout once with the same idempotent request before reporting failure", async () => {
  const h = harness(vi.fn().mockRejectedValueOnce(new DOMException("private upstream detail", "TimeoutError")).mockResolvedValue(binding));
  await h.controller.open();
  expect(h.bootstrap).toHaveBeenCalledTimes(2);
  expect(h.bootstrap.mock.calls[0][0].clientRequestId).toBe(h.bootstrap.mock.calls[1][0].clientRequestId);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "idle", error: null });
  expect(h.media.startVoice).not.toHaveBeenCalled();
  h.controller.dispose();
});
it("projects repeated readiness timeouts as retryable connection failure without starting media", async () => {
  const timeout = () => new DOMException("private upstream detail", "TimeoutError");
  const h = harness(vi.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout()).mockResolvedValue(binding));
  await h.controller.open();
  expect(h.bootstrap).toHaveBeenCalledTimes(2);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "failed", microphoneActive: false,
    error: { code: "connection_failed", retryable: true, recovery: "retry_connection" } });
  expect(h.factory).not.toHaveBeenCalled();
  await h.controller.retry();
  expect(h.bootstrap).toHaveBeenCalledTimes(3);
  expect(h.bootstrap.mock.calls[0][0].clientRequestId).toBe(h.bootstrap.mock.calls[2][0].clientRequestId);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "idle", error: null });
  expect(h.media.startVoice).not.toHaveBeenCalled();
  h.controller.dispose();
});
it("does not retry non-timeout bootstrap failures", async () => {
  const h = harness(vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(binding));
  await h.controller.open();
  expect(h.bootstrap).toHaveBeenCalledTimes(1);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "failed", error: { code: "internal_failure", retryable: true } });
  h.controller.dispose();
});
it("preserves newer capability failure and Retry after a timed-out bootstrap", async () => {
  const unready = { ...binding, capability: { ...binding.capability, status: "unavailable" as const,
    transportModes: [], turnModes: [], reason: "provider_unavailable" as const } };
  const timeout = () => new DOMException("Timed out", "TimeoutError");
  const h = harness(vi.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout()).mockResolvedValue(unready));
  await h.controller.open();
  expect(h.controller.getSnapshot().error?.code).toBe("connection_failed");
  await h.controller.retry();
  expect(h.controller.getSnapshot()).toMatchObject({ status: "failed",
    error: { code: "provider_unavailable", retryable: true } });
  await h.controller.refresh();
  expect(h.controller.getSnapshot().error?.code).toBe("provider_unavailable");
  expect(h.media.startVoice).not.toHaveBeenCalled();
  h.controller.dispose();
});
it("rechecks server readiness when explicitly replacing a stale model", async () => {
  const unready = { ...binding, capability: { ...binding.capability, status: "unavailable" as const,
    transportModes: [], turnModes: [], reason: "provider_unavailable" as const } };
  const next = { instanceId: "pi_main", model: "new:model" };
  const h = harness(vi.fn().mockResolvedValueOnce(unready).mockResolvedValue({ ...binding, selection: next }));
  await h.controller.open();
  h.detailFn.mockResolvedValue({ ...detail, record: { ...detail.record, chat: {
    ...detail.record.chat, revision: 1, currentSelection: next,
  } } });
  expect(await h.controller.setSelection(next)).toBe(true);
  expect(h.bootstrap).toHaveBeenCalledTimes(2);
  expect(h.controller.getSnapshot()).toMatchObject({ status: "idle", binding: {
    selection: next, capability: { status: "available", turnModes: ["hands_free", "push_to_talk"] },
  } });
  expect(h.media.startVoice).not.toHaveBeenCalled();
  h.controller.dispose();
});
it.each([false, true])("restores truthful readiness after detail recovery (available=%s)", async available => {
  const unready = { ...binding, capability: { ...binding.capability, status: "unavailable" as const,
    transportModes: [], turnModes: [], reason: "provider_unavailable" as const } };
  const h = harness(vi.fn().mockResolvedValue(available ? binding : unready));
  h.detailFn.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
  await h.controller.open();
  expect(h.controller.getSnapshot().status).toBe("failed");
  await h.controller.refresh();
  expect(h.controller.getSnapshot()).toMatchObject(available
    ? { status: "idle", error: null }
    : { status: "failed", error: { code: "provider_unavailable", retryable: true } });
  expect(h.media.startVoice).not.toHaveBeenCalled();
  h.controller.dispose();
});
it("preserves bounded safe bootstrap errors without displaying upstream details", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: {
    code: "provider_unavailable", retryable: true, recovery: "retry_connection",
  } }), { status: 503 }));
  const api = createAoedeApi({ baseUrl: "https://runtime.test", fetcher });
  await expect(api.bootstrap({ clientRequestId: "req_safe", intent: "continue", surface: "web_canvas" }))
    .rejects.toMatchObject({ status: 503, safeError: { code: "provider_unavailable", retryable: true, recovery: "retry_connection" } });
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "private-provider-failure", message: "secret detail" } }), { status: 503 }));
  await expect(api.bootstrap({ clientRequestId: "req_bad_safe", intent: "continue", surface: "web_canvas" }))
    .rejects.toMatchObject({ status: 503, safeError: undefined, message: "Assistant request unavailable" });
});
it("client calls providers, PATCH selection and POST action cancel with schema validation", async () => {
  const fetcher = vi.fn(async (url: string, _init: RequestInit) => new Response(JSON.stringify(
    url.includes("/api/chat-providers") ? catalog
      : url.includes("/actions/") ? { operation: operationView, cancellation: "requested" }
      : { ...detail.record, chat: { ...detail.record.chat, currentSelection: { instanceId: "pi_main", model: "test:model" } } },
  ), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  const api = createAoedeApi({ baseUrl: "https://runtime.test", fetcher });

  expect(await api.providers()).toEqual(catalog);
  expect(vi.mocked(fetcher).mock.calls[0][1]?.method).toBe("GET");

  const selection = { baseRevision: 2, selection: { instanceId: "pi_main", model: "test:model" } };
  const updated = await api.updateSelection("chat_aoede", selection);
  expect(updated.chat.id).toBe("chat_aoede");
  const patchCall = vi.mocked(fetcher).mock.calls[1];
  expect(String(patchCall[0])).toBe("https://runtime.test/api/chats/chat_aoede/selection");
  expect(patchCall[1]?.method).toBe("PATCH");
  expect(JSON.parse(patchCall[1]?.body as string)).toEqual(selection);

  const cancelled = await api.cancelAction("chat_aoede", "action_timer");
  expect(cancelled.cancellation).toBe("requested");
  expect(cancelled.operation.id).toBe("action_timer");
  const cancelCall = vi.mocked(fetcher).mock.calls[2];
  expect(String(cancelCall[0])).toBe("https://runtime.test/api/chats/chat_aoede/actions/action_timer/cancel");
  expect(cancelCall[1]?.method).toBe("POST");
  expect(JSON.parse(cancelCall[1]?.body as string)).toEqual({});
  expect(cancelCall[1]?.signal).toBeInstanceOf(AbortSignal);

  // Bad identifiers and malformed server payloads are rejected before/instead of use.
  await expect(api.cancelAction("chat_aoede", "nope")).rejects.toThrow();
  await expect(api.updateSelection("chat_aoede", { baseRevision: 2 } as never)).rejects.toThrow();
  fetcher.mockResolvedValueOnce(new Response("{}", { status: 503 }) as never);
  await expect(api.cancelAction("chat_aoede", "action_timer")).rejects.toBeInstanceOf(AoedeRequestError);
});

describe("Aoede shell owner", () => {
  it.each([new DOMException("Timed out", "TimeoutError"), new AoedeRequestError(503)])("does not report a passive refresh failure as a live voice failure: %s", async error => {
    const h = harness(undefined, runningDetail()); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "speaking", muted: false, turnMode: "hands_free" }, error: null, notice: null } as ReturnType<VoiceSessionClient["getSnapshot"]>);
    h.notifyMedia();
    const canonical = h.controller.getSnapshot().canonical;
    h.detailFn.mockRejectedValueOnce(error); await h.controller.refresh();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "speaking", microphoneActive: true, error: null });
    expect(h.controller.getSnapshot().canonical).toEqual(canonical);
    h.notifyMedia();
    expect(h.controller.getSnapshot().error).toBeNull();
    expect(h.media.end).not.toHaveBeenCalled();
    const mediaError = { code: "input_unavailable", retryable: false, recovery: "choose_input" } as const;
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "failed", voice: null, error: mediaError, notice: null } as ReturnType<VoiceSessionClient["getSnapshot"]>);
    h.notifyMedia();
    await h.controller.refresh();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "failed", microphoneActive: false, error: mediaError });
    h.controller.dispose();
  });
  it.each([403, 404, 410])("stops live media when a refresh loses chat access (%s)", async status => {
    const h = harness(); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "speaking", muted: false, turnMode: "hands_free" }, error: null, notice: null } as ReturnType<VoiceSessionClient["getSnapshot"]>);
    h.notifyMedia();
    h.detailFn.mockRejectedValueOnce(new AoedeRequestError(status)); await h.controller.refresh();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "failed", microphoneActive: false, error: { code: "chat_unavailable" } });
    expect(h.media.end).toHaveBeenCalled();
    h.controller.dispose();
  });
  it("keeps live microphone truth but reports an explicit mutation failure", async () => {
    const h = harness(undefined, runningDetail()); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "listening", muted: false, turnMode: "hands_free" }, error: null, notice: null } as ReturnType<VoiceSessionClient["getSnapshot"]>);
    h.notifyMedia();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "listening", microphoneActive: true });
    h.cancelRun.mockRejectedValueOnce(new AoedeRequestError(503)); expect(await h.controller.cancelGeneration()).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({ status: "listening", microphoneActive: true, error: { code: "internal_failure" } });
    h.notifyMedia();
    expect(h.controller.getSnapshot().error?.code).toBe("internal_failure");
    await h.controller.refresh();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "listening", microphoneActive: true, error: null });
    expect(h.media.end).not.toHaveBeenCalled(); h.controller.dispose();
  });

  it("deletion/access loss stops media, blocks reopen/retry and only explicit New rebinds", async () => {
    const h = harness(); await h.controller.open();
    h.source.subscribe.mock.calls[0][0]({ type: "chat.changed", chatId: binding.chatId, cursor: 1, revision: 1, eventType: "chat.deleted" });
    expect(h.controller.getSnapshot().error?.code).toBe("chat_unavailable"); await h.controller.open(); await h.controller.retry();
    expect(h.bootstrap).toHaveBeenCalledTimes(1); expect(h.media.end).toHaveBeenCalled();
    await h.controller.newConversation(); expect(h.bootstrap).toHaveBeenCalledTimes(2); h.controller.dispose();
    const lost = harness(); await lost.controller.open(); lost.detailFn.mockRejectedValueOnce(new AoedeRequestError(403)); await lost.controller.refresh();
    expect(lost.controller.getSnapshot().error?.code).toBe("chat_unavailable"); lost.controller.dispose();
  });
  it("cleanup failure stays visible instead of masquerading as a successful End", async () => {
    const h = harness(); await h.controller.open(); vi.mocked(h.media.end).mockRejectedValueOnce(new TypeError("cleanup")); await h.controller.end();
    expect(h.controller.getSnapshot().status).toBe("failed"); expect(h.controller.getSnapshot().error?.code).toBe("internal_failure"); expect(h.controller.getSnapshot().binding?.chatId).toBe(binding.chatId); h.controller.dispose();
  });
  it("New races are single-flight and end old media before bootstrap", async () => {
    const h = harness(); await h.controller.open(); const ending = deferred<void>(); vi.mocked(h.media.end).mockImplementationOnce(() => ending.promise);
    const a = h.controller.newConversation(); const b = h.controller.newConversation(); expect(h.bootstrap).toHaveBeenCalledTimes(1);
    ending.resolve(); await Promise.all([a, b]); expect(h.bootstrap).toHaveBeenCalledTimes(2); expect(h.bootstrap.mock.calls[1][0].intent).toBe("new"); h.controller.dispose();
  });
  it("fences late permission/create completion after End and identity disposal", async () => {
    const h = harness(); await h.controller.open(); await h.controller.start(); const pending = deferred<void>(); vi.mocked(h.media.startVoice).mockImplementationOnce(() => pending.promise);
    const start = h.controller.start(); await h.controller.end(); h.controller.dispose(); pending.resolve(); await start;
    expect(h.media.end).toHaveBeenCalled(); expect(h.controller.getSnapshot().microphoneActive).toBe(false); expect(h.controller.getSnapshot().status).toBe("ended");
  });
  it("captures ordinary supervised bootstrap selection, not any external Chat selection", async () => {
    const h = harness(); await h.controller.open(); expect(h.factory.mock.calls[0][0].request).toEqual({ turnMode: "hands_free", locale: "en", selection: binding.selection, interactionMode: "default", permissionMode: "supervised", memoryMode: "ordinary" }); h.controller.dispose();
  });
  it("bootstraps New on first open, then reuses that conversation on later opens", async () => {
    const h = harness(); await h.controller.open();
    expect(h.bootstrap).toHaveBeenCalledTimes(1); expect(h.bootstrap.mock.calls[0][0].intent).toBe("new");
    await h.controller.dismiss(); await h.controller.open();
    expect(h.bootstrap).toHaveBeenCalledTimes(1); expect(h.media.startVoice).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("retry recovery does not End an unresolved create or request microphone before Start", async () => {
    const h = harness(); await h.controller.open(); await h.controller.retry(); expect(h.media.end).not.toHaveBeenCalled(); expect(h.media.startVoice).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().status).toBe("idle"); await h.controller.start(); expect(h.media.startVoice).toHaveBeenCalledTimes(1); h.controller.dispose();
  });
  it("recovers model/funding readiness by bootstrap retry without opening Chat or replacing the conversation", async () => {
    const boot = vi.fn().mockResolvedValueOnce({ ...binding, capability: { ...binding.capability, status: "unavailable", reason: "provider_unavailable" } }).mockResolvedValue(binding);
    const h = harness(boot); await h.controller.open(); expect(h.controller.getSnapshot().status).toBe("failed"); await h.controller.retry();
    expect(h.controller.getSnapshot().binding?.capability.status).toBe("available"); expect(h.factory).toHaveBeenCalledTimes(1); expect(h.media.end).not.toHaveBeenCalled(); expect(h.media.startVoice).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("does not request media when canonical speech capability is unavailable", async () => {
    const h = harness(vi.fn(async () => ({ ...binding, capability: { ...binding.capability, status: "unavailable" as const } }))); await h.controller.open(); await h.controller.start(); await h.controller.start();
    expect(h.media.startVoice).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("racing icon/palette opens bootstrap once and never starts media; snapshot is stable", async () => {
    const h = harness(); await Promise.all([h.controller.open(), h.controller.open(), h.controller.focus()]);
    expect(h.bootstrap).toHaveBeenCalledTimes(1); expect(h.media.startVoice).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toBe(h.controller.getSnapshot()); expect(h.controller.getSnapshot().binding?.chatId).toBe("chat_aoede"); h.controller.dispose();
  });
  it("refreshes capability for a changed presentation surface without replacing the owner or media", async () => {
    const bootstrap = vi.fn(async (request: { surface: "web_canvas" | "web_desktop" }) => ({
      ...binding,
      capability: { ...binding.capability, surface: request.surface },
    }));
    const h = harness(bootstrap); await h.controller.open();
    await h.controller.setSurface("web_desktop");
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(bootstrap).toHaveBeenLastCalledWith(expect.objectContaining({ surface: "web_desktop" }));
    expect(h.controller.getSnapshot().binding?.capability.surface).toBe("web_desktop");
    expect(h.factory).toHaveBeenCalledTimes(1); expect(h.media.end).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("Start requests media in one gesture; End and reopen retain canonical conversation without media restart", async () => {
    const h = harness(); await h.controller.open(); expect(h.media.startVoice).not.toHaveBeenCalled();
    await h.controller.start(); expect(h.media.startVoice).toHaveBeenCalledWith("chat_aoede"); await h.controller.end(); await h.controller.open();
    expect(h.bootstrap).toHaveBeenCalledTimes(1); expect(h.media.startVoice).toHaveBeenCalledTimes(1); expect(h.source.dispose).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("retains bootstrap request identity across lost response and explicit New retry", async () => {
    const bootstrap = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValue(binding);
    const h = harness(bootstrap); await h.controller.open(); await h.controller.retry();
    expect(bootstrap.mock.calls[0][0].clientRequestId).toBe(bootstrap.mock.calls[1][0].clientRequestId);
    bootstrap.mockRejectedValueOnce(new TypeError("network")); await h.controller.newConversation(); await h.controller.newConversation();
    expect(bootstrap.mock.calls[2][0].intent).toBe("new"); expect(bootstrap.mock.calls[2][0].clientRequestId).toBe(bootstrap.mock.calls[3][0].clientRequestId); h.controller.dispose();
  });
  it("suspends identity ownership synchronously before queued disposal", async () => {
    const pending = deferred<typeof binding>(); const h = harness(vi.fn(() => pending.promise)); const opening = h.controller.open();
    h.controller.suspend(); pending.resolve(binding); await opening; expect(h.factory).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("fences deferred old-identity bootstrap before constructing media", async () => {
    const pending = deferred<typeof binding>(); const h = harness(vi.fn(() => pending.promise)); const opening = h.controller.open(); h.controller.dispose(); pending.resolve(binding); await opening;
    expect(h.factory).not.toHaveBeenCalled(); expect(h.controller.getSnapshot().binding).toBeNull();
  });
  it("canonical projection continues while dismissed and reopening never restarts media", async () => {
    const h = harness(); await h.controller.open(); await h.controller.dismiss();
    h.detailFn.mockResolvedValue({ ...detail, record: { chat: { ...detail.record.chat, revision: 1 } }, messages: [{ id: "msg_result", chatId: binding.chatId, seq: 1, role: "assistant", state: "committed", parts: [{ type: "text", text: "Work completed" }], createdAt: detail.record.chat.createdAt }] });
    h.source.subscribe.mock.calls[0][0]({ type: "chat.changed", chatId: binding.chatId, cursor: 1, revision: 1, eventType: "run.completed" }); await h.controller.refresh();
    expect(h.controller.getSnapshot().visible).toBe(false); expect(h.controller.getSnapshot().canonical.captions.response).toBe("Work completed"); await h.controller.open(); expect(h.media.startVoice).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("dismiss ends media but keeps canonical subscription discoverable", async () => {
    const h = harness(); await h.controller.open(); await h.controller.dismiss(); expect(h.media.end).toHaveBeenCalled(); expect(h.source.dispose).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().visible).toBe(false); await h.controller.open(); expect(h.controller.getSnapshot().binding?.chatId).toBe("chat_aoede"); h.controller.dispose();
  });
  it("maps transport phases to literal Connecting/Restoring statuses and restores the voice state", async () => {
    const h = harness(); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "starting", voice: null, error: null, notice: null, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
    h.notifyMedia(); expect(h.controller.getSnapshot().status).toBe("connecting");
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "awaiting_reconnect", voice: null, error: null, notice: null, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
    h.notifyMedia(); expect(h.controller.getSnapshot().status).toBe("restoring");
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "listening", muted: false, turnMode: "hands_free" }, error: null, notice: null, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
    h.notifyMedia(); expect(h.controller.getSnapshot().status).toBe("listening"); h.controller.dispose();
  });
  it("does not surface retryable backpressure while active media keeps running", async () => {
    const h = harness(); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "listening", muted: false, turnMode: "hands_free" }, error: null,
      notice: { code: "audio_backpressure", retryable: true, recovery: "none" }, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
    h.notifyMedia();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "listening", microphoneActive: true, error: null });
    h.controller.dispose();
  });
  it("surfaces a retryable media warning once the session is paused (microphone off)", async () => {
    // A wrong implementation that keys suppression on `phase === "active"` alone would
    // also hide the warning here; the paused voice state must let it through.
    const h = harness(); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "paused", muted: true, turnMode: "hands_free" }, error: null,
      notice: { code: "audio_backpressure", retryable: true, recovery: "none" }, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
    h.notifyMedia();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "paused", microphoneActive: false,
      error: { code: "audio_backpressure", retryable: true, recovery: "none" } });
    h.controller.dispose();
  });
  it("surfaces backpressure when media has actually ended", async () => {
    const h = harness(); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "ended", voice: null, error: null,
      notice: { code: "audio_backpressure", retryable: true, recovery: "none" }, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
    h.notifyMedia();
    expect(h.controller.getSnapshot()).toMatchObject({ status: "ended", microphoneActive: false,
      error: { code: "audio_backpressure", retryable: true, recovery: "none" } });
    h.controller.dispose();
  });
  it("shows the literal Ending status while live media teardown is in flight", async () => {
    const h = harness(); await h.controller.open();
    vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "listening", muted: false, turnMode: "hands_free" }, error: null, notice: null, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
    h.notifyMedia(); expect(h.controller.getSnapshot().status).toBe("listening");
    const ending = deferred<void>(); vi.mocked(h.media.end).mockImplementationOnce(() => ending.promise);
    const done = h.controller.end(); expect(h.controller.getSnapshot().status).toBe("ending");
    ending.resolve(); await done; expect(h.controller.getSnapshot().status).toBe("ended"); h.controller.dispose();
  });
  it("routes only validated installed-app navigation to the shell host", () => {
    const nav = vi.fn(); const h = harness(undefined, detail, { onOpenNavigation: nav });
    h.controller.openNavigation({ app: "files", path: "apps/files/index.html" });
    expect(nav).toHaveBeenCalledWith({ app: "files", path: "apps/files/index.html" });
    h.controller.openNavigation({ app: "files", path: "apps/files/deep/view" });
    expect(nav).toHaveBeenLastCalledWith({ app: "files", path: "apps/files/deep/view" });
    for (const bad of [
      { app: "Evil", path: "apps/Evil" },
      { app: "files", path: "../etc/passwd" },
      { app: "files", path: "apps/other/steal" },
      { app: "files", path: "apps/files/x/../y" },
      { app: "files", path: `apps/files/${"a".repeat(200)}` },
      { app: "files", path: "apps/files?query=1" },
      { app: "files", path: "apps//files" },
    ]) h.controller.openNavigation(bad);
    expect(nav).toHaveBeenCalledTimes(2); h.controller.dispose();
  });
  it("discovers the first action through contiguous content events and opens its completed navigation", async () => {
    const nav = vi.fn();
    const initial = { ...runningDetail(), operations: [] };
    const h = harness(undefined, initial, { onOpenNavigation: nav });
    await h.controller.open();
    const runId = initial.runs[0]!.id;
    const action = { ...operationView, runId, toolId: "matrix_open_app", state: "running" as const };
    const emit = (revision: number, state: "running" | "succeeded") => {
      const record = { ...initial.record, chat: { ...initial.record.chat, revision } };
      const activity = { id: "activity_open", chatId: binding.chatId, runId,
        occurredAt: initial.record.chat.createdAt, type: "tool.progress" as const,
        toolCallId: action.id, label: "matrix_open_app", status: state === "running" ? "running" as const : "completed" as const };
      h.detailFn.mockResolvedValue({ ...initial, record, activities: [activity], operations: [{ ...action, state,
        ...(state === "succeeded" ? { result: { navigation: { kind: "open_app" as const, app: "notes", path: "apps/notes" } } } : {}) }] });
      const event = { chatId: binding.chatId, cursor: revision, revision, eventType: "run.activity" as const, createdAt: initial.record.chat.createdAt };
      h.source.subscribe.mock.calls[0]![0]({ type: "chat.changed", ...event,
        content: { type: "chat.content", event, content: { record, activities: [activity] } } });
    };
    emit(1, "running");
    await vi.waitFor(() => expect(h.controller.getSnapshot().canonical.operations).toEqual([expect.objectContaining({ id: action.id, state: "running" })]));
    expect(nav).not.toHaveBeenCalled();
    emit(2, "succeeded");
    await vi.waitFor(() => expect(nav).toHaveBeenCalledWith({ app: "notes", path: "apps/notes" }));
    expect(h.controller.getSnapshot().canonical.navigation?.operationId).toBe(action.id);
    emit(2, "succeeded");
    await h.controller.refresh();
    expect(nav).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it("automatically opens newly succeeded navigation once, but not history or unsafe results", async () => {
    const nav = vi.fn();
    const historical = { ...operationView, id: "action_history", state: "succeeded" as const,
      result: { navigation: { kind: "open_app" as const, app: "notes", path: "apps/notes" } } };
    const h = harness(undefined, { ...detail, operations: [historical] }, { onOpenNavigation: nav });
    await h.controller.open();
    expect(nav).not.toHaveBeenCalled();

    const succeeded = { ...historical, id: "action_new", updatedAt: "2026-09-30T00:00:01.000Z" };
    h.detailFn.mockResolvedValue({ ...detail, record: { ...detail.record, chat: { ...detail.record.chat, revision: 1 } }, operations: [succeeded, historical] });
    await h.controller.refresh();
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledWith({ app: "notes", path: "apps/notes" });
    await h.controller.refresh();
    expect(nav).toHaveBeenCalledTimes(1);

    const malicious = { ...historical, id: "action_malicious", updatedAt: "2026-09-30T00:00:02.000Z",
      result: { navigation: { kind: "open_app" as const, app: "notes", path: "apps/notes/../../etc/passwd" } } };
    h.detailFn.mockResolvedValue({ ...detail, record: { ...detail.record, chat: { ...detail.record.chat, revision: 2 } }, operations: [malicious, succeeded, historical] });
    await h.controller.refresh();
    expect(nav).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it("dispatches a newly completed close-app intent once without replaying history", async () => {
    const nav = vi.fn();
    const historical = { ...operationView, id: "action_old_close", state: "succeeded" as const,
      result: { navigation: { kind: "close_app" as const, app: "notes", path: "apps/notes" } } };
    const h = harness(undefined, { ...detail, operations: [historical] }, { onOpenNavigation: nav });
    await h.controller.open();
    expect(nav).not.toHaveBeenCalled();
    const current = { ...historical, id: "action_new_close", updatedAt: "2026-09-30T00:00:03.000Z" };
    h.detailFn.mockResolvedValue({ ...detail, record: { ...detail.record, chat: { ...detail.record.chat, revision: 3 } }, operations: [current, historical] });
    await h.controller.refresh();
    expect(nav).toHaveBeenCalledOnce();
    expect(nav).toHaveBeenCalledWith({ kind: "close_app", app: "notes", path: "apps/notes" });
    await h.controller.refresh();
    expect(nav).toHaveBeenCalledOnce();
    h.controller.dispose();
  });
  it("streams contiguous message content without refetching action details for every token", async () => {
    const initial = { ...runningDetail(), operations: [operationView] };
    const h = harness(undefined, initial);
    await h.controller.open();
    for (const [revision, offset, text] of [[1, 0, "Hello"], [2, 5, " world"]] as const) {
      const event = { chatId: binding.chatId, cursor: revision, revision, eventType: "run.message" as const, createdAt: initial.record.chat.createdAt };
      h.source.subscribe.mock.calls[0]![0]({ type: "chat.changed", ...event,
        content: { type: "chat.content", event, content: {
          record: { ...initial.record, chat: { ...initial.record.chat, revision } },
          messageDelta: { message: { id: "msg_stream", chatId: binding.chatId, seq: 100,
            role: "assistant", state: "pending", runId: initial.runs[0]!.id,
            createdAt: initial.record.chat.createdAt, parts: [{ type: "text", text }] }, partIndex: 0, offset },
        } } });
    }
    expect(h.controller.getSnapshot().canonical.captions.response).toBe("Hello world");
    expect(h.detailFn).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it("does not replay navigation completed while the controller is hidden or reconnecting", async () => {
    const nav = vi.fn(); const h = harness(undefined, detail, { onOpenNavigation: nav });
    await h.controller.open();
    await h.controller.dismiss();
    const hidden = { ...operationView, id: "action_hidden", state: "succeeded" as const,
      result: { navigation: { kind: "open_app" as const, app: "notes", path: "apps/notes" } } };
    h.detailFn.mockResolvedValue({ ...detail, record: { ...detail.record, chat: { ...detail.record.chat, revision: 1 } }, operations: [hidden] });
    await h.controller.refresh();
    await h.controller.open();
    expect(nav).not.toHaveBeenCalled();

    h.controller.suspend(); h.controller.activate();
    const reconnect = { ...hidden, id: "action_reconnect", updatedAt: "2026-09-30T00:00:01.000Z" };
    h.detailFn.mockResolvedValue({ ...detail, record: { ...detail.record, chat: { ...detail.record.chat, revision: 2 } }, operations: [reconnect, hidden] });
    await h.controller.refresh();
    expect(nav).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("serves the provider catalog once per owner and degrades when the api lacks it", async () => {
    const h = harness(); await h.controller.open();
    expect(await h.controller.listProviders()).toBe(catalog);
    expect(await h.controller.listProviders()).toBe(catalog);
    expect(h.providers).toHaveBeenCalledTimes(1); h.controller.dispose();
    const bare = harness(); const stripped = { ...bare.api } as Record<string, unknown>;
    delete stripped.providers; delete stripped.updateSelection; delete stripped.cancelAction;
    const ownerless = createAoedeController({ identityKey: "owner/runtime", baseUrl: "https://runtime.test", surface: "web_canvas" }, { api: stripped as AoedeApi, voiceFactory: bare.factory });
    expect(await ownerless.listProviders()).toBeNull(); ownerless.dispose();
  });
  it("updates the canonical selection under revision fencing and rebuilds the frozen media owner", async () => {
    const h = harness(); await h.controller.open();
    const next = { instanceId: "pi_alt", model: "other:model" };
    h.detailFn.mockResolvedValue({ ...detail, record: { ...detail.record, chat: { ...detail.record.chat, revision: 1, currentSelection: next } } });
    h.bootstrap.mockResolvedValue({ ...binding, selection: next });
    expect(await h.controller.setSelection(next)).toBe(true);
    expect(h.updateSelection).toHaveBeenCalledWith(binding.chatId, { baseRevision: 0, selection: next });
    expect(h.controller.getSnapshot().binding?.selection).toEqual(next);
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.factory.mock.calls[1][0].request.selection).toEqual(next);
    expect(h.media.end).toHaveBeenCalled(); h.controller.dispose();
  });
  it("cancels a targeted canonical action with per-action fencing and a truthful outcome", async () => {
    const opDetail = { ...detail, operations: [operationView] };
    const h = harness(undefined, opDetail); await h.controller.open();
    expect(await h.controller.cancelAction("action_timer")).toBe("cancelled");
    expect(h.cancelAction).toHaveBeenCalledWith("chat_aoede", "action_timer");
    expect(h.controller.getSnapshot().lastActionCancelOutcome).toBe("cancelled");
    expect(await h.controller.cancelAction("bogus")).toBeNull();
    expect(await h.controller.cancelAction("action_missing")).toBeNull();
    expect(h.cancelAction).toHaveBeenCalledTimes(1);
    const cancelled = { ...operationView, state: "cancelled" as const };
    h.detailFn.mockResolvedValue({ ...opDetail, operations: [cancelled] });
    await h.controller.refresh();
    expect(await h.controller.cancelAction("action_timer")).toBeNull(); // terminal ops are not cancellable
    h.controller.dispose();
  });
  it("fences a second cancel of the same action while the first is in flight", async () => {
    const h = harness(undefined, { ...detail, operations: [operationView] }); await h.controller.open();
    const pending = deferred<{ operation: typeof operationView; cancellation: "requested" }>();
    h.cancelAction.mockImplementationOnce(() => pending.promise as never);
    const first = h.controller.cancelAction("action_timer");
    expect(await h.controller.cancelAction("action_timer")).toBeNull();
    pending.resolve({ operation: { ...operationView, cancellationRequested: true }, cancellation: "requested" });
    expect(await first).toBe("requested");
    expect(h.controller.getSnapshot().lastActionCancelOutcome).toBe("requested"); h.controller.dispose();
  });
  it("defaults to English and rebuilds media with the selected language or no hint for Automatic", async () => {
    const h = harness(); await h.controller.open();
    expect(h.controller.getSnapshot().preferredLanguage).toBe("en");
    expect(h.factory.mock.calls[0][0].request.locale).toBe("en");
    await h.controller.setPreferredLanguage("ur");
    expect(h.media.end).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().preferredLanguage).toBe("ur");
    expect(h.factory.mock.calls[1][0].request.locale).toBe("ur");
    expect(h.media.startVoice).not.toHaveBeenCalled();
    await h.controller.setPreferredLanguage("auto");
    expect(h.factory.mock.calls[2][0].request).not.toHaveProperty("locale");
    await h.controller.setPreferredLanguage("injected");
    expect(h.factory).toHaveBeenCalledTimes(3);
    h.controller.dispose();
  });
  it("persists turn mode/device choices and rebuilds the media owner with the new request", async () => {
    const h = harness(); await h.controller.open();
    await h.controller.setInputDevice("mic_usb"); await h.controller.setOutputDevice("spk_hdmi");
    expect(h.media.setInputDevice).toHaveBeenCalledWith("mic_usb"); expect(h.media.setOutputDevice).toHaveBeenCalledWith("spk_hdmi");
    await h.controller.setTurnMode("push_to_talk");
    expect(h.controller.getSnapshot().turnMode).toBe("push_to_talk");
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.factory.mock.calls[1][0].request).toEqual(expect.objectContaining({ turnMode: "push_to_talk", inputDeviceId: "mic_usb", outputDeviceId: "spk_hdmi" }));
    h.controller.dispose();
  });
  it("fails closed when a persisted input vanishes before Start without selecting or starting a fallback", async () => {
    const h = harness(); await h.controller.open();
    await h.controller.setInputDevice("mic_gone");
    vi.mocked(h.media.listDevices).mockResolvedValueOnce(devices.filter((device) => device.deviceId !== "mic_gone"));
    await h.controller.start();
    expect(h.controller.getSnapshot().inputDeviceId).toBeNull();
    expect(h.controller.getSnapshot().error?.code).toBe("input_unavailable");
    expect(h.media.end).toHaveBeenCalled();
    expect(h.media.setInputDevice).not.toHaveBeenCalledWith(null);
    expect(h.media.startVoice).not.toHaveBeenCalled(); h.controller.dispose();
  });
  it("devicechange stops media before clearing a vanished device and never hot-swaps a default", async () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal("navigator", { mediaDevices: { addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); }, removeEventListener: vi.fn() } });
    try {
      const h = harness(); await h.controller.open();
      vi.mocked(h.media.getSnapshot).mockReturnValue({ phase: "active", voice: { state: "listening", muted: false, turnMode: "hands_free" }, error: null, notice: null, chatId: binding.chatId, sessionId: "vs_1", reconnectStatus: null } as never);
      h.notifyMedia();
      await h.controller.setInputDevice("mic_gone");
      await h.controller.setOutputDevice("spk_gone");
      vi.mocked(h.media.end).mockImplementationOnce(async () => {
        expect(h.controller.getSnapshot().inputDeviceId).toBe("mic_gone");
        expect(h.controller.getSnapshot().outputDeviceId).toBe("spk_gone");
      });
      vi.mocked(h.media.listDevices).mockResolvedValueOnce(devices);
      for (const listener of listeners) listener();
      await vi.waitFor(() => expect(h.controller.getSnapshot().status).toBe("failed"));
      expect(h.controller.getSnapshot().inputDeviceId).toBeNull();
      expect(h.controller.getSnapshot().outputDeviceId).toBeNull();
      expect(h.controller.getSnapshot().error?.code).toBe("input_unavailable");
      expect(h.media.end).toHaveBeenCalled();
      expect(h.media.setInputDevice).not.toHaveBeenCalledWith(null);
      expect(h.media.setOutputDevice).not.toHaveBeenCalledWith(null);
      // Denied/unsupported enumeration preserves the persisted choice.
      const kept = harness(); await kept.controller.open();
      await kept.controller.setInputDevice("mic_usb");
      vi.mocked(kept.media.listDevices).mockResolvedValueOnce(null);
      for (const listener of listeners) listener();
      await Promise.resolve();
      expect(kept.controller.getSnapshot().inputDeviceId).toBe("mic_usb");
      kept.controller.dispose(); h.controller.dispose();
    } finally { vi.unstubAllGlobals(); }
  });
  it("fences overlapping device enumeration by revision and selected-device identity", async () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal("navigator", { mediaDevices: { addEventListener: (_type: string, listener: () => void) => { listeners.push(listener); }, removeEventListener: vi.fn() } });
    try {
      const h = harness(); await h.controller.open(); await h.controller.setInputDevice("mic_usb");
      const stale = deferred<typeof devices>();
      vi.mocked(h.media.listDevices).mockImplementationOnce(() => stale.promise);
      listeners[0]?.();
      await h.controller.setInputDevice("mic_new");
      vi.mocked(h.media.listDevices).mockResolvedValueOnce([...devices, { deviceId: "mic_new", kind: "audioinput", label: "New mic" }]);
      listeners[0]?.();
      await vi.waitFor(() => expect(h.controller.getSnapshot().devicesRevision).toBe(1));
      stale.resolve(devices);
      await Promise.resolve();
      expect(h.controller.getSnapshot().inputDeviceId).toBe("mic_new");
      expect(h.controller.getSnapshot().devicesRevision).toBe(1);
      expect(h.media.end).not.toHaveBeenCalled();
      h.controller.dispose();
    } finally { vi.unstubAllGlobals(); }
  });
});
