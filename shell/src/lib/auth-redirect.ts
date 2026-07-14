const DEFAULT_APP_ORIGIN = "https://app.matrix-os.com";
const SAFE_RUNTIME_SLOT = /^[a-z0-9][a-z0-9-]{0,63}$/;

function normalizeDeviceReturn(value: string | null, appOrigin: string): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  try {
    const target = new URL(value, appOrigin);
    return target.origin === appOrigin && target.pathname === "/auth/device"
      ? `${target.pathname}${target.search}${target.hash}`
      : null;
  } catch {
    return null;
  }
}

export function resolveShellAuthRedirect(
  value: string | undefined,
  configuredAppOrigin = process.env.NEXT_PUBLIC_MATRIX_APP_URL ?? DEFAULT_APP_ORIGIN,
): string {
  if (!value || value.length > 2048 || value.startsWith("//")) return "/";

  try {
    const appOrigin = new URL(configuredAppOrigin).origin;
    const isRelativePath = value.startsWith("/");
    const isConfiguredAbsoluteUrl = value.startsWith(`${appOrigin}/`);
    if (!isRelativePath && !isConfiguredAbsoluteUrl) return "/";

    const target = new URL(value, appOrigin);
    if (target.origin !== appOrigin || target.username || target.password) return "/";

    const normalizedPath = target.pathname.replace(/^\/{2,}/, "/");
    const path = /^\/sign-(?:in|up)(?:\/.*)?$/.test(normalizedPath) ? "/" : normalizedPath;
    const params = new URLSearchParams();
    const runtime = target.searchParams.get("runtime");
    if (runtime && SAFE_RUNTIME_SLOT.test(runtime)) params.set("runtime", runtime);
    const deviceReturn = normalizeDeviceReturn(target.searchParams.get("device_return"), appOrigin);
    if (deviceReturn) params.set("device_return", deviceReturn);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  } catch {
    return "/";
  }
}
