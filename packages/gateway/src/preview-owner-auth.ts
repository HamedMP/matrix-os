import { createHmac, timingSafeEqual } from "node:crypto";

/** A second controller for an explicitly connected, disposable preview only.
 * The original gateway credential remains valid for rollback. The preview
 * credential alone is insufficient: it must carry the configured owner's
 * signed principal, including for platform-terminated WebSocket upgrades.
 */
export function verifyPreviewOwnerControl(input: {
  bearer: string | null;
  actorId: string | undefined;
  proof: string | undefined;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = input.env ?? process.env;
  const handle = env.MATRIX_HANDLE;
  const owner = env.MATRIX_CLERK_USER_ID;
  const key = env.UPGRADE_TOKEN;
  if (env.MATRIX_PREVIEW_RUNTIME !== "true" || env.MATRIX_PREVIEW_OWNER_CONTROL !== "true"
    || !handle || !/^pr-[1-9][0-9]{0,8}$/.test(handle) || env.MATRIX_RUNTIME_SLOT !== handle
    || !owner || !/^user_[A-Za-z0-9_-]{1,251}$/.test(owner)
    || (env.MATRIX_USER_ID !== undefined && env.MATRIX_USER_ID !== owner)
    || !key || !/^[a-f0-9]{64}$/.test(key)
    || input.actorId !== owner || !input.bearer || !/^[a-f0-9]{64}$/.test(input.bearer)
    || !input.proof || !/^[a-f0-9]{64}$/.test(input.proof)) return undefined;
  const tokenMatches = timingSafeEqual(Buffer.from(input.bearer, "hex"), Buffer.from(key, "hex"));
  const expectedProof = createHmac("sha256", key).update(owner).digest();
  const proofMatches = timingSafeEqual(Buffer.from(input.proof, "hex"), expectedProof);
  return tokenMatches && proofMatches ? owner : undefined;
}
