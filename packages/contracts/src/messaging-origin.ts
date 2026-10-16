/** Build/operator authority only. Never feed request, API or selected-computer data here. */
export const DEFAULT_MESSAGING_PLATFORM_ORIGIN = "https://app.matrix-os.com";

export function resolveMessagingPlatformOrigin(
  configured?: string | null,
  allowDevelopmentOrigin = false,
): string | null {
  if (configured === undefined) return DEFAULT_MESSAGING_PLATFORM_ORIGIN;
  if (typeof configured !== "string" || configured.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(configured)) return null;
  let url: URL;
  try { url = new URL(configured); } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const development = allowDevelopmentOrigin && loopback;
  if (url.protocol !== "https:" && !(development && url.protocol === "http:")) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  // Reject normalization tricks, empty userinfo, encoded hosts and noncanonical loopbacks.
  if (configured !== url.origin && configured !== `${url.origin}/`) return null;
  return url.origin;
}

export function messagingPlatformUrl(
  path: "/slack/install" | "/whatsapp/connect",
  configured?: string | null,
  allowDevelopmentOrigin = false,
): string | null {
  const origin = resolveMessagingPlatformOrigin(configured, allowDevelopmentOrigin);
  return origin ? `${origin}${path}` : null;
}
