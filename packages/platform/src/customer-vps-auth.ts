import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

export interface RegistrationToken {
  token: string;
  hash: string;
  expiresAt: string;
}

export function hashRegistrationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createRegistrationToken(now: Date, ttlMs: number): RegistrationToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    token,
    hash: hashRegistrationToken(token),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function constantTimeEquals(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function registrationTokenMatches(token: string | undefined, expectedHash: string | null | undefined): boolean {
  if (!token || !expectedHash) return false;
  return constantTimeEquals(hashRegistrationToken(token), expectedHash);
}

export function bearerTokenMatches(authHeader: string | undefined, expected: string): boolean {
  if (!expected || !authHeader?.startsWith('Bearer ')) return false;
  return constantTimeEquals(authHeader.slice(7), expected);
}
