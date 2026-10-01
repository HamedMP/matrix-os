import {sql} from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema, type CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatAgentContext } from "../../packages/gateway/src/chat/agent-context.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter, type CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
const owner = { type: "personal" as const, ownerId: "user_drive_execution" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const drive = { kind: "drive" as const, organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001" };
const mention = { type: "resource_reference" as const, resource: { kind: "organization_drive" as const, id: drive.scopeId, label: "Company", drive } };
const selection = { instanceId: "claude_drive", model: "claude-sonnet-5" };
describe("company drive canonical execution lifecycle", () => {
    let repository: ChatRepository;
    let orchestrator: CanonicalChatOrchestrator;
    let permitted: boolean;
    let failed: boolean;
    let release: (() => void) | undefined;
    let hold: Promise<void> | undefined;
    let calls: CanonicalProviderRunInput[];
    beforeEach(async () => {
        repository = new ChatRepository((await KyselyPGlite.create()).dialect);
        await repository.bootstrap();
        await repository.create(owner, { id: "chat_drive", clientRequestId: "req_create", title: "Company plans", currentSelection: selection });
        permitted = true;
        failed = false;
        hold = undefined;
        release = undefined;
        calls = [];
        const source = createCanonicalProviderCatalogFixture();
        const instance = source.instances[0]!;
        const catalog = CanonicalProviderCatalogSchema.parse({ ...source, drivers: [{ kind: "claude_code", displayName: "Claude", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }], instances: [{ ...instance, id: selection.instanceId, driverKind: "claude_code", defaultSelection: selection,
                    models: [{ ...instance.models[0]!, id: selection.model }], supports: { ...instance.supports, resources: ["organization_drive"], permissionModes: ["supervised"] } }] });
        const execute = async function* (input: CanonicalProviderRunInput) {
            calls.push(input);
            expect((await repository.getDetailPage(owner, input.chatId, { limit: 10 }))?.runs.some(run => run.id === input.runId)).toBe(true);
            if (hold)
                await hold;
            yield { type: "state.updated" as const, state: { sessionId: "session_drive" } };
            yield { type: "run.completed" as const, outcome: failed ? "failed" as const : "completed" as const };
        };
        const adapter: CanonicalChatProviderAdapter = { driverKind: "claude_code", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value, start: execute, resume: execute };
        const context = new ChatAgentContext({ repository, agents: { get: async () => null }, enabled: () => true, drives: { async authorize(actor, chatId, references) {
                    expect(actor).toEqual(owner);
                    expect(chatId).toBe("chat_drive");
                    expect(references).toEqual([drive]);
                    if (!permitted)
                        throw new Error("Membership revoked");
                } } });
        orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([adapter]), agentContext: context });
    });
    afterEach(async () => { release?.(); await orchestrator.close(); await repository.kysely.destroy(); });
    async function request(id: string, withDrive = true): Promise<CanonicalCreateChatTurnRequest> {
        return { clientRequestId: id, baseRevision: (await repository.get(owner, "chat_drive"))!.chat.revision, selection, interactionMode: "default", permissionMode: "supervised", parts: [{ type: "text", text: "Summarize the plan" }, ...(withDrive ? [mention] : [])] };
    }
    it("persists exact references before dispatch and denies a retry after revocation", async () => {
        failed = true;
        const admitted = await orchestrator.admitTurn(principal, owner, "chat_drive", await request("req_failed"));
        await vi.waitFor(() => expect(orchestrator.activeCount).toBe(0));
        expect(calls[0]?.context?.drives).toEqual([drive]);
        expect(calls[0]?.prompt).toContain("search_company_drive");
        expect(admitted.run.context?.drives).toEqual([drive]);
        permitted = false;
        await expect(orchestrator.retryTurn(principal, owner, "chat_drive", admitted.turn.id, { clientRequestId: "req_retry", baseRevision: (await repository.get(owner, "chat_drive"))!.chat.revision })).rejects.toMatchObject({ safeError: { code: "resource_unavailable" } });
        expect(calls).toHaveLength(1);
    });
    it("groups a pending queued drive turn atomically and rejects changing its admitted context",async()=>{
        hold=new Promise<void>(resolve=>{release=resolve;});
        await orchestrator.admitTurn(principal,owner,"chat_drive",await request("req_first",false));
        await vi.waitFor(()=>expect(calls).toHaveLength(1));
        const queued=await orchestrator.enqueueQueuedTurn(principal,owner,"chat_drive",await request("req_next"));
        const pendingAssociation=await sql<{reference:unknown}>`SELECT reference FROM chat_drive_projects WHERE chat_id = 'chat_drive'`.execute(repository.kysely);
        expect(pendingAssociation.rows[0]?.reference).toEqual(drive);
        const record=(await repository.get(owner,"chat_drive"))!;
        await expect(repository.updateQueuedTurn(owner,{chatId:"chat_drive",queuedTurnId:queued.queuedTurn.id,clientRequestId:"req_mutate",baseRevision:record.chat.revision,parts:[{type:"text",text:"Different context"}],updatedAt:new Date().toISOString()})).rejects.toThrow();
        release!();
        await vi.waitFor(()=>expect(calls).toHaveLength(2),{timeout:5000});
        const associated=await sql<{reference:unknown}>`SELECT reference FROM chat_drive_projects WHERE chat_id = 'chat_drive'`.execute(repository.kysely);
        expect(associated.rows[0]?.reference).toEqual(drive);
    });
    it("retains the first drive association when its pending turn is cancelled", async () => {
        hold = new Promise<void>(resolve => { release = resolve; });
        await orchestrator.admitTurn(principal, owner, "chat_drive", await request("req_running_cancel", false));
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_drive", await request("req_pending_cancel"));
        await repository.cancelQueuedTurn(owner, { chatId: "chat_drive", queuedTurnId: queued.queuedTurn.id, clientRequestId: "req_cancel_drive", baseRevision: (await repository.get(owner, "chat_drive"))!.chat.revision, cancelledAt: new Date().toISOString() });
        const associated = await sql<{reference:unknown}>`SELECT reference FROM chat_drive_projects WHERE chat_id = 'chat_drive'`.execute(repository.kysely);
        expect(associated.rows[0]?.reference).toEqual(drive);
        expect(calls).toHaveLength(1);
    });
    it("revalidates queued references before the next adapter launches", async () => {
        hold = new Promise<void>(resolve => { release = resolve; });
        await orchestrator.admitTurn(principal, owner, "chat_drive", await request("req_running", false));
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const queued = await orchestrator.enqueueQueuedTurn(principal, owner, "chat_drive", await request("req_queued"));
        expect(queued.queuedTurn.context?.drives).toEqual([drive]);
        permitted = false;
        release!();
        await vi.waitFor(async () => {
            const result = await repository.getDetailPage(owner, "chat_drive", { limit: 10 });
            expect(result?.runs).toHaveLength(2);
            expect(result?.runs.at(-1)?.status).toBe("failed");
        }, { timeout: 5000 });
        expect(calls).toHaveLength(1);
    });
});
