import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDirectSessionSchema,
  CollaborationDirectSessionRequestSchema,
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
    if (!options.issuer) throw new CollaborativeAppLaunchError("unavailable");
    const pair = generateKeyPairSync("ed25519");
    const publicKey = ed25519PublicKeyRaw(pair.publicKey);
    const issued = await options.issuer.issue({
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

    const signedRequest = async (method: "GET" | "DELETE", path: string, signal: AbortSignal): Promise<Response> => {
      const signature = CollaborationDirectRequestSignatureSchema.parse({
        protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
        sessionId: session.data.id,
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
        [SESSION_HEADER]: session.data.id,
        [RELAY_RUNTIME_HEADER]: session.data.runtimeId,
        [REQUEST_HEADER]: Buffer.from(JSON.stringify({ signature, proof })).toString("base64url"),
      });
      return options.relay.forward({
        actorId: identity.actorId,
        method,
        path,
        query: "",
        headers,
        body: null,
      }).then((response) => bindResponseToSignal(response, signal));
    };

    let closed = false;
    return {
      request: (assetPath, signal) => signedRequest(
        "GET",
        `/api/collaboration/scopes/${identity.scopeId}/apps/${identity.appId}/assets/${assetPath}`,
        signal,
      ),
      close: async () => {
        if (closed) return;
        closed = true;
        const response = await signedRequest(
          "DELETE",
          `/api/collaboration/direct-sessions/${session.data.id}`,
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
