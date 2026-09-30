import { OrganizationDriveContextSearchSchema, COLLABORATION_DIRECT_LIMITS, CollaborationDirectSessionRequestSchema, CollaborationLogicalRuntimeIdSchema } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { requireRuntime, type AuthenticatedRuntime } from "./direct-routes.js";
import { CollaborationConnectionRequestSchema, CollaborationTicketIssuerError, type CollaborationTicketIssuer } from "./ticket-issuer.js";
import type { CollaborationRelay } from "./relay.js";
const BASE = "/internal/collaboration/drive-context";
const Request = CollaborationConnectionRequestSchema.omit({ purpose: true, maxActions: true }).strict();
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const ReadPath = new RegExp(`^/api/collaboration/scopes/(${UUID})/drive/files/(${UUID})/context$`);
const SearchPath = new RegExp(`^/api/collaboration/scopes/(${UUID})/drive/context/search$`);
const ClosePath = new RegExp(`^/api/collaboration/direct-sessions/(${UUID})$`);
/** Enrolled runtime delegates only its own owner, through proof-bound sessions. No drive mutations or body logging. */
export function createPlatformDriveContextRuntimeRoutes(options: {
    issuer: Pick<CollaborationTicketIssuer, "issue"> | null;
    relay: Pick<CollaborationRelay, "forward">;
    relayOrigin: string;
    authenticateRuntime(input: {
        runtimeId: string;
        bearerToken: string;
    }): Promise<AuthenticatedRuntime | null>;
}): Hono {
    const app = new Hono();
    const limit = bodyLimit({ maxSize: COLLABORATION_DIRECT_LIMITS.httpJsonBytes, onError: c => safe(c, 413) });
    app.post(`${BASE}/connections`, limit, async (c) => {
        const runtime = await requireRuntime(c, options.authenticateRuntime);
        if (!runtime)
            return safe(c, 401);
        if (!options.issuer)
            return safe(c, 503);
        try {
            const request = Request.parse(await c.req.json());
            const issued = await options.issuer.issue({ actorId: runtime.ownerId, request: { ...request, purpose: "direct_session", maxActions: 4 } });
            if (issued.signedTicket.ticket.resource.kind !== "folder")
                return safe(c, 404);
            c.header("Cache-Control", "private, no-store");
            return c.json(issued, 201);
        }
        catch (error: unknown) {
            if (error instanceof Error && error.name === "BodyLimitError")
                throw error;
            if (error instanceof SyntaxError || error instanceof z.ZodError)
                return safe(c, 422);
            if (error instanceof CollaborationTicketIssuerError)
                return safe(c, error.code === "not_found" ? 404 : error.code === "invalid_request" ? 422 : 503);
            console.warn("[platform-drive-context] ticket unavailable", error instanceof Error ? error.name : "UnknownError");
            return safe(c, 503);
        }
    });
    app.all(`${BASE}/relay/*`, limit, async (c) => {
        const runtime = await requireRuntime(c, options.authenticateRuntime);
        if (!runtime)
            return safe(c, 401);
        const path = c.req.path.slice(`${BASE}/relay`.length);
        const method = c.req.method;
        if (!((method === "GET" && ReadPath.test(path)) || (method === "DELETE" && ClosePath.test(path)) || (method === "POST" && (path === "/api/collaboration/direct-sessions" || SearchPath.test(path)))))
            return safe(c, 404);
        try {
            if (method === "POST") await c.req.arrayBuffer();
            const query = new URL(c.req.url).searchParams;
            const read = ReadPath.exec(path); const search = SearchPath.exec(path); const close = ClosePath.exec(path);
            if (read) {
                z.object({scopeId:z.uuid(),fileId:z.uuid()}).strict().parse({scopeId:read[1],fileId:read[2]});
                if (query.size > 1) return safe(c,422);
                z.object({version:z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value=>Number(value)<=2_147_483_647).optional()}).strict().parse(Object.fromEntries(query));
            } else if (search) {
                z.object({scopeId:z.uuid()}).strict().parse({scopeId:search[1]});
                z.object({}).strict().parse(Object.fromEntries(query));
            } else if (close) {
                z.object({sessionId:z.uuid()}).strict().parse({sessionId:close[1]});
                z.object({}).strict().parse(Object.fromEntries(query));
            } else {
                z.object({scope:z.uuid()}).strict().parse(Object.fromEntries(query));
                if (query.size !== 1) return safe(c,422);
            }
            let body: Uint8Array | null = null;
            if (method === "POST" && SearchPath.test(path)) {
                if (new URL(c.req.url).search || !CollaborationLogicalRuntimeIdSchema.safeParse(c.req.header("x-matrix-collaboration-runtime")).success)
                    return safe(c, 422);
                body = new Uint8Array(await c.req.arrayBuffer());
                OrganizationDriveContextSearchSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
            }
            else if (method === "POST") {
                const value = CollaborationDirectSessionRequestSchema.parse(await c.req.json());
                const ticket = value.signedTicket.ticket;
                const query = new URL(c.req.url).searchParams;
                if (ticket.actorId !== runtime.ownerId || ticket.purpose !== "direct_session" || ticket.resource.kind !== "folder" || value.clientOrigin !== options.relayOrigin
                    || query.size !== 1 || query.get("scope") !== ticket.resource.scopeId || c.req.header("x-matrix-collaboration-runtime") !== ticket.runtime.runtimeId)
                    return safe(c, 403);
                body = new TextEncoder().encode(JSON.stringify(value));
            }
            else if (!CollaborationLogicalRuntimeIdSchema.safeParse(c.req.header("x-matrix-collaboration-runtime")).success)
                return safe(c, 422);
            const response = await options.relay.forward({ actorId: runtime.ownerId, method, path, query: new URL(c.req.url).search.slice(1), headers: c.req.raw.headers, body, ...(body ? { contentLength: body.byteLength } : {}) });
            response.headers.set("Cache-Control", "private, no-store");
            return response;
        }
        catch (error: unknown) {
            if (error instanceof Error && error.name === "BodyLimitError")
                throw error;
            if (error instanceof SyntaxError || error instanceof z.ZodError)
                return safe(c, 422);
            console.warn("[platform-drive-context] relay unavailable", error instanceof Error ? error.name : "UnknownError");
            return safe(c, 503);
        }
    });
    return app;
}
function safe(c: Context, status: 401 | 403 | 404 | 413 | 422 | 503) { c.header("Cache-Control", "private, no-store"); return c.json({ error: "Company drive context is unavailable" }, status); }
