export interface ClerkTokenPayload {
  sub: string;
  sid?: unknown;
  [key: string]: unknown;
}

export interface VerifyResult {
  authenticated: boolean;
  userId?: string;
  sessionId?: string;
  error?: string;
}

export const CLERK_SESSION_REVOKE_TIMEOUT_MS = 10_000;

export interface ClerkAuthDeps {
  verifyToken: (token: string) => Promise<ClerkTokenPayload>;
  revokeSession?: (sessionId: string) => Promise<void>;
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
    ...(typeof payload.sid === "string" && payload.sid.length > 0
      ? { sessionId: payload.sid }
      : {}),
  };
}

export function createClerkAuth(deps: ClerkAuthDeps): ClerkAuth {
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
        const payload = await deps.verifyToken(token);
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
        const payload = await deps.verifyToken(token);
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
