import { describe, expect, it, vi } from "vitest";
import { createAoedeController } from "../../packages/ui/src/aoede/controller.js";
import { createAoedeApi, AoedeRequestError, type AoedeApi } from "../../packages/ui/src/aoede/client.js";
import type { AoedeBootstrapResponse } from "../../packages/contracts/src/aoede.js";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
import type { VoiceSessionClient } from "../../packages/ui/src/voice-session/client-types.js";

const binding: AoedeBootstrapResponse = { chatId: "chat_aoede", scope: { kind: "workspace", id: "main", label: "Workspace" }, selection: { instanceId: "pi_main", model: "test:model" }, capability: { contractVersion: 1, surface: "web_canvas", status: "available", transportModes: ["relayed_websocket"], turnModes: ["hands_free", "push_to_talk"], supportsInterruption: true, resume: "delivery_aware", sessionOnly: "unsupported", actionMode: "canonical_actions", actionCancellation: "run", supportsInputSelection: false, supportsOutputSelection: false } };
const detail: CanonicalChatDetailResponse = { record: { chat: { id: "chat_aoede", revision: 0, ownerScope: { type: "personal", ownerId: "owner_test" }, title: "Aoede", lifecycle: "active", attention: "none", messageCount: 0, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" } }, messages: [], turns: [], runs: [], activities: [] };
function harness(bootstrap = vi.fn(async () => binding), initialDetail = detail) {
  const source = { subscribe: vi.fn((_listener: (event: import("../../packages/ui/src/canonical-chat-event-source.js").CanonicalChatInvalidation) => void) => ({ dispose: vi.fn() })), start: vi.fn(async () => {}), dispose: vi.fn() };
  const detailFn = vi.fn(async () => initialDetail);
  const cancelRun = vi.fn(async () => ({})); const submitInput = vi.fn(async () => ({})); const submitApproval = vi.fn(async () => ({}));
  const api = { bootstrap, detail: detailFn, events: () => source, cancelRun, submitInput, submitApproval } as unknown as AoedeApi;
  const media = { subscribe: vi.fn(() => () => {}), getSnapshot: () => ({ phase: "idle", voice: null, error: null, notice: null, chatId: null, sessionId: null, reconnectStatus: null }), startVoice: vi.fn(async () => {}), end: vi.fn(async () => {}), dispose: vi.fn(), controller: () => null, retry: vi.fn() } as unknown as VoiceSessionClient;
  const factory = vi.fn(() => media);
  const controller = createAoedeController({ identityKey: "owner/runtime", baseUrl: "https://runtime.test", surface: "web_canvas" }, { api, voiceFactory: factory });
  return { controller, api, media, factory, bootstrap, source, detailFn, cancelRun, submitInput, submitApproval };
}
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

describe("Aoede shell owner", () => {
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
    const h = harness(); await h.controller.open(); expect(h.factory.mock.calls[0][0].request).toEqual({ turnMode: "hands_free", selection: binding.selection, interactionMode: "default", permissionMode: "supervised", memoryMode: "ordinary" }); h.controller.dispose();
  });
  it("bootstraps Continue after reload and still requires explicit two-step Start", async () => {
    const old = harness(); await old.controller.open(); old.controller.dispose(); const restored = harness(); await restored.controller.open();
    expect(restored.bootstrap.mock.calls[0][0].intent).toBe("continue"); expect(restored.media.startVoice).not.toHaveBeenCalled(); restored.controller.dispose();
  });
  it("retry recovery does not End an unresolved create or request microphone before confirmation", async () => {
    const h = harness(); await h.controller.open(); await h.controller.retry(); expect(h.media.end).not.toHaveBeenCalled(); expect(h.media.startVoice).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().status).toBe("permission"); await h.controller.start(); expect(h.media.startVoice).toHaveBeenCalledTimes(1); h.controller.dispose();
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
  it("Start shows rationale then confirms; End and reopen retain canonical conversation without media restart", async () => {
    const h = harness(); await h.controller.open(); await h.controller.start(); expect(h.controller.getSnapshot().status).toBe("permission"); expect(h.media.startVoice).not.toHaveBeenCalled();
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
});
