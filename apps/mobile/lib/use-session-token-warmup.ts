import { useAuth } from "@clerk/clerk-expo";
import { useCallback, useRef } from "react";

// A Clerk session token lives for a minute. Looking this often, and replacing
// one with less than this left, keeps the token a send picks up valid for at
// least the difference between the two.
const CHECK_EVERY_MS = 15_000;
const REPLACE_BELOW_MS = 35_000;

/** How long `token` has left, or 0 when that cannot be read from it. */
export function sessionTokenTimeLeftMs(token: string, now: number = Date.now()): number {
  try {
    const payload = token.split(".")[1] ?? "";
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof claims.exp === "number" ? Math.max(0, claims.exp * 1000 - now) : 0;
  } catch (error: unknown) {
    // Not a token this can read. Treating it as expired only costs a refresh.
    console.warn("[mobile] session token expiry unreadable", error instanceof Error ? error.name : "UnknownError");
    return 0;
  }
}

/**
 * Returns a function to call when a send looks imminent: the composer gains
 * focus, the user types.
 *
 * A send starts by asking Clerk for a session token. When the cached one has
 * expired that is a network round trip of a second or more before anything
 * reaches the computer. Replacing a token that is about to run out ahead of
 * time moves that wait to while the user is still typing.
 */
export function useSessionTokenWarmup(): () => void {
  const { getToken } = useAuth();
  const checkedAt = useRef(0);

  return useCallback(() => {
    const now = Date.now();
    if (now - checkedAt.current < CHECK_EVERY_MS) return;
    checkedAt.current = now;
    void (async () => {
      try {
        const token = await getToken();
        if (token && sessionTokenTimeLeftMs(token) >= REPLACE_BELOW_MS) return;
        await getToken({ skipCache: true });
      } catch (error: unknown) {
        checkedAt.current = 0;
        console.warn("[mobile] session token warm-up failed", error instanceof Error ? error.name : "UnknownError");
      }
    })();
  }, [getToken]);
}
