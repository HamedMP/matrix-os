import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransientChatClassifier } from "../../packages/gateway/src/chat-analytics/index.js";

const binding = (suffix = "one", ownerId = "owner_one") => ({ ownerId, chatId: `chat_${suffix}`, runId: `run_${suffix}`,
  runtimeHandle: `runtime_${suffix}`, executionGeneration: "1", requestId: `req_${suffix}` });
const request = (suffix = "one", ownerId = "owner_one") => ({ binding: binding(suffix, ownerId), api: "openai-completions" as const,
  body: JSON.stringify({ model: "measured-model", messages: [{ role: "user", content: `Task ${suffix}` }] }) });
const facts = () => ({ completedAt: new Date().toISOString(), modelId: "measured-model", harness: "matrix_pi", accessSource: "matrix_included",
  inputTokens: 10, outputTokens: 5, cachedInputTokens: null, costUsd: 0.001, latencyMs: 20 });
const tags = { taskFamily: "coding", taskType: "review", complexity: "medium", confidence: 0.8 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const services: ReturnType<typeof createTransientChatClassifier>[] = [];
function setup(extra: Record<string, unknown> = {}) {
  const store = {
    inspectAdmission: vi.fn().mockResolvedValue({ ownerEpoch: "11111111-1111-4111-8111-111111111111", chatEpoch: "22222222-2222-4222-8222-222222222222", sampleRateBps: 10_000 }),
    recordCompleted: vi.fn().mockResolvedValue(true), revalidateGeneration: vi.fn().mockResolvedValue(true),
    commitTags: vi.fn().mockResolvedValue(true), deleteOwner: vi.fn().mockResolvedValue(undefined), deleteChat: vi.fn().mockResolvedValue(undefined),
  };
  const classify = vi.fn().mockResolvedValue(tags);
  const service = createTransientChatClassifier({ store, classify, enabled: true, ...extra });
  services.push(service); return { service, store, classify };
}
afterEach(async () => { for (const service of services.splice(0)) await service.close(); vi.restoreAllMocks(); });

describe("ordinary Chat transient classifier", () => {
  it("cancels only the exact deleted Chat without another database operation",async()=>{
    const{service,store,classify}=setup();const one=request("cancel_one");const other=request("keep_two");other.binding.chatId="chat_two";
    const a=await service.capture(one);const b=await service.capture(other);
    service.cancelChat(one.binding.ownerId,one.binding.chatId);service.completed(a!,facts());service.completed(b!,facts());await service.whenIdle();
    expect(store.deleteChat).not.toHaveBeenCalled();expect(classify).toHaveBeenCalledTimes(1);
    expect(store.recordCompleted.mock.calls[0][0].binding.chatId).toBe("chat_two");
  });
  it("defaults off without inspecting or copying a prompt", async () => {
    const { service, store, classify } = setup({ enabled: undefined });
    expect(await service.capture(request())).toBeNull();
    expect(store.inspectAdmission).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
  });
  it.each(["google", "mixed", "unknown", "deleted"])("never classifies a denied %s context", async () => {
    const { service, store, classify } = setup(); store.inspectAdmission.mockResolvedValue(null);
    expect(await service.capture(request())).toBeNull();
    expect(classify).not.toHaveBeenCalled(); expect(store.recordCompleted).not.toHaveBeenCalled();
  });
  it("rejects forged caller flags and cloned/replayed capture receipts", async () => {
    const { service, store, classify } = setup();
    expect(await service.capture({ ...request(), ordinary: true } as never)).toBeNull();
    service.completed({} as never, facts());
    const capture = await service.capture(request()); expect(capture).toBeTruthy();
    service.completed(JSON.parse(JSON.stringify(capture)), facts());
    expect(classify).not.toHaveBeenCalled();
    service.completed(capture!, facts()); service.completed(capture!, facts()); await service.whenIdle();
    expect(store.recordCompleted).toHaveBeenCalledTimes(1); expect(classify).toHaveBeenCalledTimes(1);
  });
  it("uses only the captured immutable generation text and persists measured metadata plus fixed tags", async () => {
    const { service, store, classify } = setup(); const input = request();
    const capture = await service.capture(input); input.body = JSON.stringify({ messages: [{ role: "user", content: "future private text" }] });
    service.completed(capture!, facts()); await service.whenIdle();
    expect(classify.mock.calls[0][0]).toEqual({ messages: [{ role: "user", text: "Task one" }] });
    expect(classify.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(store.recordCompleted.mock.calls[0][0]).toMatchObject({ binding: binding(), sampled: true, facts: { modelId: "measured-model", inputTokens: 10 } });
    expect(JSON.stringify(store.recordCompleted.mock.calls)).not.toContain("Task one");
    expect(JSON.stringify(store.commitTags.mock.calls)).not.toContain("future private text");
    expect(store.commitTags.mock.calls[0][1]).toEqual(tags);
  });
  it("keeps actual metadata for an unsampled generation without passing text to the classifier", async () => {
    const { service, store, classify } = setup({ randomInt: () => 9999 });
    store.inspectAdmission.mockResolvedValue({ ownerEpoch: "11111111-1111-4111-8111-111111111111", chatEpoch: "22222222-2222-4222-8222-222222222222", sampleRateBps: 100 });
    const capture = await service.capture(request()); service.completed(capture!, facts()); await service.whenIdle();
    expect(classify).not.toHaveBeenCalled();
    expect(store.recordCompleted.mock.calls[0][0]).toMatchObject({ sampled: false });
    expect(JSON.stringify(store.recordCompleted.mock.calls)).not.toContain("Task one");
  });
  it("isolates classifier/model/schema failures from the successful primary completion", async () => {
    const { service, store, classify } = setup();
    classify.mockRejectedValueOnce(new Error("PRIVATE MODEL ERROR"));
    const first = await service.capture(request("one")); expect(() => service.completed(first!, facts())).not.toThrow(); await service.whenIdle();
    classify.mockResolvedValueOnce({ ...tags, reason: "PRIVATE CONTENT" });
    const second = await service.capture(request("two")); service.completed(second!, facts()); await service.whenIdle();
    expect(store.recordCompleted).toHaveBeenCalledTimes(2); expect(store.commitTags).not.toHaveBeenCalled();
  });
  it("cancels primary failures before metadata or classifier work", async () => {
    const { service, store, classify } = setup(); const capture = await service.capture(request());
    service.cancel(capture!); service.completed(capture!, facts()); await service.whenIdle();
    expect(store.recordCompleted).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
  });
  it("does not erase a valid completion when the primary run subsequently shuts down normally", async () => {
    const { service, store } = setup(); const abort = new AbortController();
    const capture = await service.capture({ ...request(), signal: abort.signal });
    service.completed(capture!, facts()); abort.abort(); await service.whenIdle();
    expect(store.commitTags).toHaveBeenCalledTimes(1);
  });
  it("rechecks provenance after queue wait and discards taint appearing during classification", async () => {
    const { service, store, classify } = setup({ limits: { maxActive: 1 } }); const hold = deferred<unknown>();
    classify.mockReturnValueOnce(hold.promise);
    const one = await service.capture(request("one")); service.completed(one!, facts());
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
    const two = await service.capture(request("two")); service.completed(two!, facts());
    store.revalidateGeneration.mockResolvedValue(false); hold.resolve(tags); await service.whenIdle();
    expect(classify).toHaveBeenCalledTimes(1); expect(store.commitTags).not.toHaveBeenCalled();
  });
  it("caps retained receipts per owner and by snapshot bytes", async () => {
    const { service } = setup({ limits: { maxPerOwner: 1, maxSnapshotBytes: 512, maxSnapshotBytesTotal: 512 } });
    expect(await service.capture(request("one"))).toBeTruthy();
    expect(await service.capture(request("two"))).toBeNull();
    const large = request("large", "owner_two"); large.body = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1024) }] });
    expect(await service.capture(large)).toBeNull();
  });
  it("expires pending capture receipts before they can complete", async () => {
    let now = Date.now(); const { service, store } = setup({ now: () => now, limits: { receiptTtlMs: 100 } });
    const capture = await service.capture(request()); now += 101; service.completed(capture!, facts()); await service.whenIdle();
    expect(store.recordCompleted).not.toHaveBeenCalled();
  });
  it("blocks recursive classifier-generated primary hooks", async () => {
    const { service, classify } = setup();
    classify.mockImplementation(async () => { expect(await service.capture(request("recursive"))).toBeNull(); return tags; });
    const capture = await service.capture(request()); service.completed(capture!, facts()); await service.whenIdle();
    expect(classify).toHaveBeenCalledTimes(1);
  });
  it("cancels current owner classifier jobs without deleting retained facts", async () => {
    const { service, store, classify } = setup(); let aborted = false;
    classify.mockImplementation((_snapshot, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true })));
    const capture = await service.capture(request()); service.completed(capture!, facts()); await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
    service.cancelOwner("owner_one"); await service.whenIdle();
    expect(aborted).toBe(true); expect(store.recordCompleted).toHaveBeenCalledTimes(1);
    expect(store.deleteOwner).not.toHaveBeenCalled(); expect(store.commitTags).not.toHaveBeenCalled();
  });
  it("aborts active work before owner deletion and drops late result tags", async () => {
    const { service, store, classify } = setup(); let aborted = false;
    classify.mockImplementation((_snapshot, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true })));
    const capture = await service.capture(request()); service.completed(capture!, facts()); await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
    await service.deleteOwner("owner_one"); await service.whenIdle();
    expect(aborted).toBe(true); expect(store.deleteOwner).toHaveBeenCalledWith("owner_one"); expect(store.commitTags).not.toHaveBeenCalled();
  });
  it("reports incomplete shutdown while an admission query is still running", async () => {
    const { service, store } = setup({ limits: { shutdownTimeoutMs: 10 } });
    const hold = deferred<null>(); store.inspectAdmission.mockReturnValue(hold.promise);
    const pending = service.capture(request());
    expect(await service.close()).toMatchObject({ drained: false });
    hold.resolve(null); expect(await pending).toBeNull();
    expect(await service.close()).toMatchObject({ drained: true });
  });
  it("aborts a classifier deadline and honestly reports a transport that ignores shutdown", async () => {
    const hold = deferred<unknown>(); const { service, classify, store } = setup({ limits: { classificationTimeoutMs: 10, shutdownTimeoutMs: 10 } });
    classify.mockReturnValue(hold.promise);
    const capture = await service.capture(request()); service.completed(capture!, facts()); await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(classify.mock.calls[0][1].aborted).toBe(true);
    expect(await service.close()).toMatchObject({ drained: false });
    hold.resolve(tags); await service.whenIdle(); expect(store.commitTags).not.toHaveBeenCalled();
  });
});
