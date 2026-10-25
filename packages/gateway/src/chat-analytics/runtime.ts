import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt, randomUUID } from "node:crypto";
import { AdmissionLeaseSchema, CaptureInputSchema, ChatAnalyticsTagsSchema, ChatAnalyticsUnavailable, GenerationFactsSchema,
  type AdmissionLease, type ClassificationSnapshot, type CompletedGeneration, type GenerationBinding, type GenerationFactsInput } from "./contracts.js";
import type { ChatAnalyticsStore } from "./store.js";
import { extractClassificationSnapshot } from "./snapshot.js";

const inClassifier = new AsyncLocalStorage<boolean>();
const receiptBrand: unique symbol = Symbol("ordinary-generation");
export type OrdinaryGenerationReceipt = Readonly<{ [receiptBrand]: true }>;
export interface ChatAnalyticsLimits {
  maxOutstanding: number; maxQueued: number; maxActive: number; maxPerOwner: number; maxActivePerOwner: number;
  maxSnapshotBytes: number; maxSnapshotBytesTotal: number; receiptTtlMs: number; queueTtlMs: number;
  classificationTimeoutMs: number; shutdownTimeoutMs: number; sweepIntervalMs: number;
}
const defaults: ChatAnalyticsLimits = { maxOutstanding: 64, maxQueued: 32, maxActive: 2, maxPerOwner: 4, maxActivePerOwner: 1,
  maxSnapshotBytes: 16_384, maxSnapshotBytesTotal: 262_144, receiptTtlMs: 180_000, queueTtlMs: 60_000,
  classificationTimeoutMs: 10_000, shutdownTimeoutMs: 6_000, sweepIntervalMs: 1_000 };
const maxima: ChatAnalyticsLimits = { ...defaults, maxActive: 4, maxPerOwner: 8, maxActivePerOwner: 2,
  receiptTtlMs: 300_000, queueTtlMs: 120_000, classificationTimeoutMs: 30_000, shutdownTimeoutMs: 10_000, sweepIntervalMs: 5_000 };
type RuntimeStore = Pick<ChatAnalyticsStore, "inspectAdmission" | "recordCompleted" | "revalidateGeneration" | "commitTags" | "deleteOwner" | "deleteChat">;
type Entry = {
  receipt: OrdinaryGenerationReceipt; generationId: string; binding: GenerationBinding; lease?: AdmissionLease;
  capturedAt: string; expiresAt: number; state: "admitting" | "captured" | "queued" | "active";
  snapshot: ClassificationSnapshot | null; bytes: number; sampled: boolean; controller: AbortController;
  primary?: AbortSignal; onPrimaryAbort?: () => void; completed?: CompletedGeneration;
  admissionPending?: boolean;
};

/** Trusted server composition only. This object is never mounted as a caller-controlled send route. */
export function createTransientChatClassifier(options: {
  store: RuntimeStore; classify(snapshot: ClassificationSnapshot, signal: AbortSignal): Promise<unknown>;
  enabled?: boolean; now?: () => number; randomInt?: (max: number) => number; limits?: Partial<ChatAnalyticsLimits>;
}) {
  const limits = { ...defaults, ...options.limits };
  if (typeof options.classify !== "function" || !options.store
    || ["inspectAdmission", "recordCompleted", "revalidateGeneration", "commitTags", "deleteOwner", "deleteChat"]
      .some(name => typeof options.store[name as keyof RuntimeStore] !== "function")) throw new ChatAnalyticsUnavailable();
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1 || value > maxima[key as keyof ChatAnalyticsLimits]) throw new ChatAnalyticsUnavailable();
  }
  const now = options.now ?? Date.now; const random = options.randomInt ?? randomInt;
  const entries = new Map<OrdinaryGenerationReceipt, Entry>(); // maxOutstanding; explicit release/TTL sweep.
  const queue: Entry[] = []; // maxQueued; cancelled entries are removed immediately.
  const workers = new Set<Promise<void>>(); // maxActive; retained until the real model operation settles.
  const admissions = new Set<Promise<AdmissionLease | null>>(); // maxOutstanding; pending DB work retains its receipt slot.
  let snapshotBytes = 0; let closed = false;
  function detachPrimary(entry: Entry) {
    if (entry.primary && entry.onPrimaryAbort) entry.primary.removeEventListener("abort", entry.onPrimaryAbort);
    delete entry.primary; delete entry.onPrimaryAbort;
  }
  function release(entry: Entry) {
    detachPrimary(entry); entries.delete(entry.receipt);
    const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
    snapshotBytes -= entry.bytes; entry.bytes = 0; entry.snapshot = null;
  }
  function cancelEntry(entry: Entry) {
    entry.controller.abort(); detachPrimary(entry);
    if (entry.state !== "active" && !entry.admissionPending) release(entry);
  }
  function sweep() {
    const at = now();
    for (const entry of entries.values()) if (!Number.isSafeInteger(at) || entry.expiresAt <= at) cancelEntry(entry);
    pump();
  }
  const sweepTimer = setInterval(sweep, limits.sweepIntervalMs); sweepTimer.unref();
  function current(entry: Entry) {
    return !closed && entries.get(entry.receipt) === entry && !entry.controller.signal.aborted && entry.expiresAt > now();
  }
  async function run(entry: Entry) {
    const record = entry.completed!;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!current(entry) || !await options.store.recordCompleted(record) || !current(entry) || !entry.sampled) return;
      if (!await options.store.revalidateGeneration(record) || !current(entry) || !entry.snapshot) return;
      const snapshot = entry.snapshot;
      deadline = setTimeout(() => entry.controller.abort(), limits.classificationTimeoutMs); deadline.unref();
      // Do not race away from a transport ignoring abort: its active slot stays occupied.
      const result = await inClassifier.run(true, () => options.classify(snapshot, entry.controller.signal));
      if (!current(entry)) return;
      const tags = ChatAnalyticsTagsSchema.safeParse(result);
      if (!tags.success || !await options.store.revalidateGeneration(record) || !current(entry)) return;
      await options.store.commitTags(record, tags.data, entry.controller.signal);
    } catch (error: unknown) {
      // Never log model/provider text, request identifiers, snapshots or arbitrary error names.
      if (!(error instanceof ChatAnalyticsUnavailable) && !entry.controller.signal.aborted) console.warn("[chat-analytics] Classification unavailable");
    } finally {
      if (deadline) clearTimeout(deadline); release(entry);
    }
  }
  function pump() {
    if (closed) return;
    while (workers.size < limits.maxActive) {
      const next = queue.findIndex(entry => {
        let activeOwned = 0;
        for (const other of entries.values()) if (other.state === "active" && other.binding.ownerId === entry.binding.ownerId) activeOwned++;
        return activeOwned < limits.maxActivePerOwner;
      });
      if (next < 0) break;
      const entry = queue.splice(next, 1)[0];
      if (!current(entry)) { release(entry); continue; }
      entry.state = "active";
      const work = run(entry);
      workers.add(work);
      void work.finally(() => { workers.delete(work); pump(); });
    }
  }
  function cancelMatching(predicate: (entry: Entry) => boolean) {
    for (const entry of entries.values()) if (predicate(entry)) cancelEntry(entry);
    pump();
  }
  return {
    async capture(input: unknown): Promise<OrdinaryGenerationReceipt | null> {
      if (closed || options.enabled !== true || inClassifier.getStore() === true) return null;
      const parsed = CaptureInputSchema.safeParse(input); if (!parsed.success || parsed.data.signal?.aborted) return null;
      sweep();
      let owned = 0; for (const entry of entries.values()) if (entry.binding.ownerId === parsed.data.binding.ownerId) owned++;
      if (entries.size >= limits.maxOutstanding || owned >= limits.maxPerOwner) return null;
      const at = now(); if (!Number.isSafeInteger(at) || at < 0) return null;
      const receipt: OrdinaryGenerationReceipt = Object.freeze({ [receiptBrand]: true as const });
      const entry: Entry = { receipt, generationId: randomUUID(), binding: Object.freeze({ ...parsed.data.binding }),
        capturedAt: new Date(at).toISOString(), expiresAt: at + limits.receiptTtlMs, state: "admitting", snapshot: null,
        bytes: 0, sampled: false, controller: new AbortController(), ...(parsed.data.signal ? { primary: parsed.data.signal } : {}) };
      entry.onPrimaryAbort = () => cancelEntry(entry); entry.primary?.addEventListener("abort", entry.onPrimaryAbort, { once: true });
      entries.set(receipt, entry);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        entry.admissionPending = true;
        const operation = Promise.resolve().then(() => options.store.inspectAdmission(entry.binding));
        admissions.add(operation);
        const settled = () => {
          entry.admissionPending = false; admissions.delete(operation);
          if (entry.state === "admitting" && !current(entry)) release(entry);
        };
        void operation.then(settled, settled);
        timer = setTimeout(() => entry.controller.abort(), Math.min(5_000, limits.receiptTtlMs)); timer.unref();
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new ChatAnalyticsUnavailable());
          entry.controller.signal.addEventListener("abort", onAbort, { once: true });
          if (entry.controller.signal.aborted) onAbort();
        });
        const admission = await Promise.race([operation, aborted]);
        if (!admission || !current(entry)) { release(entry); return null; }
        entry.lease = AdmissionLeaseSchema.parse(admission);
        const draw = random(10_000); if (!Number.isSafeInteger(draw) || draw < 0 || draw >= 10_000) { release(entry); return null; }
        entry.sampled = draw < admission.sampleRateBps;
        if (entry.sampled) {
          entry.snapshot = extractClassificationSnapshot(parsed.data.api, parsed.data.body, limits.maxSnapshotBytes);
          if (!entry.snapshot) { release(entry); return null; }
          entry.bytes = Buffer.byteLength(JSON.stringify(entry.snapshot));
          if (snapshotBytes + entry.bytes > limits.maxSnapshotBytesTotal) { entry.bytes = 0; release(entry); return null; }
          snapshotBytes += entry.bytes;
        }
        entry.state = "captured"; return receipt;
      } catch (error: unknown) {
        if (!(error instanceof ChatAnalyticsUnavailable) && !entry.controller.signal.aborted) console.warn("[chat-analytics] Admission unavailable");
        cancelEntry(entry); return null;
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) entry.controller.signal.removeEventListener("abort", onAbort);
      }
    },
    completed(receipt: OrdinaryGenerationReceipt, input: GenerationFactsInput): void {
      const entry = entries.get(receipt);
      if (!entry || entry.state !== "captured") return;
      if (!current(entry) || entry.primary?.aborted || !entry.lease) { cancelEntry(entry); return; }
      const parsed = GenerationFactsSchema.safeParse(input);
      if (!parsed.success || queue.length >= limits.maxQueued) { cancelEntry(entry); return; }
      detachPrimary(entry);
      entry.completed = { generationId: entry.generationId, binding: entry.binding, lease: entry.lease,
        capturedAt: entry.capturedAt, sampled: entry.sampled, facts: Object.freeze(parsed.data) };
      entry.expiresAt = now() + limits.queueTtlMs; entry.state = "queued"; queue.push(entry); pump();
    },
    cancel(receipt: OrdinaryGenerationReceipt) { const entry = entries.get(receipt); if (entry) cancelEntry(entry); pump(); },
    cancelOwner(ownerId: string) { cancelMatching(entry => entry.binding.ownerId === ownerId); },
    async deleteOwner(ownerId: string) {
      cancelMatching(entry => entry.binding.ownerId === ownerId);
      await options.store.deleteOwner(ownerId);
      cancelMatching(entry => entry.binding.ownerId === ownerId);
    },
    async deleteChat(ownerId: string, chatId: string) {
      cancelMatching(entry => entry.binding.ownerId === ownerId && entry.binding.chatId === chatId);
      await options.store.deleteChat(ownerId, chatId);
      cancelMatching(entry => entry.binding.ownerId === ownerId && entry.binding.chatId === chatId);
    },
    async whenIdle() { while (workers.size || queue.length || admissions.size) { pump(); await Promise.allSettled([...workers, ...admissions]); } },
    async close(): Promise<{ drained: boolean }> {
      closed = true; clearInterval(sweepTimer); cancelMatching(() => true);
      if (!workers.size && !admissions.size) return { drained: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...workers, ...admissions]), new Promise<void>(resolve => { timer = setTimeout(resolve, limits.shutdownTimeoutMs); })]);
        return { drained: workers.size === 0 && admissions.size === 0 };
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}
