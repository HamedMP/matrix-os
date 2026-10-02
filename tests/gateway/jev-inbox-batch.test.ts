import { expect, it, vi } from "vitest";
import { createJevInboxBatch } from "../../packages/gateway/src/jev/inbox-batch.js";
import type { BatchDocument, JevInboxBatchStore } from "../../packages/gateway/src/jev/inbox-batch-store.js";
import type { HermesJevScope } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
const scope: HermesJevScope = { kind: "jev_inbox_preview", runId: "run_1", agentId: "agent_1", revision: 1,
  account: { service: "gmail", accountLabel: "Work", connectionId: "conn_1", expectedEmail: "me@example.test", labelingEnabled: true } };
function fixture() {
  let data: BatchDocument | null = null;
  const store: JevInboxBatchStore = {
    async get() { return data ? structuredClone(data) : null; },
    async open(document) {
      if (!data || data.status === "completed")
        data = structuredClone(document);
      return structuredClone(data);
    },
    async save(document, revision) {
      if (!data || data.revision !== revision)
        throw new Error("Conflict");
      data = structuredClone(document);
      return structuredClone(data);
    },
  };
  const read = vi.fn(async (_owner: string, _scope: HermesJevScope, _action: string, params?: Record<string, unknown>) => params?.pageToken ? { threads: [{ id: "thread_2" }] } : { threads: [{ id: "thread_1" }], nextPageToken: "page_2" });
  const process = vi.fn(async (threadId: string, _signal: AbortSignal, authorize: () => Promise<void>) => {
    await authorize();
    return { kind: "labeled", threadId, messageCount: 1, labels: ["00 • Jev/1 Urgent"] };
  });
  const authorize = vi.fn(async () => undefined);
  const batch = createJevInboxBatch({ store, read, process, authorize });
  return { batch, store, read, process, authorize, get: () => data };
}
it.each(["revision", "account"])("reports no current batch when only an older %s binding exists", async (changed) => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  const current = changed === "revision" ? { ...scope, revision: 2 }
    : { ...scope, account: { ...scope.account, connectionId: "conn_2" } };
  expect(await f.batch.execute("owner_1", current, { operation: "batch_status" })).toEqual({ kind: "batch_absent" });
  await expect(f.batch.execute("owner_1", current, { operation: "batch_status", jobId: start.jobId })).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.process).not.toHaveBeenCalled();
});
async function next(f: ReturnType<typeof fixture>, jobId: string, currentScope = scope, engine = f.batch) {
  const status = await engine.execute("owner_1", currentScope, { operation: "batch_status", jobId });
  return engine.execute("owner_1", currentScope, { operation: "batch_next", jobId, revision: status.revision });
}
it("traverses Inbox pages and labels multiple threads without the model choosing IDs", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start", maxThreads: 100 });
  await next(f, start.jobId);
  const done = await next(f, start.jobId);
  expect(done).toMatchObject({ kind: "batch", status: "completed", processed: 2, labeled: 2, messagesLabeled: 2 });
  expect(f.process.mock.calls.map(x => x[0])).toEqual(["thread_1", "thread_2"]);
  expect(f.read.mock.calls[1]?.[3]).toEqual({ pageToken: "page_2" });
});
it("resumes after a stopped in-flight attempt without reissuing its paid/write work", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  const barrier = Promise.withResolvers<void>();
  f.process.mockImplementationOnce(async (thread, signal, authorize) => { await barrier.promise; await authorize(); return { kind: "labeled", threadId: thread, messageCount: 1, labels: [] }; });
  const step = next(f, start.jobId).catch(() => null);
  await vi.waitFor(() => expect(f.process).toHaveBeenCalledOnce());
  await f.batch.pause("owner_1", scope);
  barrier.resolve();
  await step;
  const restarted = createJevInboxBatch({ store: f.store, read: f.read, process: f.process, authorize: f.authorize });
  const resumed = { ...scope, runId: "run_2" };
  await restarted.execute("owner_1", resumed, { operation: "batch_resume", jobId: start.jobId });
  const result = await next(f, start.jobId, resumed, restarted);
  expect(f.process.mock.calls.map(x => x[0])).toEqual(["thread_1", "thread_2"]);
  expect(result).toMatchObject({ status: "completed_with_unconfirmed", labeled: 1, unconfirmed: 1 });
});
it("stops cyclic pagination rather than claiming completion or looping forever", async () => {
  const f = fixture();
  f.read.mockImplementation(async (_owner, _scope, _action, params) => ({ threads: [], nextPageToken: params?.pageToken === "A" ? "B" : "A" }));
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  await next(f, start.jobId);
  await next(f, start.jobId);
  const result = await next(f, start.jobId);
  expect(result).toMatchObject({ status: "paused", processed: 0 });
  expect(f.process).not.toHaveBeenCalled();
});
it("deduplicates repeated threads across pages without recharging or relabeling", async () => {
  const f = fixture();
  f.read.mockImplementation(async (_o, _s, _a, p) => p?.pageToken ? { threads: [{ id: "thread_1" }, { id: "thread_2" }] } : { threads: [{ id: "thread_1" }], nextPageToken: "p2" });
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  await next(f, start.jobId);
  const done = await next(f, start.jobId);
  expect(done.processed).toBe(2);
  expect(f.process).toHaveBeenCalledTimes(2);
});
it("reports a requested limit without claiming the remaining Inbox completed", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start", maxThreads: 1 });
  expect(await next(f, start.jobId)).toMatchObject({ status: "limit_reached", processed: 1, hasMore: true });
  await next(f, start.jobId);
  expect(f.process).toHaveBeenCalledOnce();
});
it("continues beyond Review while pausing an unconfirmed write", async () => {
  const f = fixture();
  f.process.mockResolvedValueOnce({ kind: "review" } as never);
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  expect(await next(f, start.jobId)).toMatchObject({ status: "ready", review: 1, labeled: 0 });
  f.process.mockResolvedValueOnce({ kind: "labeling_unconfirmed", messageCount: 1 } as never);
  expect(await next(f, start.jobId)).toMatchObject({ status: "paused", review: 1, unconfirmed: 1 });
});
it("persists an uncertain paid attempt and never retries it on resume", async () => {
  const f = fixture();
  f.process.mockRejectedValueOnce(new Error("Inference outcome unknown"));
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  const paused = await next(f, start.jobId);
  expect(paused).toMatchObject({ status: "paused", unconfirmed: 1 });
  await f.batch.execute("owner_1", scope, { operation: "batch_resume", jobId: start.jobId });
  await next(f, start.jobId);
  expect(f.process.mock.calls.map(x => x[0])).toEqual(["thread_1", "thread_2"]);
});
it("rejects revoked or rebound scopes before another mailbox read", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  await expect(f.batch.execute("owner_1", { ...scope, revision: 2 }, { operation: "batch_next", jobId: start.jobId, revision: start.revision })).rejects.toThrow();
  f.authorize.mockRejectedValueOnce(new Error("Revoked"));
  await expect(next(f, start.jobId)).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.process).not.toHaveBeenCalled();
});
it("serializes concurrent step calls against one persistent attempt", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  const a = await Promise.all([next(f, start.jobId), next(f, start.jobId)]);
  expect(a[0]).toEqual(a[1]);
  expect(f.process).toHaveBeenCalledOnce();
});
it("a listing failure pauses without a fake unconfirmed mail item", async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error("Discovery unavailable"));
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  expect(await next(f, start.jobId)).toMatchObject({ status: "paused", processed: 0, unconfirmed: 0, hasMore: true });
  expect(f.process).not.toHaveBeenCalled();
});
it("does not start another thread when a completed step is retried with the same revision", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  const input = { operation: "batch_next", jobId: start.jobId, revision: start.revision };
  await f.batch.execute("owner_1", scope, input);
  const replay = await f.batch.execute("owner_1", scope, input);
  expect(f.process).toHaveBeenCalledOnce();
  expect(replay.processed).toBe(1);
});
it("retains historical Review-required proposal counters without replaying writes", async () => {
  const f = fixture();
  f.process.mockResolvedValueOnce({ kind: "proposal", messageCount: 1, labelingSkipped: "review_required" } as never);
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  expect(await next(f, start.jobId)).toMatchObject({ review: 1, preview: 0, status: "ready" });
});
it("returns an explicit empty status before a batch exists, with no mailbox read or inference", async () => {
  const f = fixture();
  expect(await f.batch.execute("owner_1", scope, { operation: "batch_status" })).toEqual({ kind: "batch_absent" });
  expect(f.batch.presentation("owner_1", scope)).toEqual({ kind: "batch_absent" });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.process).not.toHaveBeenCalled();
});
it("does not count messages as labeled when verified classification has no eligible labels", async () => {
  const f = fixture();
  f.process.mockResolvedValueOnce({ kind: "labeled", messageCount: 4, labels: [] } as never);
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  expect(await next(f, start.jobId)).toMatchObject({ labeled: 0, noChange: 1, messagesLabeled: 0 });
});
it("start recovers an interrupted persisted attempt after process restart", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  const d = f.get()!;
  await f.store.save({ ...d, revision: d.revision + 1, status: "running", listed: true, queue: ["thread_1", "thread_2"], pending: { threadId: "thread_1", runId: scope.runId, attempt: "old" } }, d.revision);
  const engine = createJevInboxBatch({ store: f.store, read: f.read, process: f.process, authorize: f.authorize });
  const resumed = { ...scope, runId: "run_restart" };
  const recovered = await engine.execute("owner_1", resumed, { operation: "batch_start" });
  expect(recovered).toMatchObject({ jobId: start.jobId, status: "ready", unconfirmed: 1 });
  expect(await next(f, start.jobId, resumed, engine)).toMatchObject({ status: "completed_with_unconfirmed", labeled: 1 });
  expect(f.process.mock.calls.map(x => x[0])).toEqual(["thread_2"]);
});
it("a smaller new request caps an existing larger unfinished job before dispatch", async () => {
  const f = fixture();
  await f.batch.execute("owner_1", scope, { operation: "batch_start", maxThreads: 100 });
  await f.batch.pause("owner_1", scope);
  const current = { ...scope, runId: "run_small" };
  const start = await f.batch.execute("owner_1", current, { operation: "batch_start", maxThreads: 1 });
  expect(start).toMatchObject({ status: "ready", maxThreads: 1 });
  expect(await next(f, start.jobId, current)).toMatchObject({ status: "limit_reached", processed: 1 });
  await next(f, start.jobId, current);
  expect(f.process).toHaveBeenCalledOnce();
});
it("an old run closing cannot pause the ready checkpoint taken over by a new authorized run", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  await f.batch.pause("owner_1", scope);
  const fresh = { ...scope, runId: "run_new" };
  await f.batch.execute("owner_1", fresh, { operation: "batch_resume", jobId: start.jobId });
  await f.batch.pause("owner_1", scope);
  expect(await f.batch.execute("owner_1", fresh, { operation: "batch_status", jobId: start.jobId })).toMatchObject({ status: "ready" });
});
it("narrowing an in-flight batch revokes its old claim before later work and limits the new request", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start", maxThreads: 100 });
  const barrier = Promise.withResolvers<void>();
  f.process.mockImplementationOnce(async (thread, _signal, authorize) => { await barrier.promise; await authorize(); return { kind: "labeled", threadId: thread, messageCount: 1, labels: [] }; });
  const old = next(f, start.jobId).catch(() => null);
  await vi.waitFor(() => expect(f.process).toHaveBeenCalledOnce());
  const current = { ...scope, runId: "run_narrow" };
  const bounded = await f.batch.execute("owner_1", current, { operation: "batch_start", maxThreads: 1 });
  expect(bounded).toMatchObject({ status: "limit_reached", maxThreads: 1, unconfirmed: 1 });
  barrier.resolve();
  await old;
  await f.batch.pause("owner_1", scope);
  expect(await f.batch.execute("owner_1", current, { operation: "batch_status", jobId: start.jobId })).toMatchObject({ status: "limit_reached", processed: 1 });
  expect(f.process).toHaveBeenCalledOnce();
});
it("ready checkpoint ownership changes on resume, denying old-run continuation and late cleanup", async () => {
  const f = fixture();
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  const fresh = { ...scope, runId: "run_takeover" };
  const resumed = await f.batch.execute("owner_1", fresh, { operation: "batch_resume", jobId: start.jobId });
  await expect(f.batch.execute("owner_1", scope, { operation: "batch_next", jobId: start.jobId, revision: resumed.revision })).rejects.toThrow();
  await f.batch.pause("owner_1", scope);
  expect(await f.batch.execute("owner_1", fresh, { operation: "batch_status", jobId: start.jobId })).toMatchObject({ status: "ready" });
  expect(f.read).not.toHaveBeenCalled();
});

it("counts confirmed Review labeling as labeled threads and messages", async () => {
  const f = fixture();
  f.process.mockResolvedValueOnce({ kind: "labeled", messageCount: 2, labels: ["00 • Jev/Z Review"] } as never);
  const start = await f.batch.execute("owner_1", scope, { operation: "batch_start" });
  expect(await next(f, start.jobId)).toMatchObject({ processed: 1, labeled: 1, review: 0, preview: 0, messagesLabeled: 2 });
});
