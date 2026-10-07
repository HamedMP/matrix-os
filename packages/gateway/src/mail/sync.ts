import { createHash } from "node:crypto";
import type { MailGmailAdapter, RetainedMail } from "./gmail.js";
export interface MailSyncState {
    completedAt?: string;
    lastError?: "sync_unavailable";
    failureAt?: string;
    revision: number;
    phase: "backfill" | "history";
    from: number;
    until: number;
    cursor?: string;
    startHistoryId?: string;
    pageToken?: string;
    /** Durable position inside the current provider page. */
    pageOffset?: number;
    pageFingerprint?: string;
}
export interface MailSyncStore {
    load(): Promise<MailSyncState>;
    /** CAS requires an exact account worker lease; callers never hold a transaction across source calls. */
    checkpoint(baseRevision: number, state: MailSyncState): Promise<void>;
    hasContent(messageId: string): Promise<boolean>;
    isSuppressed(messageId: string): Promise<boolean>;
    save(mail: RetainedMail): Promise<void>;
    updateLabels(messageId: string, labels: string[]): Promise<void>;
}
/** One bounded run, shared behind the repository's account job lease. */
export async function runMailSync(options: {
    gmail: MailGmailAdapter;
    store: MailSyncStore;
    expectedEmail: string;
    signal?: AbortSignal;
    followNewMail?: boolean;
    now?: () => number;
}) {
    let state = await options.store.load();
    let processed = 0, savedCount = 0, pages = 0;
    const seenTokens = new Set<string>();
    const profile = await options.gmail.profile();
    if (profile.emailAddress.toLowerCase() !== options.expectedEmail.toLowerCase())
        throw new Error("Mail binding changed");
    if (!Number.isSafeInteger(state.from) || !Number.isSafeInteger(state.until) || state.from < 0 || state.until <= state.from || !Number.isSafeInteger(state.pageOffset ?? 0) || (state.pageOffset ?? 0) < 0 || (state.pageOffset ?? 0) > 500)
        throw new Error("Mail range invalid");
    async function checkpoint(next: MailSyncState) {
        await options.store.checkpoint(state.revision, next);
        state = { ...next, revision: state.revision + 1 };
    }
    async function identifyPage(items: unknown[]) {
        const pageFingerprint = createHash("sha256").update(JSON.stringify(items)).digest("hex");
        // Provider pages can shift after arrivals/deletions. Positions are reusable
        // only while the ordered identities and change types remain identical.
        if (state.pageFingerprint !== pageFingerprint)
            await checkpoint({ ...state, pageFingerprint, pageOffset: 0 });
    }
    async function importMessage(id: string, history = false) {
        options.signal?.throwIfAborted();
        if (await options.store.isSuppressed(id))
            return;
        if (await options.store.hasContent(id)) {
            const meta = await options.gmail.metadata(id);
            await options.store.updateLabels(id, meta.labelIds);
            return;
        }
        const mail = await options.gmail.message(id);
        // Gmail queries are coarse seconds; reject content beyond the precise requested window.
        if (mail.receivedAt >= state.from && (mail.receivedAt < state.until || history && options.followNewMail !== false)) {
            await options.store.save(mail);
            savedCount++;
        }
    }
    if (state.phase === "backfill" && !state.startHistoryId)
        await checkpoint({ ...state, startHistoryId: profile.historyId });
    while (processed < 500 && pages++ < 10) {
        options.signal?.throwIfAborted();
        if (state.pageToken) {
            if (seenTokens.has(state.pageToken))
                throw new Error("Mail page cycle");
            seenTokens.add(state.pageToken);
        }
        if (state.phase === "backfill") {
            const page = await options.gmail.messages(`after:${Math.floor(state.from / 1000)} before:${Math.ceil(state.until / 1000)}`, state.pageToken);
            await identifyPage(page.messages.map(message => message.id));
            for (let offset = state.pageOffset ?? 0; offset < page.messages.length; offset++) {
                if (processed >= 500)
                    return { savedCount, processed, state: state.phase };
                await importMessage(page.messages[offset].id);
                processed++;
                await checkpoint({ ...state, pageOffset: offset + 1 });
            }
            if (page.nextPageToken)
                await checkpoint({ ...state, pageToken: page.nextPageToken, pageOffset: 0, pageFingerprint: undefined });
            else {
                await checkpoint({ ...state, phase: "history", cursor: state.startHistoryId, pageToken: undefined, pageOffset: 0, pageFingerprint: undefined });
                seenTokens.clear();
            }
        }
        else {
            if (!state.cursor)
                throw new Error("Mail cursor missing");
            let page;
            try {
                page = await options.gmail.history(state.cursor, state.pageToken);
            }
            catch (error) {
                if (error instanceof Error && "code" in error && error.code === "history_expired") {
                    const now = options.now?.() ?? Date.now();
                    if (!Number.isSafeInteger(now) || now < 0)
                        throw new Error("Mail recovery time invalid");
                    await checkpoint({ ...state, phase: "backfill", cursor: undefined, startHistoryId: profile.historyId, pageToken: undefined, pageOffset: 0, pageFingerprint: undefined, until: options.followNewMail === false ? state.until : Math.max(state.until, now) });
                    return { savedCount, processed, state: state.phase };
                }
                throw error;
            }
            const changes = new Map<string, boolean>();
            for (const event of page.history) {
                for (const entry of event.messagesAdded ?? []) {
                    changes.set(entry.message.id, true);
                    if (changes.size > 500)
                        throw new Error("Mail history page exceeds run limit");
                }
                for (const entry of [...event.labelsAdded ?? [], ...event.labelsRemoved ?? []]) {
                    if (!changes.has(entry.message.id)) {
                        changes.set(entry.message.id, false);
                        if (changes.size > 500)
                            throw new Error("Mail history page exceeds run limit");
                    }
                }
                // Source deletion does not delete the retained owner copy and does not refetch a missing source.
                for (const entry of event.messagesDeleted ?? [])
                    changes.delete(entry.message.id);
            }
            const entries = [...changes];
            await identifyPage(entries);
            for (let offset = state.pageOffset ?? 0; offset < entries.length; offset++) {
                if (processed >= 500)
                    return { savedCount, processed, state: state.phase };
                const [id, added] = entries[offset];
                options.signal?.throwIfAborted();
                if (!await options.store.isSuppressed(id)) {
                    if (added)
                        await importMessage(id, true);
                    else if (await options.store.hasContent(id)) {
                        const meta = await options.gmail.metadata(id);
                        await options.store.updateLabels(id, meta.labelIds);
                    }
                }
                processed++;
                await checkpoint({ ...state, pageOffset: offset + 1 });
            }
            // History start remains fixed across pages; advancing it early loses later changes.
            if (page.nextPageToken)
                await checkpoint({ ...state, pageToken: page.nextPageToken, pageOffset: 0, pageFingerprint: undefined });
            else {
                await checkpoint({ ...state, cursor: page.historyId, startHistoryId: undefined, pageToken: undefined, pageOffset: 0, pageFingerprint: undefined });
                break;
            }
        }
    }
    return { savedCount, processed, state: state.phase };
}
