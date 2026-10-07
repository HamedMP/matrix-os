import { z } from "zod/v4";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const historyId = z.string().min(1).max(20).regex(/^\d+$/);
const token = z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/);
const labels = z.array(id).max(100);
const reference = z.object({ id, threadId: id.optional() });
const metadata = z.object({ id, labelIds: labels.default([]), historyId: historyId.optional() });
const messageSchema = metadata.extend({ internalDate: z.string().regex(/^\d+$/).optional(),
    threadId: id.optional(), snippet: z.string().max(65536).optional(), payload: z.unknown().optional() }).passthrough();
const change = z.object({ message: metadata });
const historySchema = z.object({ historyId, nextPageToken: token.optional(), history: z.array(z.object({
        id: historyId, messagesAdded: z.array(change).max(500).optional(), messagesDeleted: z.array(change).max(500).optional(),
        labelsAdded: z.array(change.extend({ labelIds: labels })).max(500).optional(),
        labelsRemoved: z.array(change.extend({ labelIds: labels })).max(500).optional(),
    })).max(100).default([]) });
export type MailHistoryPage = z.infer<typeof historySchema>;
export interface RetainedMail {
    messageId: string;
    threadId?: string;
    subject: string;
    sender: string;
    receivedAt: number;
    labels: string[];
    text: string;
    html: string;
    source: unknown;
    partialReason?: "content_too_large";
}
class MailContentLimitError extends Error {
    readonly code = "content_limit";
    constructor() {
        super("Mail content exceeded its limit");
        this.name = "MailContentLimitError";
    }
}
export type MailGmailTransport = (action: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
/** The transport is already bound to one owner and immutable connector account. */
export function createMailGmailAdapter(options: {
    transport: MailGmailTransport;
    authorize(): Promise<void>;
    signal?: AbortSignal;
}) {
    async function call(action: string, params: Record<string, unknown>) {
        await options.authorize();
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
        signal.throwIfAborted();
        return options.transport(action, params, signal);
    }
    return {
        async profile() {
            return z.object({ emailAddress: z.email().max(320), historyId }).parse(await call("get_profile", {}));
        },
        async messages(query: string, pageToken?: string) {
            return z.object({ messages: z.array(reference).max(100).default([]), nextPageToken: token.optional() })
                .parse(await call("search", { query: z.string().max(4096).parse(query), maxResults: 100, ...(pageToken ? { pageToken: token.parse(pageToken) } : {}) }));
        },
        async history(startHistoryId: string, pageToken?: string) {
            return historySchema.parse(await call("list_history", { startHistoryId: historyId.parse(startHistoryId), maxResults: 100, ...(pageToken ? { pageToken: token.parse(pageToken) } : {}) }));
        },
        async message(messageId: string) {
            const requestedId = id.parse(messageId);
            let saved: RetainedMail;
            try {
                const raw = await call("get_message", { messageId: requestedId });
                saved = normalizeGmailMessage(raw);
            }
            catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "content_limit"))
                    throw error;
                const raw = await call("get_message_summary", { messageId: requestedId });
                const summary = messageSchema.extend({ internalDate: z.string().regex(/^\d+$/) }).parse(raw);
                // The summary endpoint has a fixed metadata projection; ignore unexpected body fields.
                const summaryHeaders = partSchema.parse(summary.payload ?? {}).headers ?? [];
                saved = { ...normalizeGmailMessage({ ...summary, payload: { headers: summaryHeaders } }), source: raw, partialReason: "content_too_large" };
            }
            if (saved.messageId !== messageId)
                throw new Error("Mail identity mismatch");
            return saved;
        },
        async metadata(messageId: string) {
            const result = metadata.parse(await call("get_metadata", { messageId: id.parse(messageId) }));
            if (result.id !== messageId)
                throw new Error("Mail identity mismatch");
            return result;
        },
        async archive(messageId: string) {
            await call("modify_message", { messageId: id.parse(messageId), removeLabelIds: ["INBOX"] });
        },
        async restoreInbox(messageId: string) {
            await call("modify_message", { messageId: id.parse(messageId), addLabelIds: ["INBOX"] });
        },
    };
}
export type MailGmailAdapter = ReturnType<typeof createMailGmailAdapter>;
const partSchema = z.object({ mimeType: z.string().max(256).optional(), filename: z.string().max(1024).optional(),
    headers: z.array(z.object({ name: z.string().max(256), value: z.string().max(8192) })).max(200).optional(),
    body: z.object({ data: z.string().max(3 * 1024 * 1024).optional(), attachmentId: z.string().max(512).optional() }).optional(), parts: z.array(z.unknown()).max(100).optional() });
export function normalizeGmailMessage(raw: unknown): RetainedMail {
    const source = messageSchema.parse(raw);
    let bytes = 0;
    let count = 0;
    const texts: string[] = [];
    const html: string[] = [];
    function walk(value: unknown, depth: number) {
        if (depth > 20 || ++count > 500)
            throw new MailContentLimitError();
        if (value && typeof value === "object") {
            const candidate = value as {
                parts?: unknown;
                body?: {
                    data?: unknown;
                };
            };
            if (Array.isArray(candidate.parts) && candidate.parts.length > 100 || typeof candidate.body?.data === "string" && candidate.body.data.length > 3 * 1024 * 1024)
                throw new MailContentLimitError();
        }
        const part = partSchema.parse(value);
        if (part.body?.data && !part.filename && !part.body.attachmentId && ["text/plain", "text/html"].includes(part.mimeType ?? "")) {
            const decoded = Buffer.from(part.body.data, "base64url");
            bytes += decoded.byteLength;
            if (bytes > 2 * 1024 * 1024)
                throw new MailContentLimitError();
            (part.mimeType === "text/plain" ? texts : html).push(decoded.toString("utf8"));
        }
        for (const child of part.parts ?? [])
            walk(child, depth + 1);
    }
    if (source.payload)
        walk(source.payload, 0);
    const headers = source.payload ? partSchema.parse(source.payload).headers ?? [] : [];
    const header = (name: string) => headers.find(h => h.name.toLowerCase() === name)?.value ?? "";
    const receivedAt = Number(source.internalDate ?? "0");
    if (!Number.isSafeInteger(receivedAt))
        throw new Error("Mail date invalid");
    return { messageId: source.id, threadId: source.threadId, subject: header("subject"), sender: header("from"), receivedAt,
        labels: source.labelIds, text: texts.join("\n"), html: html.join("\n"), source: raw };
}
