import { describe, it, expect, vi } from "vitest";
import { runMailSync, type MailSyncState } from "../../packages/gateway/src/mail/sync.js";
function fixture() {
    let state: MailSyncState = { revision: 0, phase: "backfill", from: 0, until: 1000 };
    const messages = new Map();
    const store = { load: async () => state, checkpoint: vi.fn(async (old: number, next: MailSyncState) => {
            expect(old).toBe(state.revision);
            state = { ...next, revision: old + 1 };
        }), hasContent: async (id: string) => messages.has(id), isSuppressed: async () => false, save: vi.fn(async (m: any) => {
            messages.set(m.messageId, m);
        }), updateLabels: vi.fn(async () => {
        }) };
    const gmail = { profile: vi.fn(async () => ({ emailAddress: "me@example.com", historyId: "90071992547409931" })), messages: vi.fn(async () => ({ messages: [{ id: "m1" }] })), message: vi.fn(async (id: string) => ({ messageId: id, text: "Hi", html: "", subject: "Title", sender: "Sender", receivedAt: 1, labels: ["INBOX"], source: {} })), metadata: vi.fn(async (id: string) => ({ id, labelIds: ["INBOX"] })), history: vi.fn(async () => ({ historyId: "90071992547409932", history: [{ id: "90071992547409932", labelsRemoved: [{ message: { id: "m1", labelIds: [] }, labelIds: ["INBOX"] }] }] })), archive: vi.fn(), restoreInbox: vi.fn() };
    return { store, gmail, state: () => state };
}
describe("shared mail sync", () => {
    it("captures history before historical read and reuses body on replay and another consumer", async () => {
        const f = fixture();
        await runMailSync({ ...f, expectedEmail: "me@example.com" });
        await runMailSync({ ...f, expectedEmail: "me@example.com" });
        expect(f.gmail.message).toHaveBeenCalledTimes(1);
        expect(f.store.updateLabels).toHaveBeenCalled();
        expect(f.state().cursor).toBe("90071992547409932");
        expect(f.gmail.profile.mock.invocationCallOrder[0]).toBeLessThan(f.gmail.messages.mock.invocationCallOrder[0]);
    });
    it("does not advance a page after failed durable save", async () => {
        const f = fixture();
        f.store.save.mockRejectedValueOnce(Error("disk"));
        await expect(runMailSync({ ...f, expectedEmail: "me@example.com" })).rejects.toThrow("disk");
        expect(f.state().phase).toBe("backfill");
        expect(f.state().pageToken).toBeUndefined();
        expect(f.gmail.history).not.toHaveBeenCalled();
    });
    it("denies a rebound live profile before historical body calls", async () => {
        const f = fixture();
        await expect(runMailSync({ ...f, expectedEmail: "other@example.com" })).rejects.toThrow();
        expect(f.gmail.messages).not.toHaveBeenCalled();
    });
    it("never resurrects suppressed messages", async () => {
        const f = fixture();
        f.store.isSuppressed = async () => true;
        await runMailSync({ ...f, expectedEmail: "me@example.com" });
        expect(f.gmail.message).not.toHaveBeenCalled();
        expect(f.store.save).not.toHaveBeenCalled();
    });
    it("reconciles selected range on typed expired history without deletion", async () => {
        const f = fixture();
        f.gmail.history.mockRejectedValueOnce(Object.assign(Error("expired"), { code: "history_expired" }));
        expect((await runMailSync({ ...f, expectedEmail: "me@example.com" })).state).toBe("backfill");
        expect(f.state().cursor).toBeUndefined();
        expect(f.store.save).toHaveBeenCalledOnce();
    });
});
describe("incremental bounds", () => {
    it("retains mail arriving after the original historical window", async () => {
        const f = fixture();
        f.gmail.history.mockResolvedValue({ historyId: "90071992547409932", history: [{ id: "90071992547409932", messagesAdded: [{ message: { id: "new", labelIds: ["INBOX"] } }] }] } as any);
        const original = f.gmail.message.getMockImplementation()!;
        f.gmail.message.mockImplementation(async (id) => ({ ...await original(id), receivedAt: id === "new" ? 2000 : 1 }));
        await runMailSync({ ...f, expectedEmail: "me@example.com" });
        expect(f.store.save).toHaveBeenCalledTimes(2);
    });
    it("bounds empty pagination runs and leaves resumable page checkpoint", async () => {
        const f = fixture();
        let n = 0;
        f.gmail.messages.mockImplementation(async () => ({ messages: [], nextPageToken: `page_${++n}` }));
        await runMailSync({ ...f, expectedEmail: "me@example.com" });
        expect(f.gmail.messages.mock.calls.length).toBeLessThanOrEqual(10);
        expect(f.state().pageToken).toBeTruthy();
    });
});
describe("sync checkpoints and cancellation", () => {
    it("replays paginated history from one original start and checkpoints only final cursor", async () => {
        const f = fixture();
        f.gmail.history.mockResolvedValueOnce({ historyId: '90071992547409932', history: [], nextPageToken: 'next' } as any).mockResolvedValueOnce({ historyId: '90071992547409933', history: [] } as any);
        await runMailSync({ ...f, expectedEmail: 'me@example.com', signal: new AbortController().signal });
        expect(f.gmail.history.mock.calls[1]).toEqual(['90071992547409931', 'next']);
        expect(f.state().cursor).toBe('90071992547409933');
    });
    it("bounds a 500-message run and resumes at the next historical page", async () => {
        const f = fixture();
        f.store.hasContent = async () => true;
        let n = 0;
        f.gmail.messages.mockImplementation(async () => ({ messages: Array.from({ length: 100 }, (_, i) => ({ id: `m${n}_${i}` })), nextPageToken: `page${++n}` }));
        const result = await runMailSync({ ...f, expectedEmail: 'me@example.com' });
        expect(result.processed).toBe(500);
        expect(f.gmail.message).not.toHaveBeenCalled();
        expect(f.gmail.history).not.toHaveBeenCalled();
    });
    it("fails on cycles, bad ranges, missing cursors and non-expiry provider failures", async () => {
        const a = fixture();
        a.gmail.messages.mockResolvedValue({ messages: [], nextPageToken: 'same' } as any);
        await expect(runMailSync({ ...a, expectedEmail: 'me@example.com' })).rejects.toThrow('cycle');
        const b = fixture();
        b.store.load = async () => ({ revision: 0, phase: 'backfill', from: -1, until: 100 });
        await expect(runMailSync({ ...b, expectedEmail: 'me@example.com' })).rejects.toThrow('range');
        const c = fixture();
        c.store.load = async () => ({ revision: 0, phase: 'history', from: 0, until: 100 });
        await expect(runMailSync({ ...c, expectedEmail: 'me@example.com' })).rejects.toThrow('cursor');
        const d = fixture();
        d.gmail.history.mockRejectedValueOnce(Error('unavailable'));
        await expect(runMailSync({ ...d, expectedEmail: 'me@example.com' })).rejects.toThrow('unavailable');
    });
    it("never deletes owner content on source deletion or classifies out-of-window historical mail", async () => {
        const f = fixture();
        f.gmail.message.mockResolvedValue({ messageId: 'm1', text: '', html: '', subject: '', sender: '', receivedAt: 2000, labels: [], source: {} });
        f.gmail.history.mockResolvedValue({ historyId: '90071992547409932', history: [{ id: '90071992547409932', messagesAdded: [{ message: { id: 'm1', labelIds: [] } }], messagesDeleted: [{ message: { id: 'm1', labelIds: [] } }] }] } as any);
        await runMailSync({ ...f, expectedEmail: 'me@example.com' });
        expect(f.store.save).not.toHaveBeenCalled();
        expect(f.gmail.message).toHaveBeenCalledOnce();
    });
    it("stops cancellation before historical writes", async () => {
        const f = fixture();
        const controller = new AbortController();
        controller.abort();
        await expect(runMailSync({ ...f, expectedEmail: 'me@example.com', signal: controller.signal })).rejects.toThrow();
        expect(f.store.save).not.toHaveBeenCalled();
    });
});
describe("durable progress within provider pages", () => {
    it("resumes after each saved message instead of replaying a slow page forever", async () => {
        const f = fixture();
        f.gmail.messages.mockResolvedValue({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
        f.gmail.history.mockResolvedValue({ historyId: "90071992547409932", history: [] });
        const original = f.gmail.message.getMockImplementation()!;
        let calls = 0;
        f.gmail.message.mockImplementation(async (id) => {
            if (++calls > 1)
                throw Error("run timeout");
            return original(id);
        });
        await expect(runMailSync({ ...f, expectedEmail: "me@example.com" })).rejects.toThrow("run timeout");
        expect((f.state() as any).pageOffset).toBe(1);
        calls = 0;
        await expect(runMailSync({ ...f, expectedEmail: "me@example.com" })).rejects.toThrow("run timeout");
        expect((f.state() as any).pageOffset).toBe(2);
        calls = 0;
        await runMailSync({ ...f, expectedEmail: "me@example.com" });
        expect(f.store.save).toHaveBeenCalledTimes(3);
        expect(f.gmail.metadata).not.toHaveBeenCalled();
        expect((f.state() as any).pageOffset).toBe(0);
    });
    it("resumes a partially processed history page without repeating label reads", async () => {
        const f = fixture();
        f.store.load = async () => ({ ...f.state(), phase: "history", cursor: "100" });
        f.store.hasContent = async () => true;
        f.gmail.history.mockResolvedValue({ historyId: "102", history: [{ id: "102", labelsRemoved: ["m1", "m2"].map(id => ({ message: { id, labelIds: [] }, labelIds: ["INBOX"] })) }] });
        f.gmail.metadata.mockRejectedValueOnce(Error("timeout"));
        await expect(runMailSync({ ...f, expectedEmail: "me@example.com" })).rejects.toThrow();
        f.gmail.metadata.mockResolvedValueOnce({ id: "m1", labelIds: [] }).mockRejectedValueOnce(Error("timeout"));
        await expect(runMailSync({ ...f, expectedEmail: "me@example.com" })).rejects.toThrow();
        expect((f.state() as any).pageOffset).toBe(1);
        await runMailSync({ ...f, expectedEmail: "me@example.com" });
        expect(f.gmail.metadata.mock.calls.map(([id]) => id)).toEqual(["m1", "m1", "m2", "m2"]);
        expect(f.state().cursor).toBe("102");
    });
    it("extends expired history recovery to a fresh monotonic exact window", async () => {
        const f = fixture();
        f.gmail.history.mockRejectedValueOnce(Object.assign(Error("expired"), { code: "history_expired" }));
        await runMailSync({ ...f, expectedEmail: "me@example.com", now: () => 5000 } as any);
        expect(f.state().until).toBe(5000);
        expect((f.state() as any).pageOffset).toBe(0);
        const original = f.gmail.message.getMockImplementation()!;
        f.gmail.messages.mockResolvedValue({ messages: [{ id: "after_initial" }] });
        f.gmail.message.mockImplementation(async (id) => ({ ...await original(id), receivedAt: 4000 }));
        await runMailSync({ ...f, expectedEmail: "me@example.com", now: () => 3000 } as any);
        expect(f.store.save).toHaveBeenCalledWith(expect.objectContaining({ messageId: "after_initial" }));
        expect(f.state().until).toBe(5000);
    });
    it("keeps a fixed historical-only recovery window", async () => {
        const f = fixture();
        f.gmail.history.mockRejectedValueOnce(Object.assign(Error("expired"), { code: "history_expired" }));
        await runMailSync({ ...f, expectedEmail: "me@example.com", followNewMail: false, now: () => 5000 } as any);
        expect(f.state().until).toBe(1000);
    });
});
it('checkpoints a partially consumed backfill page at the per-run message limit', async () => {
    const f = fixture();
    f.store.hasContent = async () => true;
    let page = 0;
    f.gmail.messages.mockImplementation(async () => ({ messages: Array.from({ length: ++page <= 4 ? 100 : page === 5 ? 90 : 20 }, (_, i) => ({ id: `m${page}_${i}` })), nextPageToken: `p${page}` }));
    expect((await runMailSync({ ...f, expectedEmail: 'me@example.com' })).processed).toBe(500);
    expect(f.state().pageToken).toBe('p5');
    expect(f.state().pageOffset).toBe(10);
});
it('resumes a history page when the remaining run budget ends inside it', async () => {
    const f = fixture();
    f.store.hasContent = async () => true;
    f.gmail.messages.mockResolvedValue({ messages: Array.from({ length: 20 }, (_, i) => ({ id: `back${i}` })) });
    f.gmail.history.mockResolvedValue({ historyId: '200', history: [{ id: '200', labelsAdded: Array.from({ length: 500 }, (_, i) => ({ message: { id: `history${i}`, labelIds: [] }, labelIds: [] })) }] } as any);
    expect((await runMailSync({ ...f, expectedEmail: 'me@example.com' })).processed).toBe(500);
    expect(f.state().pageOffset).toBe(480);
    const prior = f.gmail.metadata.mock.calls.length;
    expect((await runMailSync({ ...f, expectedEmail: 'me@example.com' })).processed).toBe(20);
    expect(f.gmail.metadata.mock.calls.length - prior).toBe(20);
    expect(f.state().cursor).toBe('200');
});
it.each(['messagesAdded', 'labelsRemoved'])('rejects oversized history %s before unbounded calls', async (type) => {
    const f = fixture();
    f.gmail.history.mockResolvedValue({ historyId: '200', history: [{ id: '200', [type]: Array.from({ length: 501 }, (_, i) => ({ message: { id: `m${i}`, labelIds: [] }, labelIds: [] })) }] } as any);
    await expect(runMailSync({ ...f, expectedEmail: 'me@example.com' })).rejects.toThrow('limit');
    expect(f.gmail.metadata).not.toHaveBeenCalled();
});
it('fails closed for an invalid recovery clock without advancing the cursor', async () => {
    const f = fixture();
    f.gmail.history.mockRejectedValueOnce(Object.assign(Error('expired'), { code: 'history_expired' }));
    await expect(runMailSync({ ...f, expectedEmail: 'me@example.com', now: () => NaN })).rejects.toThrow('time');
    expect(f.state().cursor).toBe('90071992547409931');
});
it('replays a changed backfill page without skipping its shifted first message', async () => {
    const f = fixture();
    f.gmail.messages.mockResolvedValueOnce({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }).mockResolvedValue({ messages: [{ id: 'm2' }, { id: 'm3' }] });
    f.gmail.message.mockRejectedValueOnce(Error('first failure'));
    await expect(runMailSync({ ...f, expectedEmail: 'me@example.com' })).rejects.toThrow();
    const original = f.gmail.message.getMockImplementation()!;
    f.gmail.messages.mockResolvedValueOnce({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
    f.gmail.message.mockImplementationOnce(original).mockRejectedValueOnce(Error('timeout'));
    await expect(runMailSync({ ...f, expectedEmail: 'me@example.com' })).rejects.toThrow('timeout');
    expect(f.state().pageOffset).toBe(1);
    f.gmail.history.mockResolvedValue({ historyId: '200', history: [] });
    await runMailSync({ ...f, expectedEmail: 'me@example.com' });
    expect(f.store.save.mock.calls.map(([mail]) => mail.messageId)).toEqual(['m1', 'm2', 'm3']);
});
it('replays changed history ordering without losing unprocessed label changes', async () => {
    const f = fixture();
    f.store.load = async () => ({ ...f.state(), phase: 'history', cursor: '100' });
    f.store.hasContent = async () => true;
    const entries = ['m1', 'm2'].map(id => ({ message: { id, labelIds: [] }, labelIds: [] }));
    f.gmail.history.mockResolvedValueOnce({ historyId: '200', history: [{ id: '200', labelsRemoved: entries }] }).mockResolvedValue({ historyId: '201', history: [{ id: '200', labelsRemoved: entries }, { id: '201', messagesDeleted: [{ message: { id: 'm1', labelIds: [] } }] }] } as any);
    f.gmail.metadata.mockResolvedValueOnce({ id: 'm1', labelIds: [] }).mockRejectedValueOnce(Error('timeout'));
    await expect(runMailSync({ ...f, expectedEmail: 'me@example.com' })).rejects.toThrow('timeout');
    expect(f.state().pageOffset).toBe(1);
    await runMailSync({ ...f, expectedEmail: 'me@example.com' });
    expect(f.store.updateLabels.mock.calls.map(([id]) => id)).toEqual(['m1', 'm2']);
});
