import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { sql, type ColumnType } from "kysely";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, ChatDriveProjectReferenceSchema, CanonicalOwnerScopeSchema, ChatDriveProjectSchema, ChatDriveProjectLookupSchema, ChatDriveProjectLookupResponseSchema, UpdateChatDriveProjectSchema, type OrganizationDriveContextReference } from "@matrix-os/contracts";
import type { ChatRepository } from "./repository.js";
import type { ChatOwner } from "./records.js";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
import { ChatConflictError } from "./errors.js";
type AssociationDatabase = {
    chat_drive_projects: {
        chat_id: string;
        reference: ColumnType<unknown, unknown, unknown>;
        request_id: string;
        updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
    };
};
const PathSchema = z.object({ chatId: CanonicalChatIdSchema }).strict();
const QuerySchema = z.object({}).strict();
class ProjectError extends Error {
    constructor(readonly status: 404 | 409 | 503) { super("Company drive project unavailable"); }
}
const failure = (c: Context, error: unknown) => {
    c.header("Cache-Control", "private, no-store");
    if (isRequestPrincipalError(error)) {
        const mapped = mapRequestPrincipalError(error);
        return c.json(mapped.body, mapped.status);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError)
        return c.json({ error: "Invalid company drive project request" }, 422);
    if (error instanceof ChatConflictError)
        return c.json({ error: "Chat changed. Refresh and retry." }, 409);
    if (error instanceof ProjectError)
        return c.json({ error: "Company drive project is unavailable" }, error.status);
    if (error instanceof Error && error.name === "BodyLimitError")
        return c.json({ error: "Request too large" }, 413);
    console.warn("[chat/drive-project] Unavailable", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Company drive project is unavailable" }, 503);
};
/** Association organizes personal Chats; it is never an organization grant or a filesystem project. */
export async function createChatDriveProjectRoutes(options: {
    repository: ChatRepository | null;
    drives: {
        authorizeSources(owner: ChatOwner, references: OrganizationDriveContextReference[]): Promise<void>;
    } | null;
    resolveOwner(c: Context): ChatOwner;
}): Promise<Hono> {
    const repository = options.repository;
    const app = new Hono();
    app.post('/api/chat-drive-projects/lookup', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "Request too large" }, 413) }), async (c) => {
        try {
            QuerySchema.parse(c.req.query());
            const owner = CanonicalOwnerScopeSchema.parse(options.resolveOwner(c));
            const input = ChatDriveProjectLookupSchema.parse(await c.req.json());
            if (!repository)
                throw new ProjectError(503);
            const rows = input.chatIds.length ? await repository.kysely.withTables<AssociationDatabase>().transaction().execute(async (trx) => {
                await sql `SET LOCAL statement_timeout = '5s'`.execute(trx);
                return trx.selectFrom('chat_drive_projects').innerJoin('chats', 'chats.id', 'chat_drive_projects.chat_id')
                    .select(['chat_drive_projects.chat_id', 'chat_drive_projects.reference', 'chats.revision'])
                    .where('chats.owner_type', '=', owner.type).where('chats.owner_id', '=', owner.ownerId).where('chats.lifecycle', '=', 'active')
                    .where('chats.collaboration', 'is', null).where('chat_drive_projects.chat_id', 'in', input.chatIds).execute();
            }) : [];
            c.header('Cache-Control', 'private, no-store');
            return c.json(ChatDriveProjectLookupResponseSchema.parse({ associations: rows.map(row => ({ chatId: row.chat_id, reference: row.reference, revision: Number(row.revision) })) }));
        }
        catch (error: unknown) {
            return failure(c, error);
        }
    });
    app.patch('/api/chats/:chatId/drive-project', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "Request too large" }, 413) }), async (c) => {
        try {
            const { chatId } = PathSchema.parse(c.req.param());
            QuerySchema.parse(c.req.query());
            const owner = CanonicalOwnerScopeSchema.parse(options.resolveOwner(c));
            const input = UpdateChatDriveProjectSchema.parse(await c.req.json());
            if (!repository)
                throw new ProjectError(503);
            if (owner.type !== "personal") throw new ProjectError(409);
            // Source membership is independent of Chat mutation state and holds no Chat DB connection.
            if (input.reference) {
                if (!options.drives) throw new ProjectError(503);
                await options.drives.authorizeSources(owner, [input.reference]);
            }
            const result = await repository.withTransaction(async (scoped) => {
                const db = scoped.kysely.withTables<AssociationDatabase>();
                await sql`SET LOCAL statement_timeout = '5s'`.execute(db);
                await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
                const chat = await db.selectFrom('chats').select(['revision', 'collaboration', 'lifecycle']).where('id', '=', chatId).where('owner_type', '=', owner.type).where('owner_id', '=', owner.ownerId).forUpdate().executeTakeFirst();
                if (!chat)
                    throw new ProjectError(404);
                if (chat.collaboration || chat.lifecycle !== 'active')
                    throw new ProjectError(409);
                const previous = await db.selectFrom('chat_drive_projects').selectAll().where('chat_id', '=', chatId).executeTakeFirst();
                if (previous?.request_id === input.clientRequestId) {
                    const saved = ChatDriveProjectReferenceSchema.nullable().parse(previous.reference);
                    if (saved?.scopeId !== input.reference?.scopeId || saved?.organizationId !== input.reference?.organizationId)
                        throw new ProjectError(409);
                    return { chatId, reference: previous.reference, revision: Number(chat.revision) };
                }
                if (Number(chat.revision) !== input.baseRevision)
                    throw new ProjectError(409);
                const updated = await scoped.update(owner, chatId, { baseRevision: input.baseRevision });
                await db.insertInto('chat_drive_projects').values({ chat_id: chatId, reference: input.reference, request_id: input.clientRequestId })
                    .onConflict(conflict => conflict.column('chat_id').doUpdateSet({ reference: input.reference, request_id: input.clientRequestId, updated_at: sql `now()` })).execute();
                return { chatId, reference: input.reference, revision: updated.chat.revision };
            });
            c.header('Cache-Control', 'private, no-store');
            return c.json(ChatDriveProjectSchema.parse(result));
        }
        catch (error: unknown) {
            return failure(c, error);
        }
    });
    return app;
}
