/**
 * The one rule that maps a request principal to the Clerk id its platform integration rows are stored under. The
 * Settings connect flow (startup/platform-integrations.ts, dev path) and the Company Brain's local integration reads
 * (brain/sources/integration/caller.ts) both use it, so an account connected in Settings is the account the brain
 * reads.
 */

/** The principal a local gateway with no auth gives every request (request-principal.ts, source "dev-default"). */
export const INTEGRATION_DEV_PRINCIPAL_ID = "default";

export type IntegrationIdentityEnv = Readonly<Record<string, string | undefined>>;

/** The Clerk id the dev connect flow stores its user under: MATRIX_CLERK_USER_ID, else MATRIX_HANDLE, else "default". */
export function integrationDevClerkId(env: IntegrationIdentityEnv): string {
  return env.MATRIX_CLERK_USER_ID ?? env.MATRIX_HANDLE ?? INTEGRATION_DEV_PRINCIPAL_ID;
}

/**
 * Outside production the dev principal maps to the dev connect flow's Clerk id; every other principal (a Clerk id
 * from the platform header or a JWT, or the configured owner) is its own Clerk id.
 */
export function integrationClerkIdForPrincipal(ownerId: string, env: IntegrationIdentityEnv): string {
  if (env.NODE_ENV !== "production" && ownerId === INTEGRATION_DEV_PRINCIPAL_ID) return integrationDevClerkId(env);
  return ownerId;
}
