import type { Context } from "hono";
import { getOptionalRequestPrincipal, hasVerifiedRuntimeBearer, SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";

export function createOpenMausBotPreviewOwnerCheck(env: NodeJS.ProcessEnv): (c: Context) => boolean {
  const clerkOwner = env.MATRIX_CLERK_USER_ID?.trim();
  const localOwner = env.MATRIX_USER_ID?.trim();
  const owner = clerkOwner || localOwner;
  if (!owner || !SAFE_PRINCIPAL_USER_ID.test(owner) || (clerkOwner && localOwner && clerkOwner !== localOwner)) return () => false;

  return (c) => {
    if (!hasVerifiedRuntimeBearer(c)) return false;
    const principal = getOptionalRequestPrincipal(c);
    return principal?.userId === owner && (principal.source === "jwt" || principal.source === "platform-verified");
  };
}
