const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

export function requireSecureCollaborationPlatformBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      console.warn("[collaboration-platform] URL parse failed", "UnknownError");
    }
    throw new Error("Collaboration platform URL is unavailable");
  }
  const transportIsSecure = url.protocol === "https:"
    || (url.protocol === "http:" && LOOPBACK_HOSTNAMES.includes(url.hostname));
  if (!url.hostname || !transportIsSecure || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Collaboration platform URL is unavailable");
  }
  return url;
}
