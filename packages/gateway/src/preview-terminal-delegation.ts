import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PreviewTerminalDelegationSchema,
  PREVIEW_TERMINAL_MAX_AGE_SECONDS,
  PREVIEW_TERMINAL_SIGNATURE_DOMAIN,
  type PreviewTerminalDelegation,
} from "@matrix-os/contracts";

export const PREVIEW_TERMINAL_CONTEXT_KEY = "previewTerminalDelegation";

/** Verify only after actor authentication. Classification is attested by platform. */
export function verifyPreviewTerminalDelegation(options: {
  value: string | undefined;
  key: string;
  actorId: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): PreviewTerminalDelegation | undefined {
  const { value, key, actorId } = options;
  const env = options.env ?? process.env;
  if (!value || value.length > 4096 || !key || !env.MATRIX_HANDLE || !env.MATRIX_RUNTIME_SLOT) return undefined;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(value);
  if (!match) return undefined;
  const expected = createHmac("sha256", key)
    .update(`${PREVIEW_TERMINAL_SIGNATURE_DOMAIN}${match[1]}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(match[2], "hex"))) return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const parsed = PreviewTerminalDelegationSchema.safeParse(decoded);
  if (!parsed.success) return undefined;
  const delegation = parsed.data;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ownerIds = [env.MATRIX_USER_ID, env.MATRIX_CLERK_USER_ID]
    .filter((id): id is string => Boolean(id?.trim())).map((id) => id.trim());
  if (ownerIds.length === 0 || ownerIds.some((id) => id !== delegation.ownerId)
    || delegation.actorId !== actorId || delegation.actorId === delegation.ownerId
    || delegation.handle !== env.MATRIX_HANDLE || delegation.runtimeSlot !== env.MATRIX_RUNTIME_SLOT
    || delegation.issuedAt > now + 5 || delegation.expiresAt <= now
    || delegation.expiresAt <= delegation.issuedAt
    || delegation.expiresAt - delegation.issuedAt > PREVIEW_TERMINAL_MAX_AGE_SECONDS) return undefined;
  return delegation;
}
