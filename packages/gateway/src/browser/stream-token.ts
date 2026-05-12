import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface BrowserStreamTokenClaims {
  ownerId: string;
  sessionId: string;
  expiresAt: number;
  nonce: string;
}

export class BrowserStreamTokenError extends Error {
  constructor(message = "invalid_browser_stream_token") {
    super(message);
    this.name = "BrowserStreamTokenError";
  }
}

export function createBrowserStreamTokenSecret(): string {
  return process.env.BROWSER_STREAM_TOKEN_SECRET ??
    process.env.MATRIX_AUTH_TOKEN ??
    randomBytes(32).toString("base64url");
}

export function signBrowserStreamToken(opts: {
  secret: string;
  ownerId: string;
  sessionId: string;
  now?: number;
  ttlMs?: number;
}): string {
  const now = opts.now ?? Date.now();
  const claims: BrowserStreamTokenClaims = {
    ownerId: opts.ownerId,
    sessionId: opts.sessionId,
    expiresAt: now + (opts.ttlMs ?? 5 * 60 * 1000),
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = signPayload(opts.secret, payload);
  return `${payload}.${signature}`;
}

export function verifyBrowserStreamToken(opts: {
  secret: string;
  token: string | null | undefined;
  expectedSessionId: string;
  now?: number;
}): BrowserStreamTokenClaims {
  if (!opts.token) throw new BrowserStreamTokenError();
  const [payload, signature, extra] = opts.token.split(".");
  if (!payload || !signature || extra !== undefined) throw new BrowserStreamTokenError();
  const expectedSignature = signPayload(opts.secret, payload);
  if (!constantTimeEqual(signature, expectedSignature)) throw new BrowserStreamTokenError();
  let claims: BrowserStreamTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as BrowserStreamTokenClaims;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new BrowserStreamTokenError();
    throw error;
  }
  if (
    typeof claims.ownerId !== "string" ||
    typeof claims.sessionId !== "string" ||
    typeof claims.expiresAt !== "number" ||
    typeof claims.nonce !== "string" ||
    claims.sessionId !== opts.expectedSessionId ||
    claims.expiresAt <= (opts.now ?? Date.now())
  ) {
    throw new BrowserStreamTokenError();
  }
  return claims;
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  const length = Math.max(actualBuffer.length, expectedBuffer.length);
  const paddedActual = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  actualBuffer.copy(paddedActual);
  expectedBuffer.copy(paddedExpected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(paddedActual, paddedExpected);
}
