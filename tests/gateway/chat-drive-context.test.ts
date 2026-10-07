import { describe, expect, it, vi } from "vitest";
import { CanonicalCreateChatTurnRequestSchema, CanonicalChatMessagePartSchema, ChatRunContextSchema } from "@matrix-os/contracts";
import { ChatAgentContext, contextPrompt } from "../../packages/gateway/src/chat/agent-context.js";
const owner = { type: "personal" as const, ownerId: "user_owner" };
const drive = { kind: "drive" as const, organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001" };
const mention = { type: "resource_reference" as const, resource: { kind: "organization_drive" as const, id: drive.scopeId, label: "A renderer label grants nothing", drive } };
const input = { clientRequestId: "req_drive", baseRevision: 0, parts: [{ type: "text" as const, text: "Summarize our plans" }, mention], selection: { instanceId: "claude_default", model: "model" }, interactionMode: "default", permissionMode: "supervised" };
function fixture() {
    const authorize = vi.fn(async () => undefined);
    const assertChatReferenceAllowed = vi.fn(async () => undefined);
    const drives = { authorize };
    const repository = { getDetailPage: vi.fn(async () => ({ record: { chat: { id: "chat_company", title: "Plans", lifecycle: "active", messageCount: 0 } }, messages: [], runs: [] })), get: vi.fn(async () => ({ chat: { id: "chat_company", lifecycle: "active" } })) };
    const context = new ChatAgentContext({ repository: repository as never, agents: { get: async () => null } as never, enabled: () => true, drives, assertChatReferenceAllowed });
    return { context, authorize, repository, assertChatReferenceAllowed };
}
describe("canonical company drive context admission", () => {
    it("accepts a typed drive reference and rejects forged scope identity", () => {
        expect(CanonicalChatMessagePartSchema.safeParse(mention).success).toBe(true);
        expect(CanonicalChatMessagePartSchema.safeParse({ ...mention, resource: { ...mention.resource, id: "other" } }).success).toBe(false);
        expect(CanonicalChatMessagePartSchema.safeParse({ ...mention, resource: { ...mention.resource, kind: "file" } }).success).toBe(false);
    });
    it("caps drive selections and rejects duplicates without removing legitimate text", () => {
        expect(CanonicalCreateChatTurnRequestSchema.safeParse(input).success).toBe(true);
        expect(CanonicalCreateChatTurnRequestSchema.safeParse({ ...input, parts: [mention, mention] }).success).toBe(false);
    });
    it("authorizes exact references and persists references without loading file text into a prompt", async () => {
        const f = fixture();
        const prepared = await f.context.prepare(owner, "chat_company", input);
        expect(f.authorize).toHaveBeenCalledWith(owner, "chat_company", [drive]);
        expect(prepared.context).toMatchObject({ drives: [drive], chats: [] });
        const prompt = contextPrompt("Summarize our plans", prepared.context);
        expect(prompt).toContain("search_company_drive");
        expect(prompt).toContain("read_company_drive_file");
        expect(prompt).not.toContain(mention.resource.label);
    });
    it("fails closed when no drive authorization dependency is registered", async () => {
        const f = fixture();
        const context = new ChatAgentContext({ repository: f.repository as never, agents: { get: async () => null } as never, enabled: () => true });
        await expect(context.prepare(owner, "chat_company", input)).rejects.toMatchObject({ code: "context_unavailable" });
    });
    it("does not copy company-drive Chat history into an unmarked destination", async () => {
        const f = fixture();
        f.assertChatReferenceAllowed.mockRejectedValueOnce(new Error("Drive audience unavailable"));
        await expect(f.context.prepare(owner, "chat_company", { ...input, parts: [input.parts[0]!, { type: "resource_reference", resource: { kind: "chat", id: "chat_source", label: "Source" } }] })).rejects.toThrow();
        expect(f.assertChatReferenceAllowed).toHaveBeenCalledWith(owner, "chat_source");
    });
    it("revalidates drive permissions for a queued dispatch or retry", async () => {
        const f = fixture();
        const context = ChatRunContextSchema.parse({ version: 1, requestHash: "a".repeat(64), chats: [], drives: [drive] });
        await f.context.revalidate(owner, "chat_company", context);
        expect(f.authorize).toHaveBeenCalledWith(owner, "chat_company", [drive]);
        f.authorize.mockRejectedValueOnce(new Error("member revoked"));
        await expect(f.context.revalidate(owner, "chat_company", context)).rejects.toMatchObject({ code: "context_unavailable" });
    });
});
