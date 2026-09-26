import { randomBytes } from "node:crypto";
import { EMAIL_TRIAGE_LABELS, JevEmailTriageResultSchema, JevEmailTriageScoresSchema,
  evaluateEmailTriagePolicy } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import type { JevService } from "./service.js";
import { assembleInboxEvidence, GmailId, threadIdentity } from "./inbox-evidence.js";

const Receipt = z.string().regex(/^[a-f0-9]{64}$/);
export const InboxPreviewInput = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("discover") }),
  z.strictObject({ operation: z.literal("select"), receipt: Receipt, threadId: GmailId }),
  z.strictObject({ operation: z.literal("evaluate"), receipt: Receipt }),
]);
const Discovery = z.object({ threads: z.array(z.object({ id: GmailId, snippet: z.string().max(4096).optional() })).max(30).optional(),
  nextPageToken: z.string().max(4096).optional() });
const Profile = z.object({ emailAddress: z.email().max(320) });
const TTL = 10 * 60_000;
const MAX_RUNS = 128;
export class InboxPreviewError extends Error {
  constructor(readonly code: "denied" | "unavailable" | "invalid_request") { super("Inbox preview unavailable"); }
}
export function assertJevInboxProfile(raw: unknown, scope: HermesJevScope): void {
  const value = Profile.safeParse(raw);
  if (!value.success || value.data.emailAddress !== scope.account.expectedEmail) throw new InboxPreviewError("denied");
}
const review = () => ({ kind: "review" as const, verified: false as const, readonly: true as const,
  labels: [EMAIL_TRIAGE_LABELS.review], archiveProposal: null });
type Evidence = ReturnType<typeof assembleInboxEvidence>;
type Proposal = ReturnType<typeof review> | { kind: "proposal"; verified: true; readonly: true; threadId: string;
  messageCount: number; labels: string[]; archiveProposal: { removeLabelIds: ["INBOX"] } | null; observedAt: string; requestId: string };
type RecordState = { fingerprint: string; expiresAt: number; discoveryReceipt: string;
  discovery?: { kind: "discovery"; receipt: string; threads: { id: string; snippet: string }[]; readonly: true };
  discovering?: Promise<NonNullable<RecordState["discovery"]>>;
  selection?: { threadId: string; receipt: string; identity?: ReturnType<typeof threadIdentity>; evidence?: Evidence };
  selecting?: Promise<{ kind: "evidence"; receipt: string; threadId: string; messageCount: number; readonly: true } | ReturnType<typeof review>>;
  evaluating?: Promise<Proposal>; presentation?: Proposal };
export type JevInboxBroker = ReturnType<typeof createJevInboxBroker>;

/** Run-local bounded receipts; no model text, IDs, verification flags or scores grant authority. */
export function createJevInboxBroker(options: {
  authorize: (ownerId: string, scope: HermesJevScope) => Promise<void>;
  read: (ownerId: string, scope: HermesJevScope, action: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  evaluate: JevService["evaluate"];
  now?: () => number;
}) {
  const records = new Map<string, RecordState>();
  const now = options.now ?? Date.now;
  const key = (owner: string, run: string) => JSON.stringify([owner, run]);
  const fingerprint = (scope: HermesJevScope) => JSON.stringify([scope.agentId, scope.revision, scope.account]);
  function sweep(): void { for (const [id, record] of records) if (record.expiresAt <= now()) records.delete(id); }
  function markReview(record: RecordState) { const result = review(); record.presentation = result; return result; }
  function alive(owner: string, scope: HermesJevScope, record: RecordState, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (record.expiresAt <= now() || records.get(key(owner, scope.runId)) !== record) throw new InboxPreviewError("denied");
  }
  async function profile(owner: string, scope: HermesJevScope, record: RecordState, signal?: AbortSignal): Promise<void> {
    alive(owner, scope, record, signal);
    await options.authorize(owner, scope);
    const value = await options.read(owner, scope, "get_profile", undefined, signal);
    alive(owner, scope, record, signal);
    assertJevInboxProfile(value, scope);
  }
  return {
    presentation(ownerId: string, scope: HermesJevScope): Proposal | null {
      sweep();
      const record = records.get(key(ownerId, scope.runId));
      return record?.fingerprint === fingerprint(scope) && record.presentation ? structuredClone(record.presentation) : null;
    },
    async preflight(ownerId: string, scope: HermesJevScope, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      await options.authorize(ownerId, scope);
      const value = await options.read(ownerId, scope, "get_profile", undefined, signal);
      signal.throwIfAborted();
      assertJevInboxProfile(value, scope);
      await options.authorize(ownerId, scope);
      signal.throwIfAborted();
    },
    clearRun(ownerId: string, runId: string): void { records.delete(key(ownerId, runId)); },
    async execute(ownerId: string, scope: HermesJevScope, rawInput: unknown, signal?: AbortSignal) {
      const parsed = InboxPreviewInput.safeParse(rawInput);
      if (!parsed.success) throw new InboxPreviewError("invalid_request");
      signal?.throwIfAborted();
      await options.authorize(ownerId, scope);
      sweep();
      const input = parsed.data;
      const runKey = key(ownerId, scope.runId);
      let record = records.get(runKey);
      if (record && record.fingerprint !== fingerprint(scope)) throw new InboxPreviewError("denied");
      if (input.operation === "discover") {
        if (!record) {
          if (records.size >= MAX_RUNS) throw new InboxPreviewError("unavailable");
          record = { fingerprint: fingerprint(scope), expiresAt: now() + TTL, discoveryReceipt: randomBytes(32).toString("hex") };
          records.set(runKey, record);
        }
        const current = record;
        if (!current.discovering) {
          const attempt = (async () => {
            await profile(ownerId, scope, current, signal);
            const data = Discovery.parse(await options.read(ownerId, scope, "list_threads", {}, signal));
            alive(ownerId, scope, current, signal);
            const threads = data.threads ?? [];
            if (new Set(threads.map((t) => t.id)).size !== threads.length) throw new InboxPreviewError("unavailable");
            current.discovery = { kind: "discovery", receipt: current.discoveryReceipt, readonly: true,
              threads: threads.map((t) => ({ id: t.id, snippet: t.snippet ?? "" })) };
            return current.discovery;
          })();
          current.discovering = attempt;
          void attempt.catch((error: unknown) => {
            console.warn("[jev] Read attempt unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
            // Explicit read retries only; never clear a newer or revoked run.
            if (records.get(runKey) === current && current.expiresAt > now()
              && current.fingerprint === fingerprint(scope) && current.discovering === attempt) current.discovering = undefined;
          });
        }
        return current.discovering;
      }
      if (!record) throw new InboxPreviewError("denied");
      const current = record;
      if (input.operation === "select") {
        if (input.receipt !== current.discoveryReceipt || !current.discovery?.threads.some((t) => t.id === input.threadId)
          || (current.selection && current.selection.threadId !== input.threadId)) throw new InboxPreviewError("denied");
        if (!current.selecting) {
          const selection = { threadId: input.threadId, receipt: randomBytes(32).toString("hex") };
          current.selection = selection;
          const attempt = (async () => {
            await profile(ownerId, scope, current, signal);
            let identity: ReturnType<typeof threadIdentity>;
            try { identity = threadIdentity(await options.read(ownerId, scope, "get_thread_ids", { threadId: input.threadId }, signal), input.threadId); }
            catch (error) {
              if (error instanceof z.ZodError || (error instanceof Error && error.message === "Invalid thread evidence")) return markReview(current);
              throw error;
            }
            alive(ownerId, scope, current, signal);
            const ids = identity.messageIds.slice(-4);
            const messages: unknown[] = [];
            for (const id of ids) {
              alive(ownerId, scope, current, signal);
              messages.push(await options.read(ownerId, scope, "get_message", { messageId: id }, signal));
            }
            alive(ownerId, scope, current, signal);
            try {
              const evidence = assembleInboxEvidence(ownerId, scope, input.threadId, ids, messages, now(), identity.internalDates.slice(-4));
              current.selection = { ...selection, identity, evidence };
              return { kind: "evidence" as const, receipt: selection.receipt, threadId: input.threadId,
                messageCount: evidence.messageCount, readonly: true as const };
            } catch (error) {
              console.warn("[jev] Evidence was incomplete", { errorName: error instanceof Error ? error.name : "UnknownError" });
              return markReview(current);
            }
          })();
          current.selecting = attempt;
          void attempt.catch((error: unknown) => {
            console.warn("[jev] Read attempt unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
            if (records.get(runKey) === current && current.expiresAt > now()
              && current.fingerprint === fingerprint(scope) && current.selecting === attempt) current.selecting = undefined;
          });
        }
        return current.selecting;
      }
      const selected = current.selection;
      if (!selected?.evidence || !selected.identity || input.receipt !== selected.receipt) throw new InboxPreviewError("denied");
      if (!current.evaluating) current.evaluating = (async () => {
        await profile(ownerId, scope, current, signal);
        const identity = threadIdentity(await options.read(ownerId, scope, "get_thread_ids", { threadId: selected.threadId }, signal), selected.threadId);
        alive(ownerId, scope, current, signal);
        if (JSON.stringify(identity) !== JSON.stringify(selected.identity)) return markReview(current);
        // Recheck immediately before the sole paid call; cancellation/rebind cannot reuse this receipt.
        await options.authorize(ownerId, scope);
        alive(ownerId, scope, current, signal);
        const evidence = selected.evidence!;
        const observedAt = new Date(now()).toISOString();
        const result = JevEmailTriageResultSchema.parse(await options.evaluate(ownerId, { recipe: "email-triage-v1",
          state: evidence.state, idempotencyKey: `jev_email_triage_v1:${evidence.hash}` }, signal));
        alive(ownerId, scope, current, signal);
        await options.authorize(ownerId, scope);
        alive(ownerId, scope, current, signal);
        const scores = JevEmailTriageScoresSchema.parse(Object.fromEntries(result.answers.map((answer) => [answer.id, answer.probability])));
        const policy = evaluateEmailTriagePolicy({ scores, verified: true, ageDays: evidence.ageDays });
        const proposal = { kind: "proposal" as const, verified: true as const, readonly: true as const, threadId: selected.threadId,
          messageCount: evidence.messageCount, labels: policy.labels, archiveProposal: policy.archive, observedAt, requestId: result.requestId };
        current.presentation = proposal;
        return proposal;
      })();
      return current.evaluating;
    },
  };
}
