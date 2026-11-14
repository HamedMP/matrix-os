import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { DevstackCliBinding } from './devstack-cli-pairing.js';
import type { DevstackSourceReceipt } from './devstack-cli-routes.js';
import type { DevstackSourceDelta } from './devstack-source-delta.js';
import { devstackSourceReceiptSchema } from './devstack-publisher-client.js';
import { devstackWorktreePreviewRoot } from './devstack-preview-path.js';
import { emptyDevstackResult, type DevstackRunResult } from './devstack-runs/execute.js';
import type { DevstackRunRecord, DevstackRunStore } from './devstack-runs/store.js';

export const devstackSourceRunId = z.uuidv4().refine(value => value === value.toLowerCase());
export const devstackSourceRunKey = z.string().length(64).regex(/^[a-f0-9]+$/);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function bindingDigest(binding: DevstackCliBinding) {
  return digest(JSON.stringify([binding.owner, binding.runtime, binding.worktree, binding.handle, binding.containerId, binding.sourceIdentity]));
}
function view(record: DevstackRunRecord) {
  return { runId: record.runId, runtime: record.runtime, worktree: record.worktree, status: record.status,
    ...(record.sourceReceipt && { receipt: devstackSourceReceiptSchema.parse(record.sourceReceipt) }) };
}
type Publish = (binding: DevstackCliBinding, delta: DevstackSourceDelta, assertCurrent: () => Promise<void>, signal: AbortSignal) => Promise<DevstackSourceReceipt>;

/** Durable admission uses the existing run store; uploaded code never sees it. */
export function createDevstackSourceRuns({ store, origin, publish }: { store: DevstackRunStore; origin: string; publish: Publish }) {
  const jobs = new Set<{ controller: AbortController; done: Promise<void> }>(); // <=4 including pending admissions; removed on settle, drained on close.
  let closing = false;
  async function read(runId: string, key: string, binding: DevstackCliBinding, assertCurrent: () => Promise<void>) {
    await assertCurrent();
    const record = await store.read(runId, binding.owner, digest(key));
    if (!record || record.kind !== 'source' || record.sourceBindingDigest !== bindingDigest(binding)) return;
    await assertCurrent();
    return view(record);
  }
  return {
    read,
    async start(runId: string, key: string, binding: DevstackCliBinding, delta: DevstackSourceDelta,
      assertCurrent: () => Promise<void>, assertAdmitted: () => Promise<void>) {
      await assertCurrent();
      const keyDigest = digest(key), sourceBindingDigest = bindingDigest(binding);
      const requestDigest = digest(JSON.stringify([sourceBindingDigest, delta]));
      const prior = await store.read(runId, binding.owner, keyDigest);
      if (prior) {
        if (prior.kind !== 'source' || prior.sourceBindingDigest !== sourceBindingDigest) return { outcome: 'missing' as const };
        await assertCurrent();
        return prior.requestDigest === requestDigest ? { outcome: 'replay' as const, result: view(prior) } : { outcome: 'conflict' as const };
      }
      if (closing || jobs.size >= 4) return { outcome: 'capacity' as const };
      const controller = new AbortController();
      let settled!: () => void;
      const job = { controller, done: new Promise<void>(resolve => { settled = resolve; }) };
      jobs.add(job);
      const timer = setTimeout(() => controller.abort(), 120_000);
      const release = () => { clearTimeout(timer); jobs.delete(job); settled(); };
      let launched = false;
      try {
        const admission = await store.admit({ runId, owner: binding.owner, keyDigest, requestDigest,
          runtime: binding.runtime, worktree: binding.worktree, containerId: binding.containerId,
          cwd: 'source:' + binding.sourceIdentity, revision: delta.base, kind: 'source', sourceBindingDigest,
          previewUrl: origin + devstackWorktreePreviewRoot(binding.worktree) });
        if (admission.outcome !== 'admitted') {
          if (admission.outcome === 'replay') {
            if (admission.record.kind !== 'source' || admission.record.sourceBindingDigest !== sourceBindingDigest) return { outcome: 'missing' as const };
            await assertCurrent();
            return { outcome: 'replay' as const, result: view(admission.record) };
          }
          return { outcome: admission.outcome };
        }
        const execute = async () => {
          let receipt: DevstackSourceReceipt | undefined;
          let result: DevstackRunResult;
          try {
            controller.signal.throwIfAborted();
            await assertAdmitted();
            receipt = devstackSourceReceiptSchema.parse(await publish(binding, delta, assertAdmitted, controller.signal));
            await assertAdmitted();
            result = { status: receipt.test.exitCode === 0 ? 'succeeded' : receipt.test.exitCode === 124 ? 'timed_out' : 'failed',
              exitCode: receipt.test.exitCode, logs: [{ stream: 'stdout', text: receipt.test.log }], truncated: false };
          } catch (error: unknown) {
            console.error('[platform] DevStack source run interrupted', error instanceof Error ? error.name : 'Unknown');
            receipt = undefined;
            result = emptyDevstackResult('interrupted');
          }
          // Unknown completion writes never cause another publication.
          await store.finish(runId, result, receipt);
        };
        launched = true;
        void execute().catch((error: unknown) => {
          console.error('[platform] DevStack source run retention failed', error instanceof Error ? error.name : 'Unknown');
        }).finally(release);
        return { outcome: 'admitted' as const, result: view(admission.record) };
      } finally { if (!launched) release(); }
    },
    async close() {
      closing = true;
      for (const job of jobs) job.controller.abort();
      await Promise.allSettled([...jobs].map(job => job.done));
    },
  };
}
