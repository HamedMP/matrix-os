import { mailSyncStateSchema, type MailSyncFailureInput } from "./sync-error.js";
import type { MailWorkerUsageEvent } from "./usage.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { JevServiceError, type JevService } from "../jev/service.js";
import { MailContentIntegrityError } from "./types.js";
import type { MailSource, MailSourceKey, MailSyncJob, MailMessageInput, ArchivedMessage, MailObject, MailClassification } from "./types.js";
import { classifyArchivedMail, buildMailEvidence } from "./classify.js";
import { runMailSync, type MailSyncState, type MailSyncStore } from "./sync.js";
import type { MailGmailAdapter, RetainedMail } from "./gmail.js";
export interface MailWorkerRepository {
    recordSyncFailure(input: MailSyncFailureInput): Promise<boolean>;
    getSyncJob(key: MailSourceKey): Promise<MailSyncJob | null>;
    claimSync(key: MailSourceKey & {
        workerId: string;
        leaseMs: number;
    }): Promise<(MailSyncJob & {
        token: string;
    }) | null>;
    renewSync(key: MailSourceKey & {
        token: string;
        leaseMs: number;
    }): Promise<boolean>;
    checkpointSync(key: MailSourceKey & {
        token: string;
        baseRevision: number;
        checkpoint: Record<string, unknown>;
    }): Promise<boolean>;
    completeSync(key: MailSourceKey & {
        token: string;
    }): Promise<boolean>;
    releaseSync(key: MailSourceKey & {
        token: string;
    }): Promise<boolean>;
    getSource(key: MailSourceKey): Promise<MailSource | null>;
    advanceCursor(key: MailSourceKey & {
        baseRevision: number;
        cursor: string;
    }): Promise<boolean>;
    getStoredMessage(key: MailSourceKey & {
        messageId: string;
    }): Promise<ArchivedMessage | null>;
    isSuppressed(key: MailSourceKey & {
        messageId: string;
    }): Promise<boolean>;
    saveMessage(input: MailMessageInput): Promise<{
        kind: "saved";
        message: ArchivedMessage;
    } | {
        kind: "suppressed";
    }>;
    updateLabels(key: MailSourceKey & {
        messageId: string;
        labels: string[];
    }): Promise<boolean>;
    getClassification(key: MailSourceKey & {
        messageId: string;
        fingerprint: string;
        contextKind: string;
        modelPolicyVersion: string;
    }): Promise<MailClassification | null>;
    saveClassification(key: MailSourceKey & {
        messageId: string;
        classification: MailClassification;
    }): Promise<void>;
    recordDeferredClassification(key: MailSourceKey & {
        messageId: string;
        fingerprint: string;
        contextKind: "verified" | "snippet";
        modelPolicyVersion: string;
        outcome: "unknown" | "result_expired";
    }): Promise<void>;
    listClassificationCandidates(key: MailSourceKey & {
        appId: string;
        modelPolicyVersion: string;
        limit: number;
    }): Promise<ArchivedMessage[]>;
    leaseImport(key: MailSourceKey & {
        digest: string;
    }): Promise<{
        token: string;
        namespace: string;
    }>;
    releaseObjectLease(object: MailObject & {
        token: string;
    }): Promise<void>;
}
export interface MailWorkerOptions {
    repository: MailWorkerRepository;
    objects: {
        put(namespace: string, bytes: Uint8Array): Promise<MailObject>;
        read(object: MailObject): Promise<Buffer>;
    };
    gmailForSource(source: MailSource, signal: AbortSignal): MailGmailAdapter | Promise<MailGmailAdapter>;
    jev: JevService | null;
    fundedReady(source: MailSource, signal?: AbortSignal): Promise<boolean>;
    authorize(source: MailSource, signal?: AbortSignal): Promise<void>;
    ownerId: string;
    appId?: string;
    modelPolicyVersion?: string;
    signal?: AbortSignal;
    observeUsage?(source: MailSource, event: MailWorkerUsageEvent): Promise<void> | void;
    notify?(event: {
        accountId: string;
        savedCount: number;
        classifiedCount: number;
    }): Promise<void> | void;
}
const retainedSchema = z.object({ subject: z.string(), sender: z.string(), text: z.string(), html: z.string() });
const MAX_BYTES = 2 * 1024 * 1024;
function log(error: unknown) {
    console.warn("[mail] Background classification deferred", { errorName: error instanceof Error ? error.name : "UnknownError" });
}
/** Database leases coalesce all consumers; no per-app worker process or unbounded registry. */
export function createMailWorker(options: MailWorkerOptions) {
    return {
        async sync(source: MailSource, callerSignal?: AbortSignal) {
            if (source.ownerId !== options.ownerId)
                throw new Error("Mail source denied");
            const signal = AbortSignal.any([AbortSignal.timeout(90000), ...(callerSignal ? [callerSignal] : []), ...(options.signal ? [options.signal] : [])]);
            signal.throwIfAborted();
            const key = { ownerId: source.ownerId, accountId: source.accountId };
            const job = await options.repository.claimSync({ ...key, workerId: randomUUID(), leaseMs: 120000 });
            if (!job)
                return { savedCount: 0, classifiedCount: 0, processed: 0, state: "busy" as const };
            let completed = false;
            const modelPolicy = options.modelPolicyVersion ?? "newsletter-jev-v1";
            async function guard() {
                signal.throwIfAborted();
                await options.authorize(source, signal);
                const fresh = await options.repository.getSource(key);
                if (!fresh || fresh.paused || fresh.connectionId !== source.connectionId || fresh.namespace !== source.namespace || fresh.email !== source.email)
                    throw new Error("Mail source binding changed");
                if (!await options.repository.renewSync({ ...key, token: job!.token, leaseMs: 120000 }))
                    throw new Error("Mail job lease lost");
                signal.throwIfAborted();
            }
            let state: MailSyncState;
            try {
                const persisted = job.checkpoint ? mailSyncStateSchema.parse(job.checkpoint) : null;
                state = persisted ? { ...persisted, from: Date.parse(job.rangeFrom), until: Math.max(persisted.until, Date.parse(job.rangeUntil)) } : { revision: 0, phase: "backfill", from: Date.parse(job.rangeFrom), until: Date.parse(job.rangeUntil) };
            }
            catch (error) {
                await options.repository.releaseSync({ ...key, token: job.token });
                throw error;
            }
            const store: MailSyncStore = {
                load: async () => state,
                checkpoint: async (baseRevision, next) => {
                    await guard();
                    const updated = { ...next, revision: baseRevision + 1 };
                    delete updated.lastError;
                    delete updated.failureAt;
                    if (!await options.repository.checkpointSync({ ...key, token: job.token, baseRevision, checkpoint: updated }))
                        throw new Error("Mail checkpoint conflict");
                    state = updated;
                },
                isSuppressed: async (messageId) => {
                    await guard();
                    return options.repository.isSuppressed({ ...key, messageId });
                },
                hasContent: async (messageId) => {
                    const current = await options.repository.getStoredMessage({ ...key, messageId });
                    if (!current)
                        return false;
                    // Partial entries are durable diagnostics, not repeated body-fetch loops.
                    if (current.partialReason)
                        return true;
                    if (!current.object)
                        return false;
                    try {
                        await options.objects.read(current.object);
                    }
                    catch (error) {
                        if ((error instanceof MailContentIntegrityError) ||
                            (error instanceof Error && "code" in error && error.code === "ENOENT"))
                            return false;
                        throw error;
                    }
                    await guard();
                    await options.observeUsage?.(source, "reusedBodies");
                    if (current.classification?.fingerprint === current.object.digest && current.classification.modelPolicyVersion === modelPolicy)
                        await options.observeUsage?.(source, "classificationReuse");
                    return true;
                },
                updateLabels: async (messageId, labels) => {
                    await guard();
                    await options.repository.updateLabels({ ...key, messageId, labels });
                },
                save: async (mail: RetainedMail) => {
                    await guard();
                    const bytes = Buffer.from(JSON.stringify(mail));
                    const input = { ...key, messageId: mail.messageId, threadId: mail.threadId ?? mail.messageId, subject: mail.subject.slice(0, 2000), sender: mail.sender.slice(0, 1000), receivedAt: new Date(mail.receivedAt).toISOString(), labels: mail.labels, textSnippet: mail.text.slice(0, 4000) };
                    if (mail.partialReason || bytes.length > MAX_BYTES) {
                        await options.repository.saveMessage({ ...input, object: null, partialReason: mail.partialReason ?? "content_too_large" });
                        return;
                    }
                    const digest = createHash("sha256").update(bytes).digest("hex");
                    const lease = await options.repository.leaseImport({ ...key, digest });
                    try {
                        const object = await options.objects.put(source.namespace, bytes);
                        if (object.digest !== digest || object.namespace !== lease.namespace || object.sizeBytes !== bytes.length)
                            throw new Error("Mail object integrity failed");
                        await guard();
                        await options.repository.saveMessage({ ...input, object });
                    }
                    finally {
                        await options.repository.releaseObjectLease({ namespace: lease.namespace, digest, sizeBytes: bytes.length, token: lease.token });
                    }
                },
            };
            try {
                await guard();
                const gmail = await options.gmailForSource(source, signal);
                const synced = await runMailSync({ gmail, store, expectedEmail: source.email, signal });
                let classifiedCount = 0;
                if (options.jev && await options.fundedReady(source, signal)) {
                    const candidates = await options.repository.listClassificationCandidates({ ...key, appId: options.appId ?? "edition", modelPolicyVersion: modelPolicy, limit: 20 });
                    for (const candidate of candidates.slice(0, 20)) {
                        if (signal.aborted)
                            break;
                        let deferredKey: Omit<Parameters<MailWorkerRepository["recordDeferredClassification"]>[0], "outcome"> | undefined;
                        try {
                            await guard();
                            const message = await options.repository.getStoredMessage({ ...key, messageId: candidate.messageId });
                            if (!message?.object || message.partialReason)
                                continue;
                            const mail = retainedSchema.parse(JSON.parse((await options.objects.read(message.object)).toString("utf8")));
                            const evidence = buildMailEvidence(mail);
                            const contextKind: "verified" | "snippet" = evidence.verified ? "verified" : "snippet";
                            const cacheKey = { ...key, messageId: message.messageId, fingerprint: message.object.digest, contextKind, modelPolicyVersion: modelPolicy };
                            deferredKey = { ...cacheKey, contextKind };
                            await classifyArchivedMail({ ...key, messageId: message.messageId, contentDigest: message.object.digest, mail, modelPolicy,
                                correction: message.correction === "not_newsletter" ? "excluded" : message.correction,
                                signal,
                                jev: { evaluate: async (owner, input, runSignal) => {
                                        await guard();
                                        if (!await options.fundedReady(source, signal))
                                            throw new Error("Mail funding unavailable");
                                        await options.observeUsage?.(source, "aiClassificationCalls");
                                        return options.jev!.evaluate(owner, input, runSignal);
                                    } },
                                store: { get: async () => {
                                        const cached = await options.repository.getClassification(cacheKey);
                                        if (cached) {
                                            await guard();
                                            await options.observeUsage?.(source, "classificationReuse");
                                        }
                                        return cached ? { result: cached.result, verified: cached.contextKind === "verified" } : null;
                                    }, save: async (_id, value) => {
                                        await guard();
                                        await options.repository.saveClassification({ ...key, messageId: message.messageId, classification: { fingerprint: message.object!.digest, contextKind: value.verified ? "verified" : "snippet", recipe: "email-triage-v1", modelPolicyVersion: modelPolicy, result: value.result } });
                                    } },
                            });
                            classifiedCount++;
                        }
                        catch (error) {
                            log(error);
                            if (signal.aborted)
                                break;
                            if (deferredKey && error instanceof JevServiceError && (error.code === "unknown" || error.code === "result_expired")) {
                                await guard();
                                await options.repository.recordDeferredClassification({ ...deferredKey, outcome: error.code });
                            }
                        }
                    }
                }
                await guard();
                if (state.phase === "history" && !state.pageToken && !state.startHistoryId && state.cursor) {
                    await store.checkpoint(state.revision, { ...state, completedAt: new Date().toISOString(), savedCount: synced.savedCount, classifiedCount } as MailSyncState);
                    const fresh = await options.repository.getSource(key);
                    if (!fresh)
                        throw new Error("Mail source unavailable");
                    if (fresh.cursor !== state.cursor && !await options.repository.advanceCursor({ ...key, baseRevision: fresh.revision, cursor: state.cursor }))
                        throw new Error("Mail cursor conflict");
                    if (!await options.repository.completeSync({ ...key, token: job.token }))
                        throw new Error("Mail completion conflict");
                    completed = true;
                }
                const result = { ...synced, classifiedCount };
                try {
                    await options.notify?.({ accountId: source.accountId, savedCount: result.savedCount, classifiedCount });
                }
                catch (error) {
                    log(error);
                }
                return result;
            }
            catch (error) {
                try {
                    await options.repository.recordSyncFailure({ ...key, token: job.token, baseRevision: state.revision, checkpoint: { ...state }, failureAt: new Date().toISOString() });
                }
                catch (storageError) {
                    log(storageError);
                }
                throw error;
            }
            finally {
                if (!completed)
                    await options.repository.releaseSync({ ...key, token: job.token });
            }
        },
    };
}
