import { describe, it, expect, vi } from "vitest";
import { createMailGmailAdapter, normalizeGmailMessage } from "../../packages/gateway/src/mail/gmail.js";
describe("mail Gmail boundary", () => {
    it("checks current grant on every exact-bound request and keeps large history IDs", async () => {
        const check = vi.fn(async () => {
        });
        const transport = vi.fn(async () => ({ historyId: "9007199254740993123", history: [] }));
        const gmail = createMailGmailAdapter({ transport, authorize: check });
        expect((await gmail.history("9007199254740993122")).historyId).toBe("9007199254740993123");
        expect(transport).toHaveBeenCalledWith("list_history", { startHistoryId: "9007199254740993122", maxResults: 100 }, expect.any(AbortSignal));
        expect(check).toHaveBeenCalledOnce();
    });
    it("preserves source payload, decodes text, avoids attachment fetch", () => {
        const raw = { id: "abc", internalDate: "123", labelIds: ["INBOX"], snippet: "intro", payload: { headers: [{ name: "Subject", value: "Weekly" }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Hello ✓").toString("base64url") } }, { mimeType: "application/pdf", body: { attachmentId: "att" } }] } };
        const saved = normalizeGmailMessage(raw);
        expect(saved.text).toBe("Hello ✓");
        expect(saved.source).toEqual(raw);
        expect(saved.subject).toBe("Weekly");
    });
    it("rejects a mismatched returned message id and oversized decoded body", async () => {
        const gmail = createMailGmailAdapter({ transport: async () => ({ id: "other", labelIds: [] }), authorize: async () => {
            } });
        await expect(gmail.message("abc")).rejects.toThrow();
        expect(() => normalizeGmailMessage({ id: "abc", payload: { body: { data: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64url") }, mimeType: "text/plain" } })).toThrow();
    });
    it("fails closed on grant revocation and only permits fixed inbox mutations", async () => {
        const transport = vi.fn();
        const gmail = createMailGmailAdapter({ transport, authorize: async () => {
                throw Error("revoked");
            } });
        await expect(gmail.archive("abc")).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
    });
});
describe("Gmail evidence and mutations", () => {
    it("verifies profile, validates tokens, and restores only inbox membership", async () => {
        const transport = vi.fn(async (action: string) => action === 'get_profile' ? { emailAddress: 'me@example.com', historyId: '123' } : action === 'search' ? { messages: [{ id: 'abc' }], nextPageToken: 'next' } : action === 'get_metadata' ? { id: 'abc', labelIds: ['UNREAD'] } : {});
        const gmail = createMailGmailAdapter({ transport, authorize: async () => {
            }, signal: new AbortController().signal });
        expect((await gmail.profile()).emailAddress).toBe('me@example.com');
        expect((await gmail.messages('after:123', 'previous')).nextPageToken).toBe('next');
        expect((await gmail.metadata('abc')).labelIds).toEqual(['UNREAD']);
        await gmail.archive('abc');
        await gmail.restoreInbox('abc');
        expect(transport.mock.calls.at(-1)?.slice(0, 2)).toEqual(['modify_message', { messageId: 'abc', addLabelIds: ['INBOX'] }]);
        await expect(gmail.messages('q', 'bad token')).rejects.toThrow();
    });
    it("decodes HTML and explicitly tolerates an empty message without executing it", () => {
        expect(normalizeGmailMessage({ id: 'abc', payload: { mimeType: 'text/html', body: { data: Buffer.from('<p>Title</p>').toString('base64url') } } }).html).toBe('<p>Title</p>');
        expect(normalizeGmailMessage({ id: 'abc' }).text).toBe('');
    });
    it("rejects metadata identity confusion and excessive MIME nesting/date corruption", async () => {
        const gmail = createMailGmailAdapter({ authorize: async () => {
            }, transport: async () => ({ id: 'other', labelIds: [] }) });
        await expect(gmail.metadata('abc')).rejects.toThrow();
        let payload: any = {};
        for (let n = 0; n < 22; n++)
            payload = { parts: [payload] };
        expect(() => normalizeGmailMessage({ id: 'abc', payload })).toThrow();
        expect(() => normalizeGmailMessage({ id: 'abc', internalDate: '9007199254740999999' })).toThrow();
    });
});
it("fetches one validated complete message and passes history continuation token", async () => {
    const transport = vi.fn(async (action) => action === 'get_message' ? { id: 'abc' } : { historyId: '123', history: [] });
    const gmail = createMailGmailAdapter({ transport, authorize: async () => {
        } });
    expect((await gmail.message('abc')).messageId).toBe('abc');
    await gmail.history('122', 'next');
    expect(transport.mock.calls[1][1]).toMatchObject({ pageToken: 'next' });
});
describe('partial oversize evidence', () => {
    const summary = { id: 'abc', threadId: 'thread', internalDate: '123', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'A long edition' }, { name: 'From', value: 'Publisher' }] } };
    it('retains a safe metadata diagnostic for oversized decoded bodies and verifies summary identity', async () => {
        const transport = vi.fn(async (action) => action === 'get_message' ? { id: 'abc', internalDate: '123', payload: { mimeType: 'text/plain', body: { data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64url') } } } : summary);
        const gmail = createMailGmailAdapter({ transport, authorize: async () => {
            } });
        const mail = await gmail.message('abc');
        expect(mail.partialReason).toBe('content_too_large');
        expect(mail.text).toBe('');
        expect(mail.subject).toBe('A long edition');
        expect(transport.mock.calls[1][0]).toBe('get_message_summary');
        transport.mockImplementation(async (action) => action === 'get_message' ? Promise.reject(Object.assign(Error('limit'), { code: 'content_limit' })) : { ...summary, id: 'other' });
        await expect(gmail.message('abc')).rejects.toThrow('identity');
    });
    it('falls back only for explicit connector content limits or MIME complexity limits', async () => {
        const transport = vi.fn(async (action) => action === 'get_message' ? Promise.reject(Object.assign(Error('limit'), { code: 'content_limit' })) : summary);
        const gmail = createMailGmailAdapter({ transport, authorize: async () => {
            } });
        expect((await gmail.message('abc')).partialReason).toBe('content_too_large');
        let payload: any = {};
        for (let n = 0; n < 22; n++)
            payload = { parts: [payload] };
        transport.mockImplementation(async (action) => action === 'get_message' ? { id: 'abc', payload } : summary);
        expect((await gmail.message('abc')).partialReason).toBe('content_too_large');
        transport.mockRejectedValueOnce(Error('timeout'));
        await expect(gmail.message('abc')).rejects.toThrow('timeout');
    });
});
it('records partial metadata for a valid but excessive MIME parts array and propagates malformed/provider failures', async () => {
    const summary = { id: 'abc', internalDate: '123' };
    const transport = vi.fn(async (action) => action === 'get_message' ? { id: 'abc', payload: { parts: Array.from({ length: 101 }, () => ({})) } } : summary);
    const gmail = createMailGmailAdapter({ transport, authorize: async () => {
        } });
    expect((await gmail.message('abc')).partialReason).toBe('content_too_large');
    transport.mockImplementation(async (action) => action === 'get_message' ? { id: 'abc', payload: { mimeType: 123 } } : summary);
    await expect(gmail.message('abc')).rejects.toThrow();
    expect(transport.mock.calls.filter(([action]) => action === 'get_message_summary')).toHaveLength(1);
});
