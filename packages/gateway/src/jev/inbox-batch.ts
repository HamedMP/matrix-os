import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { JevInboxGmailIdSchema, EMAIL_TRIAGE_LABELS } from "@matrix-os/contracts";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import { boundedOperation } from "../bounded-operation.js";
import { BatchJobId, type BatchDocument, type JevInboxBatchStore } from "./inbox-batch-store.js";
export const BatchInput = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("batch_start"), maxThreads: z.number().int().min(1).max(10000).optional() }),
  z.strictObject({ operation: z.literal("batch_next"), jobId: BatchJobId, revision: z.number().int().min(1) }),
  z.strictObject({ operation: z.literal("batch_resume"), jobId: BatchJobId }),
  z.strictObject({ operation: z.literal("batch_status"), jobId: BatchJobId.optional() }),
]);
const Page = z.object({ threads: z.array(z.object({ id: JevInboxGmailIdSchema })).max(30).optional(), nextPageToken: z.string().min(1).max(4096).optional() });
export type BatchProgress = {
  kind: "batch";
  jobId: string;
  revision: number;
  status: BatchDocument["status"];
  processed: number;
  labeled: number;
  noChange: number;
  review: number;
  preview: number;
  unconfirmed: number;
  messagesLabeled: number;
  remainingQueued: number;
  hasMore: boolean;
  maxThreads: number;
  last: BatchDocument["last"];
};
export type BatchPresentation = BatchProgress | {
  kind: "batch_absent";
};
function present(d: BatchDocument): BatchProgress {
  return { kind: "batch", jobId: d.jobId, revision: d.revision, status: d.status, processed: d.items.length,
    labeled: d.items.filter(x => x.status === "labeled").length, noChange: d.items.filter(x => x.status === "no_op").length, review: d.items.filter(x => x.status === "review").length,
    preview: d.items.filter(x => x.status === "proposal").length, unconfirmed: d.items.filter(x => x.status === "unconfirmed").length,
    messagesLabeled: d.items.filter(x => x.status === "labeled").reduce((n, x) => n + x.messages, 0), remainingQueued: d.queue.length,
    hasMore: !d.listed || d.pageToken !== null, maxThreads: d.maxThreads, last: d.last };
}
const stamp = (scope: HermesJevScope) => createHash("sha256").update(JSON.stringify([scope.agentId, scope.revision, scope.account])).digest("hex");
export function createJevInboxBatch(options: {
  store: JevInboxBatchStore;
  authorize: (owner: string, scope: HermesJevScope) => Promise<void>;
  read: (owner: string, scope: HermesJevScope, action: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  process: (thread: string, signal: AbortSignal, authorize: () => Promise<void>, owner: string, scope: HermesJevScope) => Promise<unknown>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const active = new Map<string, {
    owner: string;
    scope: HermesJevScope;
    controller: AbortController;
    promise: Promise<BatchProgress>;
  }>(); // max 128; deleted in finally/close
  const presentations = new Map<string, {
    value: BatchPresentation;
    expiresAt: number;
    binding: string;
  }>(); // max 128; TTL + oldest eviction
  const key = (owner: string, scope: HermesJevScope) => JSON.stringify([owner, scope.runId]);
  function cache(owner: string, scope: HermesJevScope, value: BatchPresentation) {
    for (const [k, v] of presentations)
      if (v.expiresAt <= now())
        presentations.delete(k);
    if (presentations.size >= 128)
      presentations.delete(presentations.keys().next().value!);
    presentations.set(key(owner, scope), { value, expiresAt: now() + 35 * 60000, binding: stamp(scope) });
    return value;
  }
  function remember(owner: string, scope: HermesJevScope, d: BatchDocument) {
    const value = present(d);
    cache(owner, scope, value);
    return value;
  }
  async function load(owner: string, scope: HermesJevScope, jobId?: string) {
    await options.authorize(owner, scope);
    const d = await options.store.get(owner, scope.agentId, jobId);
    if (!d || d.ownerId !== owner || d.agentId !== scope.agentId || d.binding !== stamp(scope) || d.expiresAt <= now())
      throw new Error("Inbox batch unavailable");
    return d;
  }
  async function save(d: BatchDocument, patch: Partial<BatchDocument>) { return options.store.save({ ...d, ...patch, revision: d.revision + 1 }, d.revision); }
  function interrupted(d: BatchDocument): Partial<BatchDocument> {
    const pending = d.pending?.threadId ? d.pending : null;
    return { status: "paused", pending: null, queue: pending ? d.queue.filter(id => id !== pending.threadId) : d.queue,
      items: pending ? [...d.items, { id: pending.threadId!, status: "unconfirmed", messages: 0 }] : d.items,
      last: pending ? { threadId: pending.threadId!, status: "unconfirmed" } : d.last };
  }
  return {
    presentation(owner: string, scope: HermesJevScope): BatchPresentation | null { const v = presentations.get(key(owner, scope)); return v && v.binding === stamp(scope) && v.expiresAt > now() ? structuredClone(v.value) : null; },
    async pause(owner: string, scope: HermesJevScope) {
      for (const record of active.values())
        if (record.owner === owner && record.scope.runId === scope.runId)
          record.controller.abort();
      const remembered = presentations.get(key(owner, scope))?.value;
      const jobId = remembered?.kind === "batch" ? remembered.jobId : undefined;
      if (!jobId)
        return;
      const d = await options.store.get(owner, scope.agentId, jobId);
      if (d && d.binding === stamp(scope) && d.status !== "completed" && d.status !== "completed_with_unconfirmed" && d.status !== "limit_reached"
        && (!d.pending || d.pending.runId === scope.runId))
        await save(d, interrupted(d));
    },
    close() {
      for (const a of active.values())
        a.controller.abort();
      active.clear();
      presentations.clear();
    },
    async execute(owner: string, scope: HermesJevScope, raw: unknown, parent?: AbortSignal): Promise<BatchPresentation> {
      const input = BatchInput.parse(raw);
      parent?.throwIfAborted();
      await options.authorize(owner, scope);
      let d: BatchDocument;
      if (input.operation === "batch_start") {
        const createdAt = now();
        const jobId = "jev_batch_" + createHash("sha256").update(JSON.stringify([owner, scope.agentId, scope.runId])).digest("hex").slice(0, 32);
        d = await options.store.open({ jobId, ownerId: owner, agentId: scope.agentId, binding: stamp(scope), revision: 1, status: "ready", maxThreads: input.maxThreads ?? 10000,
          createdAt, expiresAt: createdAt + 7 * 86400000, queue: [], pageToken: null, listed: false, items: [], pages: [], pending: null, last: null });
        return remember(owner, scope, d);
      }
      if (input.operation === "batch_status" && !input.jobId && !await options.store.get(owner, scope.agentId))
        return cache(owner, scope, { kind: "batch_absent" });
      d = await load(owner, scope, input.jobId);
      if (input.operation === "batch_status")
        return remember(owner, scope, d);
      if (input.operation === "batch_resume") {
        if (d.status === "running") {
          active.get(d.jobId)?.controller.abort();
          d = await save(d, interrupted(d));
        }
        if (d.status === "paused")
          d = await save(d, { status: "ready" });
        return remember(owner, scope, d);
      }
      if (d.status === "ready" && d.items.length >= d.maxThreads) {
        d = await save(d, { status: "limit_reached" });
        return remember(owner, scope, d);
      }
      const running = active.get(d.jobId);
      if (running)
        return running.promise;
      if (input.revision !== d.revision)
        return remember(owner, scope, d);
      if (d.status !== "ready")
        return remember(owner, scope, d);
      if (active.size >= 128)
        throw new Error("Inbox batch capacity unavailable");
      const controller = new AbortController();
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      const attempt = randomUUID();
      const promise = boundedOperation(async (signal) => {
        const alive = async () => {
          signal.throwIfAborted();
          await options.authorize(owner, scope);
          signal.throwIfAborted();
          const fresh = await load(owner, scope, d.jobId);
          signal.throwIfAborted();
          if (fresh.status !== "running" || fresh.pending?.attempt !== attempt)
            throw new Error("Inbox batch interrupted");
        };
        // Claim before any mailbox reads/inference; CAS is the concurrency authority.
        d = await save(d, { status: "running", pending: { threadId: d.queue[0] ?? null, attempt, runId: scope.runId } });
        try {
          await alive();
          if (!d.queue.length && (!d.listed || d.pageToken)) {
            if (d.pages.length >= 1000) {
              d = await save(d, { status: "limit_reached", pending: null });
              return remember(owner, scope, d);
            }
            const pageHash = createHash("sha256").update(d.pageToken ?? "first-page").digest("hex");
            if (d.pages.includes(pageHash))
              throw new Error("Inbox pagination unavailable");
            const page = Page.parse(await options.read(owner, scope, "list_threads", d.pageToken ? { pageToken: d.pageToken } : {}, signal));
            await alive();
            if (page.nextPageToken && (page.nextPageToken === d.pageToken || [...d.pages, pageHash].includes(createHash("sha256").update(page.nextPageToken).digest("hex"))))
              throw new Error("Inbox pagination unavailable");
            const seen = new Set(d.items.map(x => x.id));
            const queue = [...new Set((page.threads ?? []).map(x => x.id))].filter(id => !seen.has(id));
            d = await save(d, { pages: [...d.pages, pageHash], queue, pageToken: page.nextPageToken ?? null, listed: true, pending: { threadId: queue[0] ?? null, attempt, runId: scope.runId } });
          }
          if (!d.queue.length) {
            d = await save(d, { status: d.pageToken ? "ready" : d.items.some(x => x.status === "unconfirmed") ? "completed_with_unconfirmed" : "completed", pending: null });
            return remember(owner, scope, d);
          }
          if (d.items.length >= d.maxThreads) {
            d = await save(d, { status: "limit_reached", pending: null });
            return remember(owner, scope, d);
          }
          const threadId = d.queue[0]!;
          // Persist the target before dispatch, then remove it only together with its final outcome.
          d = await save(d, { pending: { threadId, attempt, runId: scope.runId } });
          await alive();
          const rawResult = await options.process(threadId, signal, alive, owner, scope);
          await alive();
          const result = z.object({ kind: z.enum(["labeled", "review", "proposal", "labeling_unconfirmed"]), messageCount: z.number().int().min(0).max(4).optional(), labels: z.array(z.enum(Object.values(EMAIL_TRIAGE_LABELS))).max(8).optional(), labelingSkipped: z.enum(["preview_only", "review_required"]).optional() }).parse(rawResult);
          const status = result.kind === "labeling_unconfirmed" ? "unconfirmed" : result.labelingSkipped === "review_required" ? "review" : result.kind === "labeled" && result.labels?.length === 0 ? "no_op" : result.kind;
          const items: BatchDocument["items"] = [...d.items, { id: threadId, status, messages: result.kind === "labeled" && result.labels?.length === 0 ? 0 : result.messageCount ?? 0 }];
          const queue = d.queue.slice(1);
          const state = status === "unconfirmed" ? "paused" : !queue.length && !d.pageToken ? (items.some(x => x.status === "unconfirmed") ? "completed_with_unconfirmed" : "completed") :
            items.length >= d.maxThreads ? "limit_reached" : "ready";
          d = await save(d, { items, queue, pending: null, status: state, last: { threadId, status } });
          return remember(owner, scope, d);
        }
        catch (error) {
          console.warn("[jev-batch] Step interrupted", { errorName: error instanceof Error ? error.name : "UnknownError" });
          const current = await options.store.get(owner, scope.agentId, d.jobId);
          if (current?.pending?.attempt === attempt) {
            const patch = interrupted(current);
            // Discovery does not incur paid or mailbox writes. An uncertain thread attempt is never replayed.
            if (current.pending.threadId === null)
              patch.items = current.items;
            else
              patch.queue = current.queue.filter(id => id !== current.pending!.threadId);
            d = await save(current, patch);
          }
          else if (current)
            d = current;
          return remember(owner, scope, d);
        }
      }, 540000, signal).finally(() => {
        if (active.get(d.jobId)?.controller === controller)
          active.delete(d.jobId);
      });
      active.set(d.jobId, { owner, scope, controller, promise });
      return promise;
    }
  };
}
