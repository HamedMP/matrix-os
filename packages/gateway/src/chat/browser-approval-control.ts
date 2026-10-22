import { createHash, randomUUID } from "node:crypto";
import { BrowserGrantRevokeRequestSchema, CanonicalSubmitChatApprovalRequestSchema, type BrowserApprovalIdentity, type BrowserApprovalLifecycleSchema,
  type BrowserDecisionTuple, type BrowserGrantView, type CanonicalSubmitChatApprovalRequest } from "@matrix-os/contracts";
import type { z } from "zod/v4";
import type { BrowserApprovalRepository } from "./browser-approval-repository.js";
import type { SharedBrowserApprovalRequest } from "../shared-browser/approval-policy.js";
import { SharedBrowserError, type SharedBrowserBinding } from "../shared-browser/broker.js";

type Lifecycle = z.infer<typeof BrowserApprovalLifecycleSchema>;
export type BrowserApprovalControlEvent = {
  type: "approval.requested"; approvalId: string; actionDigest: string; title: string; safeDescription: string;
  risk: "medium"; allowedDecisions: ["approve", "decline", "cancel"]; browserApproval: Lifecycle;
} | { type: "approval.resolved"; approvalId: string; decision: "approve" | "decline" | "cancel";
  browserApproval: Lifecycle; browserGrant?: BrowserGrantView };
type Authority = Pick<BrowserApprovalRepository, "reserve" | "activeGrant" | "consumeGrant" | "decide" | "consume" | "invalidateLease" | "cancelChallenge" | "revoke">;
interface Pending { identity: BrowserApprovalIdentity; lifecycle: Lifecycle; signal: AbortSignal; submitting: boolean; resolutionPublished: boolean;
  finished: boolean; finish(error?: Error): void }
interface Receipt { identity: BrowserApprovalIdentity; lifecycle: Lifecycle; input: CanonicalSubmitChatApprovalRequest }
interface Run { binding: SharedBrowserBinding; epoch: string; controller: AbortController; signal: AbortSignal;
  reservationStarted: boolean; publish(event: BrowserApprovalControlEvent): Promise<void>; pending?: Pending; receipts: Map<string, Receipt>; close(): Promise<void> }
const same = (a: SharedBrowserBinding, b: SharedBrowserBinding) => Object.keys(a).every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
const unavailable = () => new SharedBrowserError("browser_changed");
const report = (error: unknown) => console.warn("[browser-approval] Control unavailable", error instanceof SharedBrowserError ? error.code : "operation_failed");

/** One fixed owner/runtime. Raw browser actions and bearer values never enter persistence. */
export function createBrowserApprovalControl(options: { ownerId: string; handle: string; runtimeSlot: string; authority: Authority; now?: () => number }) {
  const runs = new Map<string, Run>(); // <=64; close/abort/30-minute expiry, shutdown drain.
  const now = options.now ?? Date.now;
  let closed = false;
  function get(binding: SharedBrowserBinding) {
    const row = runs.get(binding.runId);
    if (closed || !row || !same(row.binding, binding) || row.signal.aborted) throw unavailable();
    return row;
  }
  function registerRun(input: { binding: SharedBrowserBinding; signal: AbortSignal; publish: Run["publish"] }) {
    if (closed || input.signal.aborted || input.binding.ownerId !== options.ownerId
      || !["codex", "claude_code", "pi"].includes(input.binding.harness) || runs.has(input.binding.runId) || runs.size >= 64) throw unavailable();
    const controller = new AbortController();
    let closing: Promise<void> | undefined;
    const row: Run = { binding: Object.freeze({ ...input.binding }), epoch: randomUUID(), controller,
      signal: AbortSignal.any([input.signal, controller.signal]), reservationStarted: false, publish: input.publish, receipts: new Map(),
      close() {
        if (closing) return closing;
        if (runs.get(row.binding.runId) === row) runs.delete(row.binding.runId);
        clearTimeout(timer); input.signal.removeEventListener("abort", abort); controller.abort();
        row.pending?.finish(unavailable()); row.receipts.clear();
        // Set before starting reserve: a concurrent close must still persist a
        // tombstone that fences a late reservation, but unused turns need none.
        return closing = row.reservationStarted ? options.authority.invalidateLease(row.binding.ownerId, row.epoch) : Promise.resolve();
      },
    };
    const abort = () => { void row.close().catch(report); };
    const timer = setTimeout(abort, 30 * 60_000); timer.unref?.();
    runs.set(input.binding.runId, row); input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    return { close: row.close };
  }
  async function authorizeAction(request: SharedBrowserApprovalRequest) {
    const row = get(request.binding);
    if (row.pending) throw unavailable();
    const signal = AbortSignal.any([row.signal, request.signal, AbortSignal.timeout(5 * 60_000)]);
    signal.throwIfAborted();
    const identity: BrowserApprovalIdentity = { ownerId: row.binding.ownerId, chatId: row.binding.chatId, runId: row.binding.runId,
      approvalId: `browser_${randomUUID().replaceAll("-", "")}`, leaseEpoch: row.epoch, challengeRevision: 0, scopeVersion: 1,
      actionDigest: createHash("sha256").update(`matrix-browser-action:v1\0${JSON.stringify(request.action)}`).digest("hex") };
    const expiresAt = now() + 5 * 60_000;
    const lifecycle: Lifecycle = { kind: "shared_chrome", leaseEpoch: row.epoch, challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(expiresAt).toISOString() };
    row.reservationStarted = true;
    try {
    await options.authority.reserve(identity, expiresAt); signal.throwIfAborted(); get(request.binding);
    const grant = await options.authority.activeGrant(identity.ownerId, identity.chatId); signal.throwIfAborted();
    if (grant) {
      await options.authority.consumeGrant(identity, grant.id, grant.revision);
      signal.throwIfAborted(); get(request.binding); return;
    }
    let resolve!: () => void, reject!: (error: Error) => void;
    const waiting = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Attach rejection handling before asynchronous event persistence.
    void waiting.catch(report);
    const pending: Pending = { identity, lifecycle, signal, submitting: false, resolutionPublished: false, finished: false,
      finish(error) { if (pending.finished) return; pending.finished = true; error ? reject(error) : resolve(); } };
    row.pending = pending;
    const abort = () => pending.finish(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    let asked = false;
    try {
      await row.publish({ type: "approval.requested", approvalId: identity.approvalId, actionDigest: identity.actionDigest,
        title: "Use Matrix Browser", safeDescription: "Allow this browser action in the Chrome profile on your Matrix computer. It may use websites you are signed into.",
        risk: "medium", allowedDecisions: ["approve", "decline", "cancel"], browserApproval: lifecycle });
      asked = true;
      if (signal.aborted) abort();
      await waiting; signal.throwIfAborted(); get(request.binding);
    } finally {
      signal.removeEventListener("abort", abort);
      if (row.pending === pending) row.pending = undefined;
      // A committed decision can fail before consuming or publishing its result
      // without aborting the run. End that exact visible request as interrupted.
      if (asked && !pending.resolutionPublished) await row.publish({ type: "approval.resolved", approvalId: identity.approvalId, decision: "cancel",
        browserApproval: { ...lifecycle, resolution: now() >= expiresAt ? "expired" : "interrupted" } }).catch(report);
    }
    } finally {
      // Cancel only this exact pending/approved challenge. Pause keeps the
      // run's epoch alive; consumed and declined decisions remain untouched.
      await options.authority.cancelChallenge(identity).catch(report);
    }
  }
  async function submit(request: { ownerId: string; chatId: string; runId: string; approvalId: string; input: unknown; proof: string }) {
    const input = CanonicalSubmitChatApprovalRequestSchema.parse(request.input);
    const row = runs.get(request.runId), browser = input.browserApproval;
    if (closed || !row || row.signal.aborted || request.ownerId !== row.binding.ownerId || request.chatId !== row.binding.chatId || !browser) throw unavailable();
    const prior = row.receipts.get(request.approvalId);
    const pending = row.pending?.identity.approvalId === request.approvalId ? row.pending : undefined;
    const identity = pending?.identity ?? prior?.identity;
    if (!identity || input.actionDigest !== identity.actionDigest || browser.leaseEpoch !== identity.leaseEpoch
      || browser.challengeRevision !== identity.challengeRevision || browser.scopeVersion !== identity.scopeVersion
      || (pending && (pending.finished || pending.submitting || pending.signal.aborted))
      || (prior && JSON.stringify(prior.input) !== JSON.stringify(input))) throw unavailable();
    const tuple: BrowserDecisionTuple = { handle: options.handle, runtimeSlot: options.runtimeSlot, actorId: identity.ownerId,
      chatId: identity.chatId, runId: identity.runId, approvalId: identity.approvalId, actionDigest: identity.actionDigest,
      leaseEpoch: identity.leaseEpoch, challengeRevision: identity.challengeRevision, scopeVersion: identity.scopeVersion,
      clientRequestId: input.clientRequestId, browserDecision: browser.decision };
    if (pending) pending.submitting = true;
    let decisionCommitted = false;
    try {
      const decision = await options.authority.decide(tuple, request.proof);
      decisionCommitted = true;
      if (!pending) return { alreadySubmitted: true };
      pending.signal.throwIfAborted(); get(row.binding);
      const allowed = browser.decision === "allow_once" || browser.decision === "allow_in_chat";
      if (allowed) await options.authority.consume(identity);
      pending.signal.throwIfAborted(); get(row.binding);
      await row.publish({ type: "approval.resolved", approvalId: identity.approvalId, decision: input.decision as "approve" | "decline" | "cancel",
        browserApproval: { ...pending.lifecycle, resolution: browser.decision === "allow_once" ? "allowed_once" : browser.decision === "allow_in_chat" ? "allowed_in_chat" : browser.decision === "not_now" ? "declined" : "cancelled" },
        ...(decision.grant ? { browserGrant: decision.grant } : {}) });
      pending.resolutionPublished = true;
      pending.signal.throwIfAborted(); get(row.binding);
      if (row.receipts.size >= 64) row.receipts.delete(row.receipts.keys().next().value!);
      row.receipts.set(identity.approvalId, { identity, lifecycle: pending.lifecycle, input });
      pending.finish(allowed ? undefined : unavailable());
      return { alreadySubmitted: false };
    } catch (error: unknown) {
      // A verified decision may already have consumed its one-call authority.
      // Persistence/consumption failure must end this call, never strand it or
      // retry the browser action under an uncertain acknowledgement.
      if (decisionCommitted) pending?.finish(unavailable());
      throw error;
    } finally { if (pending) pending.submitting = false; }
  }
  return { registerRun, authorizeAction, submit,
    activeGrant(ownerId: string, chatId: string) {
      if (closed || ownerId !== options.ownerId) throw unavailable();
      return options.authority.activeGrant(ownerId, chatId);
    },
    revokeGrant(request: { ownerId: string; chatId: string; grantId: string; input: unknown; proof: string }) {
      if (closed || request.ownerId !== options.ownerId) throw unavailable();
      const input = BrowserGrantRevokeRequestSchema.parse(request.input);
      return options.authority.revoke({ handle: options.handle, runtimeSlot: options.runtimeSlot, actorId: request.ownerId,
        chatId: request.chatId, grantId: request.grantId, ...input }, request.proof);
    },
    async close() {
      if (closed) return; closed = true;
      for (const result of await Promise.allSettled([...runs.values()].map(row => row.close()))) if (result.status === "rejected") report(result.reason);
    },
  };
}
export type BrowserApprovalControl = ReturnType<typeof createBrowserApprovalControl>;
