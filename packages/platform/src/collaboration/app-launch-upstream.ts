import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDirectSessionSchema,
  CollaborationDirectSessionRequestSchema,
  CollaborationDirectSessionRenewRequestSchema,
  CollaborationDirectRequestSignatureSchema,
  toLogicalRuntimeId,
} from "@matrix-os/contracts";

import {
  CollaborativeAppLaunchError,
  type CollaborativeAppLaunchIdentity,
  type CollaborativeAppLaunchUpstream,
} from "./app-launch-sessions.js";
import { RELAY_RUNTIME_HEADER, type CollaborationRelay } from "./relay.js";
import { canonicalJson, ed25519PublicKeyRaw, possessionPayload, signEd25519 } from "./ticket-crypto.js";
import type { CollaborationTicketIssuer } from "./ticket-issuer.js";

const SESSION_HEADER = "x-matrix-collaboration-session";
const REQUEST_HEADER = "x-matrix-collaboration-request";
const REQUEST_DOMAIN = "matrix-collaboration-request-v2";
const MAX_SESSION_RESPONSE_BYTES = 64 * 1024;

export async function cancelCollaborativeAppResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch (error: unknown) {
    console.warn("[collaborative-app-launch] response cancellation failed", error instanceof Error ? error.name : "UnknownError");
  } finally {
    releaseResponseReader(reader);
  }
}

function releaseResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch (error: unknown) {
    console.warn("[collaborative-app-launch] response reader release failed", error instanceof Error ? error.name : "UnknownError");
  }
}

export function createCollaborativeAppLaunchUpstreamFactory(options: {
  issuer: CollaborationTicketIssuer | null;
  relay: CollaborationRelay;
  clientOrigin: string;
  now?: () => Date;
}): (identity: CollaborativeAppLaunchIdentity) => Promise<CollaborativeAppLaunchUpstream> {
  const now = options.now ?? (() => new Date());
  return async (identity) => {
    const issuer = options.issuer;
    if (!issuer) throw new CollaborativeAppLaunchError("unavailable");
    const pair = generateKeyPairSync("ed25519");
    const publicKey = ed25519PublicKeyRaw(pair.publicKey);
    const issued = await issuer.issue({
      actorId: identity.actorId,
      request: {
        clientRequestId: randomUUID(),
        scopeId: identity.scopeId,
        purpose: "direct_session",
        proofPublicKey: publicKey,
      },
    });
    const ticket = issued.signedTicket.ticket;
    const logicalRuntimeId = toLogicalRuntimeId(identity.runtimeId);
    if (ticket.actorId !== identity.actorId || ticket.resource.scopeId !== identity.scopeId
      || ticket.organizationId !== identity.organizationId || ticket.runtime.runtimeId !== logicalRuntimeId
      || ticket.runtime.authorityGeneration !== identity.authorityGeneration) {
      throw new CollaborativeAppLaunchError("conflict");
    }
    const sessionRequest = CollaborationDirectSessionRequestSchema.parse({
      clientRequestId: randomUUID(),
      signedTicket: issued.signedTicket,
      proofPublicKey: publicKey,
      possession: signEd25519(pair.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: "direct_session" })),
      clientOrigin: options.clientOrigin,
    });
    const body = Buffer.from(JSON.stringify(sessionRequest));
    const exchange = await options.relay.forward({
      actorId: identity.actorId,
      method: "POST",
      path: "/api/collaboration/direct-sessions",
      query: `scope=${identity.scopeId}`,
      headers: new Headers({ "content-type": "application/json", [RELAY_RUNTIME_HEADER]: ticket.runtime.runtimeId }),
      body,
      contentLength: body.byteLength,
    });
    if (exchange.status !== 201) {
      await exchange.body?.cancel();
      throw new CollaborativeAppLaunchError(exchange.status === 503 ? "host_offline" : "unavailable");
    }
    const session = CollaborationDirectSessionSchema.safeParse(await readBoundedJson(exchange));
    if (!session.success || session.data.actorId !== identity.actorId || session.data.scopeId !== identity.scopeId
      || session.data.organizationId !== identity.organizationId || session.data.runtimeId !== logicalRuntimeId) {
      throw new CollaborativeAppLaunchError("unavailable");
    }

    let activeSession = session.data;
    let maxActions = ticket.maxActions;
    let actionsRemaining = maxActions;
    let inFlightActions = 0;
    let resolveDrain: (() => void) | null = null;
    let renewal: Promise<void> | null = null;
    let closed = false;

    const renewSession = async (): Promise<void> => {
      const refreshed = await issuer.issue({
        actorId: identity.actorId,
        request: {
          clientRequestId: randomUUID(),
          scopeId: identity.scopeId,
          purpose: "direct_session",
          proofPublicKey: publicKey,
        },
      });
      const refreshedTicket = refreshed.signedTicket.ticket;
      if (refreshedTicket.actorId !== identity.actorId || refreshedTicket.resource.scopeId !== identity.scopeId
        || refreshedTicket.organizationId !== identity.organizationId
        || refreshedTicket.runtime.runtimeId !== logicalRuntimeId
        || refreshedTicket.runtime.authorityGeneration !== identity.authorityGeneration
        || refreshedTicket.proofKeyThumbprint !== ticket.proofKeyThumbprint) {
        throw new CollaborativeAppLaunchError("conflict");
      }
      const renewRequest = CollaborationDirectSessionRenewRequestSchema.parse({
        clientRequestId: randomUUID(),
        signedTicket: refreshed.signedTicket,
      });
      const body = Buffer.from(JSON.stringify(renewRequest));
      const response = await options.relay.forward({
        actorId: identity.actorId,
        method: "POST",
        path: `/api/collaboration/direct-sessions/${activeSession.id}/renew`,
        query: "",
        headers: new Headers({ "content-type": "application/json", [RELAY_RUNTIME_HEADER]: refreshedTicket.runtime.runtimeId }),
        body,
        contentLength: body.byteLength,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new CollaborativeAppLaunchError(response.status === 503 ? "host_offline" : "unavailable");
      }
      const renewed = CollaborationDirectSessionSchema.safeParse(await readBoundedJson(response));
      if (!renewed.success || renewed.data.id !== activeSession.id || renewed.data.actorId !== identity.actorId
        || renewed.data.scopeId !== identity.scopeId || renewed.data.organizationId !== identity.organizationId
        || renewed.data.runtimeId !== logicalRuntimeId
        || renewed.data.authorityGeneration !== identity.authorityGeneration
        || renewed.data.proofKeyThumbprint !== ticket.proofKeyThumbprint) {
        throw new CollaborativeAppLaunchError("unavailable");
      }
      activeSession = renewed.data;
      maxActions = refreshedTicket.maxActions;
      actionsRemaining = maxActions;
    };

    const reserveAction = async (method: "GET" | "DELETE"): Promise<() => void> => {
      while (true) {
        if (renewal) {
          await renewal;
          continue;
        }
        const closeReserve = method === "GET" ? Math.min(2, maxActions - 1) : 0;
        if (actionsRemaining > closeReserve) {
          actionsRemaining--;
          inFlightActions++;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            inFlightActions--;
            if (inFlightActions === 0) {
              resolveDrain?.();
              resolveDrain = null;
            }
          };
        }
        renewal = (async () => {
          if (inFlightActions > 0) await new Promise<void>((resolve) => { resolveDrain = resolve; });
          await renewSession();
        })().finally(() => { renewal = null; });
        await renewal;
      }
    };

    const signedRequest = async (method: "GET" | "DELETE", path: string, signal: AbortSignal): Promise<Response> => {
      if (method === "GET" && closed) throw new CollaborativeAppLaunchError("unavailable");
      const releaseAction = await reserveAction(method);
      try {
        const signature = CollaborationDirectRequestSignatureSchema.parse({
          protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
          sessionId: activeSession.id,
          method,
          path,
          query: "",
          bodyDigest: sha256(new Uint8Array()),
          conditionalHeadersDigest: sha256(new Uint8Array()),
          nonce: randomBytes(32).toString("hex"),
          issuedAt: now().toISOString(),
        });
        const proof = signEd25519(pair.privateKey, `${REQUEST_DOMAIN}\n${canonicalJson(signature)}`);
        const headers = new Headers({
          accept: method === "GET" ? "*/*" : "application/json",
          [SESSION_HEADER]: activeSession.id,
          [RELAY_RUNTIME_HEADER]: activeSession.runtimeId,
          [REQUEST_HEADER]: Buffer.from(JSON.stringify({ signature, proof })).toString("base64url"),
        });
        const response = await options.relay.forward({
          actorId: identity.actorId,
          method,
          path,
          query: "",
          headers,
          body: null,
          ...(method === "GET" ? { responseClass: "app_asset" as const } : {}),
        });
        return await bindResponseToSignal(response, signal);
      } finally {
        releaseAction();
      }
    };

    return {
      request: (assetPath, signal) => {
        const encodedAssetPath = assetPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
        return signedRequest(
          "GET",
          `/api/collaboration/scopes/${identity.scopeId}/apps/${identity.appId}/assets/${encodedAssetPath}`,
          signal,
        );
      },
      close: async () => {
        if (closed) return;
        closed = true;
        const response = await signedRequest(
          "DELETE",
          `/api/collaboration/direct-sessions/${activeSession.id}`,
          AbortSignal.timeout(10_000),
        );
        await response.body?.cancel();
      },
    };
  };
}

async function bindResponseToSignal(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.body) {
    if (signal.aborted) throw signal.reason;
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  const release = () => {
    signal.removeEventListener("abort", onAbort);
    releaseResponseReader(reader);
  };
  const cancel = async (reason?: unknown) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    await cancelCollaborativeAppResponseReader(reader, reason);
  };
  const onAbort = () => { void cancel(signal.reason); };
  if (signal.aborted) {
    await cancel(signal.reason);
    throw signal.reason;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (!settled) { settled = true; release(); }
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error: unknown) {
        if (!settled) { settled = true; release(); }
        controller.error(new Error("Collaborative app response unavailable"));
      }
    },
    async cancel(reason) { await cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? -1);
  if (declared > MAX_SESSION_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CollaborativeAppLaunchError("unavailable");
  }
  if (!response.body) throw new CollaborativeAppLaunchError("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SESSION_RESPONSE_BYTES) throw new CollaborativeAppLaunchError("unavailable");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error: unknown) {
    await cancelCollaborativeAppResponseReader(reader);
    if (error instanceof CollaborativeAppLaunchError) throw error;
    throw new CollaborativeAppLaunchError("unavailable");
  }
}
