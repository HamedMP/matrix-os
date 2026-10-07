import { KyselyPGlite } from "kysely-pglite";
import { expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createAdmittedDriveRunLoader } from "../../packages/gateway/src/chat/drive-context.js";
const owner = { type: "personal" as const, ownerId: "user_owner" };
const drive = { kind: "drive" as const, scopeId: "00000000-0000-4000-8000-000000000001", organizationId: "org_company" };
it("loads only the configured owner's active private run and denies completion or a shared Chat", async () => {
    const repository = new ChatRepository((await KyselyPGlite.create()).dialect);
    try {
        await repository.bootstrap();
        const created = await repository.create(owner, { id: "chat_drive", clientRequestId: "req_create", title: "Company plans" });
        const now = new Date().toISOString();
        const message = { id: "msg_drive", chatId: "chat_drive", seq: 1, role: "user" as const, state: "committed" as const, purpose: "ai_request" as const, turnId: "cturn_drive", parts: [{ type: "text" as const, text: "Plan" }], createdAt: now };
        const turn = { id: "cturn_drive", chatId: "chat_drive", clientRequestId: "req_turn", baseMessageSeq: 0, inputMessageId: message.id, status: "accepted" as const, createdAt: now, updatedAt: now };
        const capabilities = { revision: "catalog_1", rootChat: true, resume: true, cancellation: true, steering: "same_run" as const, attachments: [], tools: [], approvals: true, userInput: true, worktrees: "optional" as const, resources: ["organization_drive" as const], interactionModes: ["default"], permissionModes: ["supervised"] };
        const run = { id: "run_drive", chatId: "chat_drive", turnId: turn.id, attempt: 1, driverKind: "claude_code" as const, instanceId: "claude_default", selection: { instanceId: "claude_default", model: "model" }, interactionMode: "default", permissionMode: "supervised", status: "accepted" as const, historyBoundarySeq: 0, capabilitySnapshot: capabilities, context: { version: 1 as const, requestHash: "a".repeat(64), chats: [], drives: [drive] }, createdAt: now, updatedAt: now };
        await repository.admitTurn(owner, { chatId: "chat_drive", baseRevision: created.chat.revision, message, turn, run });
        const load = createAdmittedDriveRunLoader(repository);
        expect(await load(owner.ownerId, run.id)).toEqual({ chatId: "chat_drive", references: [drive] });
        expect(await load("user_other", run.id)).toBeNull();
        await repository.kysely.updateTable("chats").set({ collaboration: { scopeId: drive.scopeId, mode: "discussion_only", executionFenced: true } }).where("id", "=", "chat_drive").execute();
        expect(await load(owner.ownerId, run.id)).toBeNull();
        await repository.kysely.updateTable("chats").set({ collaboration: null }).where("id", "=", "chat_drive").execute();
        await repository.finishRun(owner, { chatId: "chat_drive", runId: run.id, outcome: "completed", completedAt: new Date().toISOString() });
        expect(await load(owner.ownerId, run.id)).toBeNull();
    }
    finally {
        await repository.kysely.destroy();
    }
}, 30000);
