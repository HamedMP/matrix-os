// Origin policy for embedded surfaces (FR-062/FR-064). Bridged app launch URLs
// must be relative and resolve to the gateway origin; embedded navigation is
// restricted to an explicit origin allowlist.

export function resolveLaunchUrl(launchUrl: string, gatewayOrigin: string): string | null {
  // Must be a rooted path, never protocol-relative or scheme'd.
  if (!launchUrl.startsWith("/") || launchUrl.startsWith("//")) return null;

  let gateway: URL;
  try {
    gateway = new URL(gatewayOrigin);
  } catch {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(launchUrl, gateway);
  } catch {
    return null;
  }

  // URL resolution collapses traversal and (for special schemes) backslash
  // authority tricks; the origin check is the final arbiter.
  if (resolved.origin !== gateway.origin) return null;
  return resolved.toString();
}

export function isNavigationAllowed(targetUrl: string, allowedOrigins: string[]): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return false;

  for (const origin of allowedOrigins) {
    let allowed: URL;
    try {
      allowed = new URL(origin);
    } catch {
      continue;
    }
    if (target.origin === allowed.origin) return true;
  }
  return false;
}
