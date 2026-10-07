export type AppRuntimeNavigation = "internal" | "external" | "blocked";

/** Top-level navigation only; this is not an app sandbox or a network filter. */
export function appRuntimeNavigation(
  runtimeUrl: string,
  targetUrl: string,
  canOpenExternalUrl?: (url: string) => boolean,
): AppRuntimeNavigation {
  const runtime = parseWebUrl(runtimeUrl);
  const target = parseWebUrl(targetUrl);
  if (!runtime || !target) return "blocked";

  const appPath = runtime.pathname.match(
    /^(\/(?:vm\/[a-z0-9][a-z0-9_-]{0,63}\/)?apps\/[a-z0-9][a-z0-9_-]{0,63})(?:\/|$)/,
  )?.[1];
  if (!appPath) return "blocked";

  if (target.origin === runtime.origin) {
    return target.pathname === appPath || target.pathname.startsWith(`${appPath}/`)
      ? "internal"
      : "blocked";
  }

  // An explicit host callback can authorize reviewed web destinations. It
  // cannot authorize native schemes, same-origin system pages, or credentials.
  try {
    return canOpenExternalUrl?.(targetUrl) === true ? "external" : "blocked";
  } catch (error) {
    console.warn("[mobile] app link authorization unavailable", error instanceof Error ? error.name : "UnknownError");
    return "blocked";
  }
}

function parseWebUrl(value: string): URL | null {
  if (value.length > 4_096 || !/^https?:\/\//i.test(value)
    || /[\s\\]/.test(value) || /%(?![a-f\d]{2})/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !parsed.hostname
      || /%(?:2f|5c|25|2e)/i.test(parsed.pathname)) return null;
    return parsed;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
