import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationDirectSessionSchema,
  CollaborationDirectSessionRequestSchema,
  CollaborationDirectRequestSignatureSchema,
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
    if (ticket.actorId !== identity.actorId || ticket.resource.scopeId !== identity.scopeId
      || ticket.organizationId !== identity.organizationId || ticket.runtime.runtimeId !== identity.runtimeId
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
      || session.data.organizationId !== identity.organizationId || session.data.runtimeId !== identity.runtimeId) {
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
      }).then((response) => {
        if (signal.aborted) {
          void response.body?.cancel(signal.reason);
          throw signal.reason;
        }
        signal.addEventListener("abort", () => { void response.body?.cancel(signal.reason); }, { once: true });
        return response;
      });
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
    await reader.cancel().catch(() => undefined);
    if (error instanceof CollaborativeAppLaunchError) throw error;
    throw new CollaborativeAppLaunchError("unavailable");
  }
}
