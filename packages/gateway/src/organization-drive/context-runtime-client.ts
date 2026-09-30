import { randomBytes, randomUUID } from "node:crypto";
import { setImmediate as yieldRead } from "node:timers/promises";
import { z } from "zod/v4";
import { CollaborationActorIdSchema, CollaborationClientOriginSchema, CollaborationDirectRequestSignatureSchema, CollaborationDirectSessionSchema, CollaborationSignedConnectionTicketSchema, OrganizationDriveContextReferenceSchema, OrganizationDriveContextSearchSchema, OrganizationDriveContextSearchResponseSchema, OrganizationDriveTextContextSchema, type OrganizationDriveContextReference, type CollaborationDirectSession } from "@matrix-os/contracts";
import { generateRuntimeKeyPair, proofKeyThumbprint, possessionPayload, requestSigningPayload, sha256Hex, signWithSeed } from "../collaboration/direct-crypto.js";
const BASE = "/internal/collaboration/drive-context";
const TicketResponse = z.object({ signedTicket: CollaborationSignedConnectionTicketSchema, endpoint: z.object({ origin: CollaborationClientOriginSchema, protocolVersion: z.literal(2) }).strict() }).strict();
export class DriveContextRuntimeError extends Error {
    readonly code = "unavailable";
    constructor() { super("Company drive context is unavailable"); this.name = "DriveContextRuntimeError"; }
}
/** Ephemeral proof per operation. Enrollment credentials go only to the configured platform origin. */
export function createDriveContextRuntimeClient(options: {
    platformOrigin: string;
    runtimeId: string;
    ownerId: string;
    serviceToken: string;
    fetchImpl?: typeof fetch;
}) {
    const origin = CollaborationClientOriginSchema.parse(options.platformOrigin);
    const owner = CollaborationActorIdSchema.parse(options.ownerId);
    const runtime = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/).parse(options.runtimeId);
    const token = z.string().min(32).max(4096).regex(/^[A-Za-z0-9._~-]+$/).parse(options.serviceToken);
    const fetchImpl = options.fetchImpl ?? fetch;
    const active = new Set<AbortController>();
    let closed = false;
    async function operation(reference: OrganizationDriveContextReference, path: string, query: string, callerSignal?: AbortSignal, body?: unknown) {
        if (closed || active.size >= 4)
            throw new DriveContextRuntimeError();
        const controller = new AbortController();
        active.add(controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000), ...(callerSignal ? [callerSignal] : [])]);
        const key = generateRuntimeKeyPair();
        let session: CollaborationDirectSession | undefined;
        const headers = () => new Headers({ authorization: `Bearer ${token}`, "x-matrix-runtime-id": runtime, accept: "application/json" });
        async function request(route: string, method: "GET" | "POST" | "DELETE", body?: unknown, signedHeaders?: Headers, cleanup = false) {
            const requestHeaders = signedHeaders ?? headers();
            if (body !== undefined)
                requestHeaders.set("content-type", "application/json");
            const timeout = AbortSignal.timeout(cleanup ? 3000 : 10000);
            const requestSignal = cleanup ? timeout : AbortSignal.any([signal, timeout]);
            const response = await fetchImpl(`${origin}${BASE}${route}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: requestSignal });
            if (!response.ok) {
                void response.body?.cancel().catch(error => console.warn("[drive-context] response cleanup failed", error instanceof Error ? error.name : "UnknownError"));
                throw new DriveContextRuntimeError();
            }
            if (response.status === 204)
                return undefined;
            return boundedJson(response, requestSignal);
        }
        async function signed(method: "GET" | "POST" | "DELETE", target: string, search: string, cleanup = false, data?: unknown) {
            if (!session)
                throw new DriveContextRuntimeError();
            const signature = CollaborationDirectRequestSignatureSchema.parse({ protocolVersion: 2, sessionId: session.id, method, path: target, query: search, bodyDigest: sha256Hex(new TextEncoder().encode(data === undefined ? "" : JSON.stringify(data))), conditionalHeadersDigest: sha256Hex(new Uint8Array()), nonce: randomBytes(16).toString("hex"), issuedAt: new Date().toISOString() });
            const h = headers();
            h.set("x-matrix-collaboration-session", session.id);
            h.set("x-matrix-collaboration-runtime", session.runtimeId);
            h.set("x-matrix-collaboration-request", Buffer.from(JSON.stringify({ signature, proof: signWithSeed(key.seed, requestSigningPayload(signature)) })).toString("base64url"));
            return request(`/relay${target}${search ? `?${search}` : ""}`, method, data, h, cleanup);
        }
        try {
            signal.throwIfAborted();
            const issued = TicketResponse.parse(await request("/connections", "POST", { scopeId: reference.scopeId, clientRequestId: randomUUID(), proofPublicKey: key.publicKey }));
            const ticket = issued.signedTicket.ticket;
            if (issued.endpoint.origin !== origin || ticket.actorId !== owner || ticket.organizationId !== reference.organizationId || ticket.resource.scopeId !== reference.scopeId || ticket.resource.kind !== "folder" || ticket.purpose !== "direct_session" || ticket.proofKeyThumbprint !== proofKeyThumbprint(key.publicKey))
                throw new DriveContextRuntimeError();
            const h = headers();
            h.set("x-matrix-collaboration-runtime", ticket.runtime.runtimeId);
            session = CollaborationDirectSessionSchema.parse(await request(`/relay/api/collaboration/direct-sessions?scope=${reference.scopeId}`, "POST", { clientRequestId: randomUUID(), signedTicket: issued.signedTicket, proofPublicKey: key.publicKey, possession: signWithSeed(key.seed, possessionPayload({ ticketNonce: ticket.nonce, purpose: "direct_session" })), clientOrigin: origin }, h));
            if (session.actorId !== owner || session.organizationId !== reference.organizationId || session.scopeId !== reference.scopeId || session.runtimeId !== ticket.runtime.runtimeId || session.authorityGeneration !== ticket.runtime.authorityGeneration || session.proofKeyThumbprint !== ticket.proofKeyThumbprint || session.purpose !== "direct_session")
                throw new DriveContextRuntimeError();
            return await signed(body === undefined ? "GET" : "POST", path, query, false, body);
        }
        catch (error: unknown) {
            console.warn("[drive-context] request unavailable", error instanceof Error ? error.name : "UnknownError");
            throw new DriveContextRuntimeError();
        }
        finally {
            if (session)
                try {
                    await signed("DELETE", `/api/collaboration/direct-sessions/${session.id}`, "", true);
                }
                catch (error: unknown) {
                    console.warn("[drive-context] session cleanup unavailable", error instanceof Error ? error.name : "UnknownError");
                }
            active.delete(controller);
        }
    }
    return {
        async search(raw: OrganizationDriveContextReference, input: {
            query?: string;
            after?: string;
            limit?: number;
        }, signal?: AbortSignal) {
            const reference = contextValue(OrganizationDriveContextReferenceSchema, raw);
            if (reference.kind === "file")
                throw new DriveContextRuntimeError();
            const search = contextValue(OrganizationDriveContextSearchSchema, { ...input, ...(reference.kind === "folder" ? { prefix: reference.path } : {}) });
            const result = contextValue(OrganizationDriveContextSearchResponseSchema, await operation(reference, `/api/collaboration/scopes/${reference.scopeId}/drive/context/search`, "", signal, search));
            if (result.organizationId !== reference.organizationId || result.scopeId !== reference.scopeId || result.files.some(file => file.organizationId !== reference.organizationId || (reference.kind === "folder" && !file.path.startsWith(`${reference.path}/`))))
                throw new DriveContextRuntimeError();
            return result;
        },
        async read(raw: OrganizationDriveContextReference, fileId?: string, signal?: AbortSignal) {
            const reference = contextValue(OrganizationDriveContextReferenceSchema, raw);
            const id = contextValue(z.uuid(), reference.kind === "file" ? reference.fileId : fileId);
            const query = reference.kind === "file" ? `version=${reference.version}` : "";
            const result = contextValue(OrganizationDriveTextContextSchema, await operation(reference, `/api/collaboration/scopes/${reference.scopeId}/drive/files/${id}/context`, query, signal));
            if (result.file.organizationId !== reference.organizationId || result.file.id !== id || (reference.kind === "file" && result.file.version !== reference.version) || (reference.kind === "folder" && !result.file.path.startsWith(`${reference.path}/`)))
                throw new DriveContextRuntimeError();
            return result;
        },
        close() { closed = true; for (const controller of active)
            controller.abort(); active.clear(); },
    };
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body)
        throw new DriveContextRuntimeError();
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let size = 0;
    let chunks = 0;
    const cancel = () => { void reader.cancel().catch(error => console.warn("[drive-context] response cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        while (true) {
            const value = await reader.read();
            signal.throwIfAborted();
            if (value.done)
                break;
            size += value.value.byteLength;
            if (size > 128 * 1024)
                throw new DriveContextRuntimeError();
            if (++chunks % 256 === 0) {
                await yieldRead();
                signal.throwIfAborted();
            }
            text += decoder.decode(value.value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text);
    }
    finally {
        signal.removeEventListener("abort", cancel);
        cancel();
        reader.releaseLock();
    }
}

function contextValue<T>(schema: z.ZodType<T>, value: unknown): T {
 const parsed = schema.safeParse(value);
 if (!parsed.success) throw new DriveContextRuntimeError();
 return parsed.data;
}
