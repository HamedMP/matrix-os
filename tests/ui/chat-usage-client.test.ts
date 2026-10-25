import { expect, it, vi } from "vitest";
import { createChatUsageClient } from "../../packages/ui/src/chat-usage/client.js";

export const policy = { enabled: false, sampleRateBps: 1000, modelId: "@cf/meta/classifier", recipient: "Cloudflare Workers AI",
  disclosureVersion: "chat-usage-v1", retentionDays: 30 };
export const summary = { from: "2026-10-18T12:00:00.000Z", to: "2026-10-25T12:00:00.000Z", groupLimit: 100,
  mayBeTruncated: false, classificationIsEstimate: true, buckets: [{ dimensions: { taskFamily: "coding" },
    generations: 4, sampled: 2, classified: 1, inputTokens: 100, outputTokens: null, cachedInputTokens: null, costUsd: null,
    latencyMsMean: 350, unknownInputTokenGenerations: 1, unknownOutputTokenGenerations: 4,
    unknownCachedInputTokenGenerations: 4, unknownCostGenerations: 4, unknownLatencyGenerations: 2,
    samplingRateBpsMin: 1000, samplingRateBpsMax: 2500 }] };

const signal = () => new AbortController().signal;
it("reads validated owner policy and bounded grouped summaries with no arbitrary metadata", async () => {
  const request = vi.fn().mockResolvedValueOnce(policy).mockResolvedValueOnce(summary);
  const client = createChatUsageClient(request);
  expect(await client.policy(signal())).toEqual(policy);
  expect(await client.summary("taskFamily", signal())).toEqual(summary);
  expect(request.mock.calls[1]![0]).toMatchObject({ method: "GET", path: "/api/chat-usage/summary?groupBy=taskFamily&limit=100" });
});
it("requires the disclosure on enable, strictly bounds sampling and sends explicit stop/delete requests", async () => {
  const request = vi.fn().mockResolvedValue(policy);
  const client = createChatUsageClient(request);
  await expect(client.configure({ enabled: true, sampleRateBps: 1000 }, signal())).rejects.toThrow("Chat usage is unavailable.");
  await expect(client.configure({ enabled: false, sampleRateBps: 10001 }, signal())).rejects.toThrow();
  await expect(client.configure({ enabled: false, sampleRateBps: 1000, secret: "bad" } as never, signal())).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  await client.configure({ enabled: false, sampleRateBps: 1000 }, signal());
  expect(request).toHaveBeenLastCalledWith({ path: "/api/chat-usage/policy", method: "PUT", body: { enabled: false, sampleRateBps: 1000 }, signal: expect.any(AbortSignal) });
  request.mockResolvedValue({ deleted: true, enabled: false });
  await client.deleteData(signal());
  expect(request).toHaveBeenLastCalledWith({ path: "/api/chat-usage/data", method: "DELETE", body: {}, signal: expect.any(AbortSignal) });
});
it.each([
  { ...summary, buckets: [{ ...summary.buckets[0], rawPrompt: "private" }] },
  { ...summary, buckets: [{ ...summary.buckets[0], classified: 5 }] },
  { ...summary, buckets: [{ ...summary.buckets[0], dimensions: { account: "someone" } }] },
  { ...summary, buckets: Array(201).fill(summary.buckets[0]) },
  { ...summary, buckets: [{ ...summary.buckets[0], latencyMsMean: Number.NaN }] },
])("rejects malformed aggregate responses", async value => {
  await expect(createChatUsageClient(vi.fn().mockResolvedValue(value)).summary("taskFamily", signal())).rejects.toThrow("Chat usage is unavailable.");
});
it("rejects stale identity and aborted responses even when the transport ignores cancellation", async () => {
  let finish!: (value: unknown) => void;
  let current = true;
  const caller = new AbortController();
  const request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const pending = createChatUsageClient(request, () => current).policy(caller.signal);
  current = false; finish(policy);
  await expect(pending).rejects.toThrow();
  current = true;
  const aborted = createChatUsageClient(request).policy(caller.signal);
  caller.abort(); finish(policy);
  await expect(aborted).rejects.toThrow();
});
it("replaces provider errors with a fixed safe error", async () => {
  const client = createChatUsageClient(vi.fn().mockRejectedValue(new Error("postgres://secret@example private-provider")));
  await expect(client.policy(signal())).rejects.toThrow(/^Chat usage is unavailable\.$/);
});
