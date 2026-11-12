import { errors } from "jose";
import type { ClerkAuth } from "../clerk-auth.js";
import { verifySyncJwt, isUserSessionProvenance } from "../sync-jwt.js";
import { PreviewPairActorSchema } from "@matrix-os/contracts/preview-pair";
import { PreviewPairAccessError, type PreviewPairReader } from "./readers.js";
interface Domain { clerk: ClerkAuth; issuer: string; syncSecret: string }
/** Existing Clerk sessions and Matrix user credentials; no pair authentication store. */
export function createPreviewPairReaderAuthenticator(domains: { control: Domain; preview: Domain }) {
  if (domains.control.issuer === domains.preview.issuer || domains.control.syncSecret === domains.preview.syncSecret
    || domains.control.syncSecret.length < 32 || domains.preview.syncSecret.length < 32) throw new PreviewPairAccessError(503);
  return async (request: Request): Promise<PreviewPairReader> => {
    const bearer = /^Bearer ([^\s]{1,8192})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const now = Date.now();
    for (const kind of ["control", "preview"] as const) {
      const domain = domains[kind];
      if (bearer) {
        try {
          const claims = await verifySyncJwt(bearer, { secret: domain.syncSecret, clockTolerance: 0 });
          if (isUserSessionProvenance(claims.session_provenance) && PreviewPairActorSchema.safeParse(claims.sub).success
            && claims.exp * 1000 > now) return { kind, actorId: claims.sub, expiresAt: claims.exp * 1000 };
        } catch (error: unknown) {
          if (!(error instanceof errors.JOSEError) && !(error instanceof Error && error.message === "Invalid sync JWT claims")) throw error;
        }
      }
      const token = domain.clerk.extractToken(request.headers.get("authorization") ?? undefined, request.headers.get("cookie") ?? undefined);
      if (!token || token.length > 8192) continue;
      const result = await domain.clerk.verify(token);
      if (result.authenticated && PreviewPairActorSchema.safeParse(result.userId).success
        && result.issuer === domain.issuer && result.expiresAt && result.expiresAt > now) {
        return { kind, actorId: result.userId!, expiresAt: result.expiresAt };
      }
    }
    throw new PreviewPairAccessError(401);
  };
}
