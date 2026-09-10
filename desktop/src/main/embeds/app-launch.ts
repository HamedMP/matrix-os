import type { LaunchToken } from "./launch-token-cache";

export class AppLaunchError extends Error {
  constructor(readonly state: "auth-required" | "failed") {
    super("App launch unavailable");
    this.name = "AppLaunchError";
  }
}

// Only a rejected owner credential asks for login. Policy, manifest, transport,
// and server failures must not send the user into a sign-in loop.
export async function requestAppLaunchToken(
  request: () => Promise<{ status: number; body: string }>,
): Promise<LaunchToken> {
  const response = await request();
  if (response.status === 401) throw new AppLaunchError("auth-required");
  if (response.status < 200 || response.status >= 300) {
    console.warn("[embed-service] app launch rejected:", response.status);
    throw new AppLaunchError("failed");
  }
  const parsed: unknown = JSON.parse(response.body);
  if (
    parsed && typeof parsed === "object" &&
    "launchUrl" in parsed && typeof parsed.launchUrl === "string" &&
    "expiresAt" in parsed && typeof parsed.expiresAt === "number" &&
    Number.isFinite(parsed.expiresAt) && parsed.expiresAt > Date.now()
  ) return { launchUrl: parsed.launchUrl, expiresAt: parsed.expiresAt };
  throw new AppLaunchError("failed");
}
