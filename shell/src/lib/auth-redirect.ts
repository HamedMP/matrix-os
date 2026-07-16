import { parseRuntimeSlot } from "./runtime-slot";

const DEFAULT_APP_ORIGIN = "https://app.matrix-os.com";

function normalizeDeviceReturn(value: string | null, appOrigin: string): string | null {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    !URL.canParse(value, appOrigin)
  ) {
    return null;
  }
  const target = new URL(value, appOrigin);
  return target.origin === appOrigin && target.pathname === "/auth/device"
    ? `${target.pathname}${target.search}${target.hash}`
    : null;
}

export function resolveShellAuthRedirect(
  value: string | undefined,
  configuredAppOrigin = process.env.NEXT_PUBLIC_MATRIX_APP_URL ?? DEFAULT_APP_ORIGIN,
): string {
  if (!value || value.length > 2048 || value.startsWith("//") || !URL.canParse(configuredAppOrigin)) {
    return "/";
  }

  const appOrigin = new URL(configuredAppOrigin).origin;
  const isRelativePath = value.startsWith("/");
  const isConfiguredAbsoluteUrl = value.startsWith(`${appOrigin}/`);
  if ((!isRelativePath && !isConfiguredAbsoluteUrl) || !URL.canParse(value, appOrigin)) return "/";

  const target = new URL(value, appOrigin);
  if (target.origin !== appOrigin || target.username || target.password) return "/";

  const normalizedPath = target.pathname.replace(/^\/{2,}/, "/");
  const path = /^\/sign-(?:in|up)(?:\/.*)?$/.test(normalizedPath) ? "/" : normalizedPath;
  const params = new URLSearchParams();
  const runtime = parseRuntimeSlot(target.searchParams.get("runtime"));
  if (runtime) params.set("runtime", runtime);
  const deviceReturn = normalizeDeviceReturn(target.searchParams.get("device_return"), appOrigin);
  if (deviceReturn) params.set("device_return", deviceReturn);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
