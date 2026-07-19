import { createHmac, timingSafeEqual } from "node:crypto";

const CLERK_USER_ID_PATTERN = /^[A-Za-z0-9_-]{3,256}$/;
const PLATFORM_PROOF_PATTERN = /^[0-9a-f]{64}$/;
const PREVIEW_RUNTIME_PATTERN = /^pr-[1-9][0-9]{0,9}$/;

function timingSafeStringEquals(actual: string | null, expected: string): boolean {
  if (!actual || actual.length > 512 || expected.length > 512) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  const maxLength = Math.max(actualBuffer.length, expectedBuffer.length);
  if (maxLength === 0) return false;
  const paddedActual = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  actualBuffer.copy(paddedActual);
  expectedBuffer.copy(paddedExpected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(paddedActual, paddedExpected);
}

export function isPlatformBearerValid(
  actualToken: string | null,
  expectedToken: string | undefined,
): boolean {
  return Boolean(expectedToken && timingSafeStringEquals(actualToken, expectedToken));
}

function isPreviewRuntime(handle: string | undefined, runtimeSlot: string | undefined): boolean {
  if (!handle || !runtimeSlot || !PREVIEW_RUNTIME_PATTERN.test(handle)) return false;
  return runtimeSlot === handle || runtimeSlot === "preview";
}

function isPlatformUserProofValid(input: {
  platformToken: string;
  platformUserId: string;
  platformUserProof: string | null;
}): boolean {
  if (!CLERK_USER_ID_PATTERN.test(input.platformUserId)) return false;
  if (!input.platformUserProof || !PLATFORM_PROOF_PATTERN.test(input.platformUserProof)) return false;
  const expectedProof = createHmac("sha256", input.platformToken)
    .update(input.platformUserId)
    .digest("hex");
  return timingSafeStringEquals(input.platformUserProof, expectedProof);
}

export function canPlatformUserAccessShell(input: {
  expectedOwnerId: string | undefined;
  platformUserId: string | null;
  platformUserProof: string | null;
  platformToken: string | undefined;
  handle: string | undefined;
  runtimeSlot: string | undefined;
}): boolean {
  if (!input.expectedOwnerId) return true;
  if (input.platformUserId === input.expectedOwnerId) return true;
  if (!input.platformUserId || !input.platformToken) return false;
  if (!isPreviewRuntime(input.handle, input.runtimeSlot)) return false;
  return isPlatformUserProofValid({
    platformToken: input.platformToken,
    platformUserId: input.platformUserId,
    platformUserProof: input.platformUserProof,
  });
}
