import { z } from "zod/v4";
import { CanonicalChatRunIdSchema, ChatRunContextSchema, OrganizationDriveContextReferenceSchema, ChatDriveSearchInputSchema, ChatDriveReadInputSchema, type OrganizationDriveContextReference } from "@matrix-os/contracts";
import type { ChatOwner } from "./records.js";
import { parseJson } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { createDriveContextRuntimeClient } from "../organization-drive/context-runtime-client.js";
export { ChatDriveSearchInputSchema, ChatDriveReadInputSchema } from "@matrix-os/contracts";
export class ChatDriveContextError extends Error {
    readonly code = "context_unavailable";
    constructor() { super("Company drive context is unavailable"); this.name = "ChatDriveContextError"; }
}
export interface AdmittedDriveRun {
    chatId: string;
    references: OrganizationDriveContextReference[];
}
/** All filters are owner/run bound; joined live Chat state denies shared or archived results. */
export function createAdmittedDriveRunLoader(repository: Pick<ChatRepository, "kysely">) {
    return async (ownerId: string, runId: string): Promise<AdmittedDriveRun | null> => {
        const row = await repository.kysely.selectFrom("chat_runs").innerJoin("chats", "chats.id", "chat_runs.chat_id")
            .select(["chat_runs.chat_id", "chat_runs.context_snapshot"])
            .where("chat_runs.id", "=", CanonicalChatRunIdSchema.parse(runId))
            .where("chats.owner_type", "=", "personal").where("chats.owner_id", "=", ownerId)
            .where("chats.lifecycle", "=", "active").where("chats.collaboration", "is", null)
            .where("chat_runs.status", "in", ["accepted", "running"]).executeTakeFirst();
        if (!row || row.context_snapshot === null)
            return null;
        const context = ChatRunContextSchema.parse(parseJson(row.context_snapshot));
        return context.drives?.length ? { chatId: row.chat_id, references: context.drives } : null;
    };
}
/** Models choose only an admitted reference index. Every operation rechecks live run and source access. */
export function createChatDriveContext(options: {
    ownerId: string;
    repository: Pick<ChatRepository, "get">;
    client: Pick<ReturnType<typeof createDriveContextRuntimeClient>, "search" | "read">;
    loadRun(ownerId: string, runId: string): Promise<AdmittedDriveRun | null>;
}) {
    async function safe<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        }
        catch (error: unknown) {
            console.warn("[chat/drive-context] unavailable", error instanceof Error ? error.name : "UnknownError");
            throw new ChatDriveContextError();
        }
    }
    function owner(actor: string) { if (actor !== options.ownerId)
        throw new ChatDriveContextError(); }
    async function privateChat(actor: string, chatId: string) {
        owner(actor);
        const record = await options.repository.get({ type: "personal", ownerId: actor }, chatId);
        if (!record || record.chat.lifecycle !== "active" || record.chat.collaboration)
            throw new ChatDriveContextError();
    }
    async function binding(actor: string, runId: string, index: number) {
        owner(actor);
        const run = await options.loadRun(actor, runId);
        const reference = run?.references[index];
        if (!run || !reference)
            throw new ChatDriveContextError();
        await privateChat(actor, run.chatId);
        return { run, reference: OrganizationDriveContextReferenceSchema.parse(reference) };
    }
    async function finish(actor: string, runId: string, index: number, initial: {
        run: AdmittedDriveRun;
        reference: OrganizationDriveContextReference;
    }) {
        const current = await binding(actor, runId, index);
        if (current.run.chatId !== initial.run.chatId || JSON.stringify(current.reference) !== JSON.stringify(initial.reference))
            throw new ChatDriveContextError();
    }
    async function authorizeSources(ownerValue: ChatOwner, references: OrganizationDriveContextReference[]) {
        if (ownerValue.type !== "personal") throw new ChatDriveContextError();
        owner(ownerValue.ownerId);
        const selected = z.array(OrganizationDriveContextReferenceSchema).min(1).max(3).parse(references);
        const signal = AbortSignal.timeout(60000);
        for (const reference of selected) {
            if (reference.kind === "file") await options.client.read(reference, undefined, signal);
            else await options.client.search(reference, { limit: 1 }, signal);
        }
    }
    return {
        /** Source membership only: never reads Chat state or acquires its database connection. */
        authorizeSources(ownerValue: ChatOwner, references: OrganizationDriveContextReference[]) {
            return safe(() => authorizeSources(ownerValue, references));
        },
        authorize(ownerValue: ChatOwner, chatId: string, references: OrganizationDriveContextReference[]) {
            return safe(async () => {
                if (ownerValue.type !== "personal") throw new ChatDriveContextError();
                await privateChat(ownerValue.ownerId, chatId);
                await authorizeSources(ownerValue, references);
                await privateChat(ownerValue.ownerId, chatId);
            });
        },
        search(actor: string, runId: string, raw: z.input<typeof ChatDriveSearchInputSchema>, callerSignal?: AbortSignal) {
            return safe(async () => {
                const { referenceIndex, ...query } = ChatDriveSearchInputSchema.parse(raw);
                const current = await binding(actor, runId, referenceIndex);
                if (current.reference.kind === "file")
                    throw new ChatDriveContextError();
                const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(callerSignal ? [callerSignal] : [])]);
                const result = await options.client.search(current.reference, query, signal);
                await finish(actor, runId, referenceIndex, current);
                return result;
            });
        },
        read(actor: string, runId: string, raw: z.input<typeof ChatDriveReadInputSchema>, callerSignal?: AbortSignal) {
            return safe(async () => {
                const { referenceIndex, fileId } = ChatDriveReadInputSchema.parse(raw);
                const current = await binding(actor, runId, referenceIndex);
                if (current.reference.kind === "file" && fileId && fileId !== current.reference.fileId)
                    throw new ChatDriveContextError();
                if (current.reference.kind !== "file" && !fileId)
                    throw new ChatDriveContextError();
                const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(callerSignal ? [callerSignal] : [])]);
                const result = await options.client.read(current.reference, current.reference.kind === "file" ? undefined : fileId, signal);
                await finish(actor, runId, referenceIndex, current);
                return result;
            });
        },
    };
}
