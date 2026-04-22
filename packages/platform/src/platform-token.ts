import { createHmac, timingSafeEqual } from "node:crypto";

export function timingSafeTokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  const maxLen = Math.max(actualBuf.length, expectedBuf.length);
  if (maxLen === 0) return false;
  const paddedActual = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  actualBuf.copy(paddedActual);
  expectedBuf.copy(paddedExpected);
  const lengthMatch = actualBuf.length === expectedBuf.length;
  const contentMatch = timingSafeEqual(paddedActual, paddedExpected);
  return lengthMatch && contentMatch;
}

export function buildPlatformVerificationToken(handle: string, platformSecret: string): string {
  return createHmac("sha256", platformSecret).update(handle).digest("hex");
}
