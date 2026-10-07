import { describe, it, expect, vi } from "vitest";
import { previewNewsletterCleanup, commitNewsletterCleanup, undoNewsletterCleanup, type CleanupPlan, type CleanupEntry } from "../../packages/gateway/src/mail/cleanup.js";
import { NEWSLETTER_POLICY_VERSION } from "../../packages/gateway/src/mail/policy.js";
function fixture() {
    let plan: CleanupPlan;
    let claimed = false;
    let entry: CleanupEntry = { messageId: "m1", state: "planned" };
    let labels = ["INBOX", "UNREAD", "Label_1"];
    const ready = { messageId: "m1", contentDigest: "a".repeat(64), ready: true, category: "newsletter", revision: 1, policyVersion: NEWSLETTER_POLICY_VERSION };
    const store = { getMessage: async () => ready, savePlan: async (p: CleanupPlan) => {
            plan = p;
        }, getPlan: async () => plan, claimOperation: async (_plan: CleanupPlan, existingOnly = false) => {
            if (existingOnly && !claimed)
                throw Error("Cleanup plan expired");
            claimed = true;
            return { id: "operation", entries: [entry] };
        }, transition: vi.fn(async (_op: string, _id: string, from: string, next: CleanupEntry) => {
            if (entry.state !== from)
                return false;
            entry = next;
            return true;
        }), getOperation: async () => ({ id: "operation", plan, entries: [entry] }) };
    const gmail = { metadata: vi.fn(async () => ({ id: "m1", labelIds: labels })), archive: vi.fn(async () => {
            labels = labels.filter(x => x !== "INBOX");
        }), restoreInbox: vi.fn(async () => {
            labels = [...labels, "INBOX"];
        }) };
    return { store, gmail, authorize: vi.fn(async () => {
        }), entry: () => entry, labels: () => labels, setLabels: (v: string[]) => {
            labels = v;
        }, now: () => 1000 };
}
async function preview(f: ReturnType<typeof fixture>) {
    return previewNewsletterCleanup({ ...f, messageIds: ["m1"], binding: "bound", ownerId: "owner", accountId: "account" });
}
describe("newsletter cleanup ledger", () => {
    it("previews exact saved content then confirms independent label readback, undo restores only INBOX", async () => {
        const f = fixture();
        const p = await preview(f);
        expect(f.gmail.archive).not.toHaveBeenCalled();
        await commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: p.hash, binding: "bound", ownerId: "owner", accountId: "account" });
        expect(f.entry().state).toBe("confirmed");
        expect(f.labels()).toEqual(["UNREAD", "Label_1"]);
        expect(f.store.transition.mock.invocationCallOrder[0]).toBeLessThan(f.gmail.archive.mock.invocationCallOrder[0]);
        await undoNewsletterCleanup({ ...f, operationId: "operation", binding: "bound", ownerId: "owner", accountId: "account" });
        expect(f.labels()).toContain("INBOX");
        expect(f.entry().state).toBe("undone");
    });
    it("retains unknown outcome and reconciles retries without a second mutation", async () => {
        const f = fixture();
        const p = await preview(f);
        f.gmail.archive.mockRejectedValueOnce(Error("timeout"));
        await commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: p.hash, binding: "bound", ownerId: "owner", accountId: "account" });
        expect(f.entry().state).toBe("unknown");
        await commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: p.hash, binding: "bound", ownerId: "owner", accountId: "account" });
        expect(f.gmail.archive).toHaveBeenCalledOnce();
    });
    it("rejects changed binding, stale plan and missing content before writes", async () => {
        const f = fixture();
        const p = await preview(f);
        await expect(commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: p.hash, binding: "rebound", ownerId: "owner", accountId: "account" })).rejects.toThrow();
        await expect(commitNewsletterCleanup({ ...f, now: () => 9999999, planId: p.id, expectedHash: p.hash, binding: "bound", ownerId: "owner", accountId: "account" })).rejects.toThrow();
        expect(f.gmail.archive).not.toHaveBeenCalled();
    });
    it("skips content changed after preview and does not overwrite fresh labels on undo", async () => {
        const f = fixture();
        const p = await preview(f);
        f.store.getMessage = async () => ({ messageId: "m1", contentDigest: "b".repeat(64), ready: true, category: "newsletter", revision: 2, policyVersion: NEWSLETTER_POLICY_VERSION });
        await commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: p.hash, binding: "bound", ownerId: "owner", accountId: "account" });
        expect(f.entry().state).toBe("skipped");
        expect(f.gmail.archive).not.toHaveBeenCalled();
    });
    it("rejects duplicate/unbounded selections and revoked access without provider writes", async () => {
        const f = fixture();
        await expect(previewNewsletterCleanup({ ...f, messageIds: ["m1", "m1"], binding: "bound", ownerId: "owner", accountId: "account" })).rejects.toThrow();
        const p = await preview(f);
        f.authorize.mockRejectedValueOnce(Error("revoked"));
        await expect(commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: p.hash, binding: "bound", ownerId: "owner", accountId: "account" })).rejects.toThrow();
        expect(f.gmail.archive).not.toHaveBeenCalled();
    });
});
describe("cleanup reconciliation and conflicting edits", () => {
    async function archived() {
        const f = fixture();
        const p = await preview(f);
        await commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: p.hash, binding: 'bound', ownerId: 'owner', accountId: 'account' });
        return { f, p };
    }
    const scope = { binding: 'bound', ownerId: 'owner', accountId: 'account' };
    it("rejects unavailable previews/plans/receipts and invalid plan digest", async () => {
        const f = fixture();
        f.store.getMessage = async () => null as any;
        await expect(preview(f)).rejects.toThrow('content');
        f.store.getPlan = async () => null as any;
        await expect(commitNewsletterCleanup({ ...f, ...scope, planId: 'missing', expectedHash: 'bad' })).rejects.toThrow('unavailable');
        f.store.getOperation = async () => null as any;
        await expect(undoNewsletterCleanup({ ...f, ...scope, operationId: 'missing' })).rejects.toThrow('unavailable');
    });
    it.each([[['UNREAD']], [['INBOX', 'TRASH']]])("skips already archived and trashed messages %j", async (labels) => {
        const f = fixture();
        const p = await preview(f);
        f.setLabels(labels);
        await commitNewsletterCleanup({ ...f, ...scope, planId: p.id, expectedHash: p.hash });
        expect(f.entry().state).toBe('skipped');
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation' });
        expect(f.gmail.restoreInbox).not.toHaveBeenCalled();
    });
    it("does not redispatch completed or concurrently claimed entries", async () => {
        const { f, p } = await archived();
        await commitNewsletterCleanup({ ...f, ...scope, planId: p.id, expectedHash: p.hash });
        expect(f.gmail.archive).toHaveBeenCalledOnce();
        const g = fixture();
        const q = await preview(g);
        g.store.transition.mockResolvedValue(false);
        await commitNewsletterCleanup({ ...g, ...scope, planId: q.id, expectedHash: q.hash });
        expect(g.gmail.archive).not.toHaveBeenCalled();
    });
    it("records unknown when independent readback fails, then settles from source evidence", async () => {
        const f = fixture();
        const p = await preview(f);
        f.gmail.metadata.mockRejectedValueOnce(Error('offline'));
        await expect(commitNewsletterCleanup({ ...f, ...scope, planId: p.id, expectedHash: p.hash })).rejects.toThrow();
        f.gmail.metadata.mockResolvedValueOnce({ id: 'm1', labelIds: ['INBOX'] }).mockRejectedValueOnce('timeout');
        await commitNewsletterCleanup({ ...f, ...scope, planId: p.id, expectedHash: p.hash });
        expect(f.entry().state).toBe('unknown');
        f.gmail.metadata.mockImplementation(async () => ({ id: 'm1', labelIds: f.labels() }));
        await commitNewsletterCleanup({ ...f, ...scope, planId: p.id, expectedHash: p.hash });
        expect(f.entry().state).toBe('confirmed');
        expect(f.gmail.archive).toHaveBeenCalledOnce();
    });
    it("does not dispatch new writes after cancellation", async () => {
        const f = fixture();
        const p = await preview(f);
        const c = new AbortController();
        c.abort();
        await commitNewsletterCleanup({ ...f, ...scope, planId: p.id, expectedHash: p.hash, signal: c.signal });
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation', signal: c.signal });
        expect(f.gmail.archive).not.toHaveBeenCalled();
    });
    it.each(['INBOX', 'TRASH', 'OTHER'])("undo respects existing inbox and conflicting label %s", async (label) => {
        const { f } = await archived();
        f.setLabels([...f.labels(), label]);
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation' });
        expect(f.gmail.restoreInbox).not.toHaveBeenCalled();
        if (label === 'INBOX')
            expect(f.entry().state).toBe('undone');
    });
    it("undo skips missing content and failed concurrent transition", async () => {
        const { f } = await archived();
        f.store.getMessage = async () => null as any;
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation' });
        expect(f.gmail.restoreInbox).not.toHaveBeenCalled();
        const { f: g } = await archived();
        g.store.transition.mockResolvedValue(false);
        await undoNewsletterCleanup({ ...g, ...scope, operationId: 'operation' });
        expect(g.gmail.restoreInbox).not.toHaveBeenCalled();
    });
    it("undo stays pending after ambiguous write and never dispatches twice", async () => {
        const { f } = await archived();
        f.gmail.restoreInbox.mockRejectedValueOnce(Error('timeout'));
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation' });
        expect(f.entry().state).toBe('undo_pending');
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation' });
        expect(f.gmail.restoreInbox).toHaveBeenCalledOnce();
        f.setLabels([...f.labels(), 'INBOX']);
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation' });
        expect(f.entry().state).toBe('undone');
    });
    it("keeps undo pending when readback is unavailable", async () => {
        const { f } = await archived();
        f.gmail.metadata.mockResolvedValueOnce({ id: 'm1', labelIds: f.labels() }).mockRejectedValueOnce(Error('offline'));
        await undoNewsletterCleanup({ ...f, ...scope, operationId: 'operation' });
        expect(f.entry().state).toBe('undo_pending');
    });
    it("uses production time and signal for active preview and undo", async () => {
        const f = fixture();
        const signal = new AbortController().signal;
        const p = await previewNewsletterCleanup({ ...f, ...scope, now: undefined, signal, messageIds: ['m1'] });
        await commitNewsletterCleanup({ ...f, ...scope, now: undefined, signal, planId: p.id, expectedHash: p.hash });
        await undoNewsletterCleanup({ ...f, ...scope, now: undefined, signal, operationId: 'operation' });
        expect(f.entry().state).toBe('undone');
    });
});
it("survives PostgreSQL JSONB key ordering in a stored preview", async () => {
    const f = fixture();
    const plan = await preview(f);
    f.store.getPlan = async () => ({ ...plan, messages: plan.messages.map(m => Object.fromEntries(Object.entries(m).reverse()) as typeof m) });
    await commitNewsletterCleanup({ ...f, planId: plan.id, expectedHash: plan.hash, binding: 'bound', ownerId: 'owner', accountId: 'account' });
    expect(f.entry().state).toBe('confirmed');
});
it("reconciles an expired unknown receipt and makes its exact archive undoable", async () => {
    const f = fixture();
    const p = await preview(f);
    const scope = { binding: "bound", ownerId: "owner", accountId: "account" };
    f.gmail.metadata.mockResolvedValueOnce({ id: "m1", labelIds: f.labels() }).mockRejectedValueOnce(Error("offline"));
    await commitNewsletterCleanup({ ...f, ...scope, planId: p.id, expectedHash: p.hash });
    expect(f.entry().state).toBe("unknown");
    await commitNewsletterCleanup({ ...f, ...scope, now: () => p.expiresAt + 1, planId: p.id, expectedHash: p.hash });
    expect(f.entry().state).toBe("confirmed");
    expect(f.gmail.archive).toHaveBeenCalledOnce();
    await undoNewsletterCleanup({ ...f, ...scope, now: () => p.expiresAt + 1, operationId: "operation" });
    expect(f.entry().state).toBe("undone");
});
it("never dispatches a planned entry in an existing expired operation", async () => {
    const f = fixture();
    const p = await preview(f);
    const scope = { binding: "bound", ownerId: "owner", accountId: "account" };
    const aborted = new AbortController();
    aborted.abort();
    await commitNewsletterCleanup({ ...f, ...scope, signal: aborted.signal, planId: p.id, expectedHash: p.hash });
    await commitNewsletterCleanup({ ...f, ...scope, now: () => p.expiresAt + 1, planId: p.id, expectedHash: p.hash });
    expect(f.entry().state).toBe("planned");
    expect(f.gmail.archive).not.toHaveBeenCalled();
    expect(f.gmail.metadata).not.toHaveBeenCalled();
});
it.each(['metadata', 'authorization'])('stops a fresh mutation if the preview expires during %s', async (step) => {
    const f = fixture();
    const p = await preview(f);
    let now = 1000;
    if (step === 'metadata')
        f.gmail.metadata.mockImplementation(async () => {
            now = p.expiresAt;
            return { id: 'm1', labelIds: f.labels() };
        });
    else
        f.authorize.mockImplementation(async () => {
            if (f.entry().state === 'dispatching')
                now = p.expiresAt;
        });
    await commitNewsletterCleanup({ ...f, now: () => now, planId: p.id, expectedHash: p.hash, binding: 'bound', ownerId: 'owner', accountId: 'account' });
    expect(f.gmail.archive).not.toHaveBeenCalled();
    expect(f.labels()).toContain('INBOX');
});
it('rejects a changed preview hash before claiming or reading source labels', async () => {
    const f = fixture();
    const p = await preview(f);
    await expect(commitNewsletterCleanup({ ...f, planId: p.id, expectedHash: 'wrong', binding: 'bound', ownerId: 'owner', accountId: 'account' })).rejects.toThrow('changed');
    expect(f.gmail.metadata).not.toHaveBeenCalled();
});
