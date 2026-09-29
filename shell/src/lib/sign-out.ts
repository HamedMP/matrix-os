import { z } from "zod/v4";
import { closeShellCollaborationSessions } from "@/lib/collaboration";

const SIGN_OUT_TIMEOUT_MS = 10_000;

export function getSignInRedirectUrl(): string {
  const configured = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in";
  return new URL(configured, window.location.origin).toString();
}

const AppSessionClearResponseSchema = z.object({ clerkSessionRevoked: z.boolean() });

/**
 * Ends direct collaboration sessions, clears the Matrix app session and asks
 * the platform to revoke the Clerk session. Resolves whether the platform
 * confirmed that revocation; failures resolve `false` and are logged.
 */
export async function clearMatrixAppSession(): Promise<{ clerkSessionRevoked: boolean }> {
  // S06 / T034: direct collaboration sessions end with the actor's app session.
  closeShellCollaborationSessions();
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
      await response.body?.cancel();
      return { clerkSessionRevoked: false };
    }
    const parsed = AppSessionClearResponseSchema.safeParse(await response.json());
    return { clerkSessionRevoked: parsed.success && parsed.data.clerkSessionRevoked };
  } catch (error: unknown) {
    console.warn("[auth] Matrix app session clear failed", error instanceof Error ? error.name : typeof error);
    return { clerkSessionRevoked: false };
  } finally {
    window.clearTimeout(timeoutId);
  }
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
