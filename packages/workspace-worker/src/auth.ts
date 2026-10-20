import { createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";

export interface WorkspaceAuthOptions {
  clerk?: { issuer: string; audience: string };
  previewBearer?: { token: string; ownerId: string };
}
// One trusted configuration per isolate, replaced on rotation or ten-minute TTL.
// Request-scoped route composition must not discard JOSE's signing-key cache.
let signingKeys: { key: string; createdAt: number; resolver: ReturnType<typeof createRemoteJWKSet> } | undefined;
function trustedSigningKeys(config: {issuer:string;audience:string}) {
  const key = `${config.issuer}\u0000${config.audience}`;
  if (!signingKeys || signingKeys.key !== key || Date.now() - signingKeys.createdAt >= 600_000) {
    signingKeys = {key,createdAt:Date.now(),resolver:createRemoteJWKSet(new URL(`${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`), {timeoutDuration:5_000,cooldownDuration:30_000,cacheMaxAge:600_000})};
  }
  return signingKeys.resolver;
}
/** Configuration is server owned. A token never selects its own issuer or owner. */
export function createWorkspaceAuthenticator(options: WorkspaceAuthOptions) {
  const config = options.clerk;
  if (config && (!config.issuer.startsWith("https://") || !config.audience)) throw new Error("Invalid identity configuration");
  const jwks = config ? trustedSigningKeys(config) : null;
  const encoder = new TextEncoder();
  return async (request: Request): Promise<string | null> => {
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
    if (!match || match[1].length > 16_384) return null;
    const token = match[1];
    const preview = options.previewBearer;
    if (preview && preview.token.length >= 24 && preview.ownerId && encoder.encode(token).byteLength === encoder.encode(preview.token).byteLength
      && timingSafeEqual(encoder.encode(token), encoder.encode(preview.token))) return preview.ownerId;
    if (!config || !jwks) return null;
    try {
      const verified = await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience, algorithms: ["RS256"], maxTokenAge: "1h", clockTolerance: 5 });
      return typeof verified.payload.sub === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(verified.payload.sub) ? verified.payload.sub : null;
    } catch (error) {
      // Authentication failures are expected; only record a coarse class.
      console.warn("[workspace-auth] rejected credential", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  };
}
