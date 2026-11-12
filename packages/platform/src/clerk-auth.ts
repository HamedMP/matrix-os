export interface ClerkTokenPayload {
  sub: string;
  sid?: unknown;
  [key: string]: unknown;
}

export interface VerifyResult {
  authenticated: boolean;
  userId?: string;
  sessionId?: string;
  /** Verified Clerk JWT epoch seconds, when exposed by the verifier. */
  tokenExpiresAt?: number;
  issuer?: string;
  expiresAt?: number;
  /** A verified token for an impersonated or non-active Clerk session. */
  restrictedSession?: true;
  error?: string;
}

/** Positive human-session evidence only; ordinary user routing stays unchanged. */
export function hasVerifiedClerkBrowserSession(result: VerifyResult, expectedUserId: string, now = Math.floor(Date.now() / 1000)):
  result is VerifyResult & { sessionId: string; tokenExpiresAt: number } {
  return expectedUserId.trim().length > 0 && result.authenticated && result.userId === expectedUserId && typeof result.sessionId === "string"
    && result.sessionId.trim().length > 0 && result.tokenExpiresAt !== undefined && Number.isSafeInteger(result.tokenExpiresAt)
    && result.tokenExpiresAt > 0 && result.tokenExpiresAt > now;
}

export const CLERK_SESSION_REVOKE_TIMEOUT_MS = 10_000;

interface ClerkRequiredClaims {
  issuer: string;
  authorizedParty: string;
}

export interface ClerkAuthDeps {
  requiredClaims?: ClerkRequiredClaims;
  verifyToken: (token: string) => Promise<ClerkTokenPayload>;
  revokeSession?: (sessionId: string) => Promise<void>;
}

export type ClerkVerificationConfig = {
  verifyTokenOptions: { secretKey: string } | { jwtKey: string; authorizedParties?: string[] };
  sessionRevocationSecret: string | undefined;
  requiredClaims?: ClerkRequiredClaims;
};

export class DevstackClerkVerificationConfigError extends Error {
  constructor() {
    super("DevStack Clerk binding requires an exact HTTPS issuer and authorized origin, and a verification-only JWT key.");
    this.name = "DevstackClerkVerificationConfigError";
  }
}

function requireExactHttpsOrigin(value: string | undefined): string {
  let origin: URL | null = null;
  if (value) {
    try { origin = new URL(value); }
    catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      throw new DevstackClerkVerificationConfigError();
    }
  }
  if (!origin || origin.protocol !== "https:" || origin.origin !== value) {
    throw new DevstackClerkVerificationConfigError();
  }
  return origin.origin;
}

export function resolveClerkVerificationConfig(
  env: NodeJS.ProcessEnv,
): ClerkVerificationConfig | null {
  // Preserve the existing production input, including malformed values. Local
  // JWT-key support must not change verification or revocation credentials.
  const secretKey = env.CLERK_SECRET_KEY;
  const jwtKey = env.CLERK_JWT_KEY?.trim();
  const registeredLocalDevstack = env.PLATFORM_RUNTIME_MODE === "local"
    && env.MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY === "true";
  if (registeredLocalDevstack
    && (env.CLERK_JWT_ISSUER !== undefined || env.CLERK_AUTHORIZED_ORIGIN !== undefined)) {
    if (!jwtKey || secretKey) throw new DevstackClerkVerificationConfigError();
    const issuer = requireExactHttpsOrigin(env.CLERK_JWT_ISSUER);
    const authorizedParty = requireExactHttpsOrigin(env.CLERK_AUTHORIZED_ORIGIN);
    return {
      verifyTokenOptions: { jwtKey, authorizedParties: [authorizedParty] },
      sessionRevocationSecret: undefined,
      requiredClaims: { issuer, authorizedParty },
    };
  }
  if (secretKey) {
    return {
      verifyTokenOptions: { secretKey },
      sessionRevocationSecret: secretKey,
    };
  }

  return jwtKey
    ? {
        verifyTokenOptions: { jwtKey },
        sessionRevocationSecret: undefined,
      }
    : null;
}

export interface ClerkAuth {
  extractToken(
    authHeader: string | undefined,
    cookieHeader: string | undefined,
  ): string | null;
  verify(token: string): Promise<VerifyResult>;
  verifyAndMatchOwner(
    token: string,
    expectedUserId: string,
  ): Promise<VerifyResult>;
  revokeSession(sessionId: string): Promise<boolean>;
  isPublicPath(path: string): boolean;
}

const PUBLIC_PATHS = ["/health"];

export function createClerkSessionRevoker(opts: {
  secretKey: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}): (sessionId: string) => Promise<void> {
  const apiUrl = opts.apiUrl ?? "https://api.clerk.com";
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (sessionId) => {
    const response = await fetchImpl(
      `${apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}/revoke`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.secretKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(CLERK_SESSION_REVOKE_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error("Clerk session revoke failed");
    }
  };
}

function verifiedResultFromPayload(payload: ClerkTokenPayload): VerifyResult {
  return {
    authenticated: true,
    userId: payload.sub,
    ...(typeof payload.exp === "number" && Number.isSafeInteger(payload.exp) && payload.exp > 0 ? { tokenExpiresAt: payload.exp } : {}),
    ...(typeof payload.iss === "string" ? { issuer: payload.iss } : {}),
    ...(typeof payload.exp === "number" && Number.isSafeInteger(payload.exp) ? { expiresAt: payload.exp * 1000 } : {}),
    ...(payload.act !== undefined || (payload.sts !== undefined && payload.sts !== "active")
      ? { restrictedSession: true as const } : {}),
    ...(typeof payload.sid === "string" && payload.sid.length > 0
      ? { sessionId: payload.sid }
      : {}),
  };
}

export function createClerkAuth(deps: ClerkAuthDeps): ClerkAuth {
  const verifyToken = async (token: string): Promise<ClerkTokenPayload> => {
    const payload = await deps.verifyToken(token);
    const requiredClaims = deps.requiredClaims;
    if (requiredClaims && (payload.iss !== requiredClaims.issuer || payload.azp !== requiredClaims.authorizedParty)) {
      throw new Error("Token verification failed");
    }
    return payload;
  };

  return {
    extractToken(authHeader, cookieHeader) {
      if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice(7);
      }

      if (cookieHeader) {
        const match = cookieHeader.match(
          /(?:^|;\s*)__session=([^\s;]+)/,
        );
        if (match) return match[1];
      }

      return null;
    },

    async verify(token) {
      try {
        const payload = await verifyToken(token);
        return verifiedResultFromPayload(payload);
      } catch (err) {
        return {
          authenticated: false,
          error: err instanceof Error ? err.message : "Token verification failed",
        };
      }
    },

    async verifyAndMatchOwner(token, expectedUserId) {
      try {
        const payload = await verifyToken(token);
        if (payload.sub !== expectedUserId) {
          return { authenticated: false, error: "User mismatch" };
        }
        return verifiedResultFromPayload(payload);
      } catch (err) {
        return {
          authenticated: false,
          error: err instanceof Error ? err.message : "Token verification failed",
        };
      }
    },

    async revokeSession(sessionId) {
      if (!deps.revokeSession) return false;
      await deps.revokeSession(sessionId);
      return true;
    },

    isPublicPath(path) {
      return PUBLIC_PATHS.includes(path);
    },
  };
}
