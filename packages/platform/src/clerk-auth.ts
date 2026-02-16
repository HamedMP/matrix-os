export interface ClerkTokenPayload {
  sub: string;
  [key: string]: unknown;
}

export interface VerifyResult {
  authenticated: boolean;
  userId?: string;
  error?: string;
}

export interface ClerkAuthDeps {
  verifyToken: (token: string) => Promise<ClerkTokenPayload>;
}

export interface ClerkAuth {
  extractToken(
    authHeader: string | undefined,
    cookieHeader: string | undefined,
  ): string | null;
  verifyAndMatchOwner(
    token: string,
    expectedUserId: string,
  ): Promise<VerifyResult>;
  isPublicPath(path: string): boolean;
}

const PUBLIC_PATHS = ["/health"];

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

    async verifyAndMatchOwner(token, expectedUserId) {
      try {
        const payload = await deps.verifyToken(token);
        if (payload.sub !== expectedUserId) {
          return { authenticated: false, error: "User mismatch" };
        }
        return { authenticated: true, userId: payload.sub };
      } catch (err) {
        return {
          authenticated: false,
          error: err instanceof Error ? err.message : "Token verification failed",
        };
      }
    },

    isPublicPath(path) {
      return PUBLIC_PATHS.includes(path);
    },
  };
}
