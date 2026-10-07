import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { NEWSLETTER_POLICY_VERSION } from "./policy.js";
import type { MailGmailAdapter } from "./gmail.js";
export interface CleanupMessage {
    messageId: string;
    contentDigest: string;
    ready: boolean;
    category: string;
    revision: number;
    policyVersion: string;
}
export interface CleanupPlan {
    id: string;
    ownerId: string;
    accountId: string;
    binding: string;
    hash: string;
    expiresAt: number;
    policyVersion: string;
    messages: CleanupMessage[];
}
export interface CleanupEntry {
    messageId: string;
    state: "planned" | "dispatching" | "unknown" | "confirmed" | "skipped" | "undo_pending" | "undone";
    originalInbox?: boolean;
    labels?: string[];
}
export interface CleanupOperation {
    id: string;
    plan: CleanupPlan;
    entries: CleanupEntry[];
}
export interface CleanupStore {
    getMessage(messageId: string): Promise<CleanupMessage | null>;
    savePlan(plan: CleanupPlan): Promise<void>;
    getPlan(planId: string): Promise<CleanupPlan | null>;
    /** Unique plan ID coalesces commits; entry transition is a DB CAS, never a blind overwrite. */
    claimOperation(plan: CleanupPlan, existingOnly?: boolean): Promise<{
        id: string;
        entries: CleanupEntry[];
    }>;
    transition(operationId: string, messageId: string, from: CleanupEntry["state"], next: CleanupEntry): Promise<boolean>;
    getOperation(operationId: string): Promise<CleanupOperation | null>;
}
interface Dependencies {
    store: CleanupStore;
    gmail: Pick<MailGmailAdapter, "metadata" | "archive" | "restoreInbox">;
    authorize(): Promise<void>;
    ownerId: string;
    accountId: string;
    binding: string;
    now?: () => number;
    signal?: AbortSignal;
}
const selection = z.array(z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)).min(1).max(100).refine(ids => new Set(ids).size === ids.length);
function fingerprint(messages: CleanupMessage[], binding: string) {
    return createHash("sha256").update(JSON.stringify([binding, NEWSLETTER_POLICY_VERSION, messages.map(m => [m.messageId, m.contentDigest, m.ready, m.category, m.revision, m.policyVersion])])).digest("hex");
}
function assertScope(plan: CleanupPlan, o: Dependencies) {
    if (plan.ownerId !== o.ownerId || plan.accountId !== o.accountId || plan.binding !== o.binding || plan.policyVersion !== NEWSLETTER_POLICY_VERSION || plan.hash !== fingerprint(plan.messages, plan.binding))
        throw new Error("Cleanup plan changed");
}
function eligible(message: CleanupMessage | null): message is CleanupMessage {
    return !!message && message.ready && message.category === "newsletter" && message.policyVersion === NEWSLETTER_POLICY_VERSION;
}
function sameLabels(a: string[], b: string[]) {
    return [...a].sort().join("\0") === [...b].sort().join("\0");
}
function report(error: unknown) {
    console.warn("[mail] Label verification failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
}
export async function previewNewsletterCleanup(o: Dependencies & {
    messageIds: string[];
}) {
    await o.authorize();
    const ids = selection.parse(o.messageIds);
    const messages: CleanupMessage[] = [];
    for (const id of ids) {
        o.signal?.throwIfAborted();
        const message = await o.store.getMessage(id);
        if (!eligible(message))
            throw new Error("Cleanup content unavailable");
        messages.push(message);
    }
    const plan: CleanupPlan = { id: randomUUID(), ownerId: o.ownerId, accountId: o.accountId, binding: o.binding, hash: fingerprint(messages, o.binding), expiresAt: (o.now?.() ?? Date.now()) + 10 * 60000, policyVersion: NEWSLETTER_POLICY_VERSION, messages };
    await o.store.savePlan(plan);
    return plan;
}
async function verifyArchive(o: Dependencies, operationId: string, entry: CleanupEntry) {
    try {
        await o.authorize();
        const meta = await o.gmail.metadata(entry.messageId);
        const next: CleanupEntry = { ...entry, state: !meta.labelIds.includes("INBOX") && entry.originalInbox ? "confirmed" : "unknown", labels: meta.labelIds };
        await o.store.transition(operationId, entry.messageId, entry.state, next);
    }
    catch (error) {
        report(error);
        await o.store.transition(operationId, entry.messageId, entry.state, { ...entry, state: "unknown" });
    }
}
export async function commitNewsletterCleanup(o: Dependencies & {
    planId: string;
    expectedHash: string;
}) {
    await o.authorize();
    const plan = await o.store.getPlan(o.planId);
    if (!plan)
        throw new Error("Cleanup plan unavailable");
    assertScope(plan, o);
    if (plan.hash !== o.expectedHash)
        throw new Error("Cleanup plan expired or changed");
    const operation = await o.store.claimOperation(plan, plan.expiresAt <= (o.now?.() ?? Date.now()));
    for (const entry of operation.entries) {
        if (o.signal?.aborted)
            break;
        await o.authorize();
        if (entry.state === "dispatching" || entry.state === "unknown") {
            await verifyArchive(o, operation.id, entry);
            continue;
        }
        if (entry.state !== "planned" || plan.expiresAt <= (o.now?.() ?? Date.now()))
            continue;
        const current = await o.store.getMessage(entry.messageId);
        const original = plan.messages.find(m => m.messageId === entry.messageId);
        if (!eligible(current) || !original || current.contentDigest !== original.contentDigest || current.revision !== original.revision) {
            await o.store.transition(operation.id, entry.messageId, "planned", { ...entry, state: "skipped" });
            continue;
        }
        const before = await o.gmail.metadata(entry.messageId);
        if (!before.labelIds.includes("INBOX") || before.labelIds.includes("TRASH")) {
            await o.store.transition(operation.id, entry.messageId, "planned", { ...entry, state: "skipped", originalInbox: false });
            continue;
        }
        // Fresh writes require an unexpired preview even if earlier reads took a long time.
        if (plan.expiresAt <= (o.now?.() ?? Date.now()))
            continue;
        const intent: CleanupEntry = { ...entry, state: "dispatching", originalInbox: true, labels: before.labelIds };
        if (!await o.store.transition(operation.id, entry.messageId, "planned", intent))
            continue;
        try {
            await o.authorize();
            o.signal?.throwIfAborted();
            if (plan.expiresAt <= (o.now?.() ?? Date.now()))
                continue;
            await o.gmail.archive(entry.messageId);
        }
        catch (error) {
            report(error);
        }
        // Accepted writes are not receipts. Independent metadata confirms the fixed mutation.
        await verifyArchive(o, operation.id, intent);
    }
    return o.store.getOperation(operation.id);
}
export async function undoNewsletterCleanup(o: Dependencies & {
    operationId: string;
}) {
    await o.authorize();
    const operation = await o.store.getOperation(o.operationId);
    if (!operation)
        throw new Error("Cleanup receipt unavailable");
    assertScope(operation.plan, o);
    for (const entry of operation.entries) {
        if (o.signal?.aborted)
            break;
        await o.authorize();
        if (!entry.originalInbox || !(entry.state === "confirmed" || entry.state === "undo_pending"))
            continue;
        const current = await o.store.getMessage(entry.messageId);
        const saved = operation.plan.messages.find(message => message.messageId === entry.messageId);
        if (!current?.ready || current.contentDigest !== saved?.contentDigest)
            continue;
        const before = await o.gmail.metadata(entry.messageId);
        if (before.labelIds.includes("TRASH"))
            continue;
        if (before.labelIds.includes("INBOX")) {
            await o.store.transition(operation.id, entry.messageId, entry.state, { ...entry, state: "undone" });
            continue;
        }
        if (entry.state === "undo_pending")
            continue; // Unknown retry must never blindly redispatch.
        if (!entry.labels || !sameLabels(entry.labels, before.labelIds))
            continue;
        const pending: CleanupEntry = { ...entry, state: "undo_pending" };
        if (!await o.store.transition(operation.id, entry.messageId, entry.state, pending))
            continue;
        try {
            await o.authorize();
            o.signal?.throwIfAborted();
            await o.gmail.restoreInbox(entry.messageId);
        }
        catch (error) {
            report(error);
        }
        try {
            await o.authorize();
            const after = await o.gmail.metadata(entry.messageId);
            if (after.labelIds.includes("INBOX"))
                await o.store.transition(operation.id, entry.messageId, "undo_pending", { ...pending, state: "undone", labels: after.labelIds });
        }
        catch (error) {
            report(error);
        }
    }
    return o.store.getOperation(operation.id);
}
