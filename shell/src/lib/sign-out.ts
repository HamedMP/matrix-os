import { closeShellCollaborationSessions } from "@/lib/collaboration";
import { clearBrowserChatNavigationCache, clearChatNavigationScopes } from "@matrix-os/ui";

const SIGN_OUT_TIMEOUT_MS = 10_000;

export function getSignInRedirectUrl(): string {
  const configured = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in";
  return new URL(configured, window.location.origin).toString();
}

export async function clearMatrixAppSession(
  getToken?: (options: { skipCache: true }) => Promise<string | null>,
): Promise<void> {
  const controller = new AbortController();
  let timeoutId: number | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        controller.abort();
        reject(new Error("Matrix app session clear timed out"));
      }, SIGN_OUT_TIMEOUT_MS);
    });
    await Promise.race([
      (async () => {
        const token = getToken ? await getToken({ skipCache: true }) : null;
        controller.signal.throwIfAborted();
        if (getToken && !token) throw new Error("Current session proof unavailable");
        const response = await fetch("/api/auth/app-session", {
          method: "DELETE",
          credentials: "include",
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          signal: controller.signal,
        });
        if (!response.ok) {
          console.warn("[auth] Matrix app session clear returned non-OK status", response.status);
          throw new Error("Matrix app session clear failed");
        }
      })(),
      deadline,
    ]);
  } catch (error: unknown) {
    console.warn("[auth] Matrix app session clear failed", error instanceof Error ? error.name : typeof error);
    throw new Error("Sign-out is temporarily unavailable. Try again.");
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
  clearChatNavigationScopes();
  clearBrowserChatNavigationCache();
  // S06 / T034: direct collaboration sessions end with the actor's app session.
  closeShellCollaborationSessions();
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export async function clerkSignOutWithTimeout(
  signOut: (options: { redirectUrl: string }) => Promise<unknown> | unknown,
  redirectUrl: string,
): Promise<void> {
  let timeoutId: number | undefined;
  try {
    await Promise.race([
      Promise.resolve(signOut({ redirectUrl })),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          const error = new Error("Clerk sign-out timed out");
          error.name = "TimeoutError";
          reject(error);
        }, SIGN_OUT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}
