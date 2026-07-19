const SIGN_OUT_TIMEOUT_MS = 10_000;

export function getSignInRedirectUrl(): string {
  const configured = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in";
  return new URL(configured, window.location.origin).toString();
}

export async function clearMatrixAppSession(): Promise<void> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);
  try {
    const response = await fetch("/api/auth/app-session", {
      method: "DELETE",
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("[auth] Matrix app session clear returned non-OK status", response.status);
    }
  } catch (error: unknown) {
    console.warn("[auth] Matrix app session clear failed", error instanceof Error ? error.name : typeof error);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function isTimeoutError(error: unknown): boolean {
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

export function isSignOutTimeoutError(error: unknown): boolean {
  return isTimeoutError(error);
}
