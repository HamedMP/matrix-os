import { timingSafeStringEquals } from "../security/timing-safe.js";

/** The edge verifies its asset route token before forwarding this gateway bearer. */
export function hasPlatformAssetAuthorization(
  method: string,
  path: string,
  slug: string,
  authHeader: string | undefined,
): boolean {
  if ((method !== "GET" && method !== "HEAD") || !path.startsWith(`/apps/${slug}/assets/`)) {
    return false;
  }
  const matrixAuthToken = process.env.MATRIX_AUTH_TOKEN;
  if (!matrixAuthToken || !authHeader?.startsWith("Bearer ")) return false;
  return timingSafeStringEquals(authHeader.slice("Bearer ".length), matrixAuthToken);
}
